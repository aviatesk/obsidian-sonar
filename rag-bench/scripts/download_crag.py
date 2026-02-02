#!/usr/bin/env python3
"""
Download and preprocess CRAG dataset (Task 3) for Sonar RAG benchmark.

Downloads from GitHub (facebookresearch/CRAG), merges split archives,
converts HTML pages to plain text, and outputs processed data to jsonl format.

Task 3 provides up to 50 pages per query.
"""

import argparse
import json
import random
import re
import subprocess
import urllib.request
from html import unescape
from pathlib import Path

from tqdm import tqdm

CRAG_TASK_3_BASE_URL = (
    "https://github.com/facebookresearch/CRAG/raw/main/data/"
    "crag_task_3_dev_v4.tar.bz2"
)
CRAG_TASK_3_PARTS = 4


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


def download_file(url: str, dest: Path) -> None:
    """Download a file with progress bar."""
    print(f"Downloading {url}...")

    with urllib.request.urlopen(url) as response:
        total_size = int(response.headers.get("Content-Length", 0))

        with open(dest, "wb") as f:
            with tqdm(total=total_size, unit="B", unit_scale=True) as pbar:
                while True:
                    chunk = response.read(8192)
                    if not chunk:
                        break
                    f.write(chunk)
                    pbar.update(len(chunk))


def download_task3_parts(output_dir: Path) -> Path:
    """Download and merge Task 3 archive parts."""
    merged_file = output_dir / "crag_task_3_dev_v4.tar.bz2"

    if merged_file.exists():
        print(f"Using cached archive: {merged_file}")
        return merged_file

    # Download all parts
    part_files: list[Path] = []
    for i in range(1, CRAG_TASK_3_PARTS + 1):
        part_url = f"{CRAG_TASK_3_BASE_URL}.part{i}"
        part_file = output_dir / f"crag_task_3_dev_v4.tar.bz2.part{i}"

        if not part_file.exists():
            download_file(part_url, part_file)
        else:
            print(f"Using cached part: {part_file}")

        part_files.append(part_file)

    # Merge parts
    print("Merging archive parts...")
    with open(merged_file, "wb") as outf:
        for part_file in part_files:
            with open(part_file, "rb") as inf:
                while True:
                    chunk = inf.read(8192)
                    if not chunk:
                        break
                    outf.write(chunk)

    print(f"Merged archive: {merged_file}")
    return merged_file


def extract_and_load_jsonl(archive_path: Path, output_dir: Path) -> list[dict]:
    """Extract tar.bz2 using system tar and load all JSONL files."""
    extract_dir = output_dir / "extracted"

    # Check if already extracted
    if extract_dir.exists():
        jsonl_files = list(extract_dir.rglob("*.jsonl"))
        if jsonl_files:
            print(f"Using cached extraction: {extract_dir}")
            return load_jsonl_files(jsonl_files)

    # Extract using system tar (much faster than Python tarfile)
    print(f"Extracting {archive_path} using system tar...")
    extract_dir.mkdir(parents=True, exist_ok=True)

    subprocess.run(
        ["tar", "xjf", str(archive_path), "-C", str(extract_dir)],
        check=True,
    )

    jsonl_files = list(extract_dir.rglob("*.jsonl"))
    print(f"Found {len(jsonl_files)} JSONL files")

    return load_jsonl_files(jsonl_files)


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


def download_and_process(
    output_dir: Path,
    sample_size: int | None = None,
    seed: int = 42,
) -> None:
    """
    Download CRAG Task 3 dataset and process to jsonl format.

    Args:
        output_dir: Directory to save processed data
        sample_size: If set, only process this many samples
        seed: Random seed for sampling
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    # Download and merge archive parts
    archive_path = download_task3_parts(output_dir)

    # Extract and load JSONL
    items = extract_and_load_jsonl(archive_path, output_dir)
    print(f"Loaded {len(items)} samples")

    # Sample if requested
    if sample_size and sample_size < len(items):
        random.seed(seed)
        items = random.sample(items, sample_size)
        print(f"Sampled {sample_size} samples")

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
        description="Download and preprocess CRAG Task 3 dataset (50 pages per query)"
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="datasets/crag",
        help="Output directory for processed data",
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

    output_dir = Path(args.output_dir)
    if not output_dir.is_absolute():
        # Relative to script location
        script_dir = Path(__file__).parent.parent
        output_dir = script_dir / output_dir

    download_and_process(
        output_dir=output_dir,
        sample_size=args.sample_size,
        seed=args.seed,
    )


if __name__ == "__main__":
    main()
