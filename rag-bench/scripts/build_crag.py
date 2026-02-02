#!/usr/bin/env python3
"""
Build processed CRAG dataset for Benchmark A (per-question RAG evaluation).

This script:
1. Reads raw CRAG data from datasets/crag-raw
2. Converts HTML pages to plain text
3. Outputs processed data.jsonl to datasets/crag

Run download_crag.py first to get the raw data.

Usage:
    uv run scripts/build_crag.py
    uv run scripts/build_crag.py --sample-size 100
"""

import argparse
import json
import random
import re
from html import unescape
from pathlib import Path

from tqdm import tqdm


def html_to_text(html: str) -> str:
    """
    Convert HTML to plain text.

    Simple regex-based conversion that:
    - Removes script and style tags
    - Converts common HTML entities
    - Strips remaining tags
    - Normalizes whitespace
    """
    if not html:
        return ""

    text = html

    # Remove script and style elements
    text = re.sub(r"<script[^>]*>.*?</script>", "", text, flags=re.DOTALL | re.I)
    text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL | re.I)

    # Remove HTML comments
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)

    # Convert common block elements to newlines
    text = re.sub(r"<(?:p|div|br|h[1-6]|li|tr)[^>]*>", "\n", text, flags=re.I)

    # Strip remaining tags
    text = re.sub(r"<[^>]+>", "", text)

    # Decode HTML entities
    text = unescape(text)

    # Normalize whitespace
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n", "\n\n", text)
    text = text.strip()

    return text


def process_search_results(search_results: list) -> list:
    """
    Process search_results field from CRAG dataset.

    Each result contains:
    - page_name: title
    - page_url: URL
    - page_snippet: brief summary
    - page_result: full HTML content
    - page_last_modified: timestamp
    """
    pages = []
    for i, result in enumerate(search_results):
        if not isinstance(result, dict):
            continue

        title = result.get("page_name", f"Page {i}")
        html_content = result.get("page_result", "")
        snippet = result.get("page_snippet", "")

        # Convert HTML to plain text
        content = html_to_text(html_content)

        # Fall back to snippet if content is empty
        if not content and snippet:
            content = snippet

        if content:
            pages.append(
                {
                    "page_id": i,
                    "title": title,
                    "content": content,
                    "url": result.get("page_url", ""),
                }
            )

    return pages


def sanitize_json_string(s: str) -> str:
    """Remove invalid control characters from JSON string."""
    # JSON allows: \t (0x09), \n (0x0A), \r (0x0D)
    # Remove other control characters (0x00-0x1F except above)
    result = []
    for ch in s:
        code = ord(ch)
        if code < 0x20 and code not in (0x09, 0x0A, 0x0D):
            continue  # Skip invalid control character
        result.append(ch)
    return "".join(result)


def load_jsonl_files(jsonl_files: list[Path]) -> list[dict]:
    """Load items from JSONL files."""
    items: list[dict] = []
    errors = 0

    for jsonl_file in tqdm(jsonl_files, desc="Loading JSONL files"):
        with open(jsonl_file, encoding="utf-8") as f:
            for line_num, line in enumerate(f, 1):
                if not line.strip():
                    continue
                try:
                    items.append(json.loads(line))
                except json.JSONDecodeError:
                    # Try with sanitized input
                    try:
                        sanitized = sanitize_json_string(line)
                        items.append(json.loads(sanitized))
                    except json.JSONDecodeError as e:
                        errors += 1
                        if errors <= 5:
                            print(
                                f"  Warning: JSON error in "
                                f"{jsonl_file.name}:{line_num}: {e}"
                            )

    if errors > 0:
        print(f"  Skipped {errors} lines with JSON errors")

    return items


def build_crag(
    input_dir: Path,
    output_dir: Path,
    sample_size: int | None = None,
    seed: int = 42,
) -> None:
    """
    Build processed CRAG dataset from raw data.

    Args:
        input_dir: Directory containing raw CRAG data (datasets/crag-raw)
        output_dir: Directory to save processed data (datasets/crag)
        sample_size: If set, only process this many samples
        seed: Random seed for sampling
    """
    # Find extracted JSONL files
    extract_dir = input_dir / "extracted"
    if not extract_dir.exists():
        print(f"Error: Extracted data not found at {extract_dir}")
        print("Run download_crag.py first to download and extract the data.")
        return

    jsonl_files = list(extract_dir.rglob("*.jsonl"))
    if not jsonl_files:
        print(f"Error: No JSONL files found in {extract_dir}")
        return

    print(f"Found {len(jsonl_files)} JSONL files in {extract_dir}")

    # Load raw data
    items = load_jsonl_files(jsonl_files)
    print(f"Loaded {len(items)} samples")

    # Sample if requested
    if sample_size and sample_size < len(items):
        random.seed(seed)
        items = random.sample(items, sample_size)
        print(f"Sampled {sample_size} samples")

    # Create output directory
    output_dir.mkdir(parents=True, exist_ok=True)

    output_file = output_dir / "data.jsonl"
    processed_count = 0
    skipped_count = 0

    with open(output_file, "w", encoding="utf-8") as f:
        for item in tqdm(items, desc="Processing"):
            question_id = item.get("interaction_id", f"q_{processed_count}")
            question = item.get("query", "")
            answer = item.get("answer", "")
            alt_answers = item.get("alt_ans", [])
            domain = item.get("domain", "")
            question_type = item.get("question_type", "")

            # Process search results (up to 50 pages in Task 3)
            search_results = item.get("search_results", [])
            pages = process_search_results(search_results)

            if not pages:
                skipped_count += 1
                continue

            # Write processed record
            record = {
                "question_id": question_id,
                "question": question,
                "answer": answer,
                "alt_answers": alt_answers if alt_answers else [],
                "domain": domain,
                "question_type": question_type,
                "pages": pages,
            }

            f.write(json.dumps(record, ensure_ascii=False) + "\n")
            processed_count += 1

    print(f"Processed {processed_count} samples, skipped {skipped_count}")
    print(f"Output saved to {output_file}")

    # Save metadata
    metadata = {
        "total_samples": processed_count,
        "skipped_samples": skipped_count,
        "sample_size": sample_size,
        "seed": seed,
        "source": "facebookresearch/CRAG (Task 3)",
        "pages_per_query": "up to 50",
    }
    metadata_file = output_dir / "metadata.json"
    with open(metadata_file, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)
    print(f"Metadata saved to {metadata_file}")


def main():
    parser = argparse.ArgumentParser(
        description="Build processed CRAG dataset for Benchmark A"
    )
    parser.add_argument(
        "--input-dir",
        type=str,
        default="datasets/crag-raw",
        help="Input directory containing raw CRAG data (default: datasets/crag-raw)",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="datasets/crag",
        help="Output directory for processed data (default: datasets/crag)",
    )
    parser.add_argument(
        "--sample-size",
        type=int,
        default=None,
        help="Number of samples to process (default: all)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for sampling",
    )

    args = parser.parse_args()

    script_dir = Path(__file__).parent.parent

    input_dir = Path(args.input_dir)
    if not input_dir.is_absolute():
        input_dir = script_dir / input_dir

    output_dir = Path(args.output_dir)
    if not output_dir.is_absolute():
        output_dir = script_dir / output_dir

    build_crag(
        input_dir=input_dir,
        output_dir=output_dir,
        sample_size=args.sample_size,
        seed=args.seed,
    )


if __name__ == "__main__":
    main()
