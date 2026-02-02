#!/usr/bin/env python3
"""
Build unified corpus from CRAG dataset for Benchmark B.

This script:
1. Reads CRAG data.jsonl
2. Samples N questions
3. Merges all pages from sampled questions (deduplicated by URL)
4. Outputs corpus.jsonl and queries.jsonl

Usage:
    uv run scripts/build_crag_unified.py --sample-size 100
"""

import argparse
import json
import random
from pathlib import Path

from tqdm import tqdm


def build_unified_corpus(
    input_path: Path,
    output_dir: Path,
    sample_size: int,
    seed: int,
) -> None:
    """Build unified corpus from CRAG samples."""
    output_dir.mkdir(parents=True, exist_ok=True)

    # Load all samples
    print(f"Loading samples from {input_path}...")
    with open(input_path) as f:
        all_samples = [json.loads(line) for line in f]
    print(f"Loaded {len(all_samples)} total samples")

    # Sample questions
    random.seed(seed)
    if sample_size < len(all_samples):
        samples = random.sample(all_samples, sample_size)
        print(f"Sampled {sample_size} questions")
    else:
        samples = all_samples
        print(f"Using all {len(samples)} questions")

    # Build unified corpus (deduplicate by URL)
    url_to_page: dict[str, dict[str, str]] = {}
    for sample in tqdm(samples, desc="Building corpus"):
        for page in sample.get("pages", []):
            url = page.get("url", "")
            if url and url not in url_to_page:
                url_to_page[url] = {
                    "doc_id": f"page_{len(url_to_page)}",
                    "url": url,
                    "title": page.get("title", ""),
                    "content": page.get("content", ""),
                }

    corpus = list(url_to_page.values())
    print(f"Built corpus with {len(corpus)} unique pages")

    # Build queries
    queries = []
    for sample in samples:
        queries.append({
            "id": sample.get("question_id", ""),
            "question": sample.get("question", ""),
            "answer": sample.get("answer", ""),
            "alt_answers": sample.get("alt_answers", []),
            "domain": sample.get("domain", ""),
            "question_type": sample.get("question_type", ""),
        })

    # Calculate corpus stats
    content_lengths = [len(p["content"]) for p in corpus]
    avg_length = sum(content_lengths) / len(content_lengths) if corpus else 0

    # Write corpus
    corpus_path = output_dir / "corpus.jsonl"
    with open(corpus_path, "w", encoding="utf-8") as f:
        for doc in corpus:
            f.write(json.dumps(doc, ensure_ascii=False) + "\n")
    print(f"Wrote corpus to {corpus_path}")

    # Write queries
    queries_path = output_dir / "queries.jsonl"
    with open(queries_path, "w", encoding="utf-8") as f:
        for q in queries:
            f.write(json.dumps(q, ensure_ascii=False) + "\n")
    print(f"Wrote queries to {queries_path}")

    # Write metadata
    metadata = {
        "source": "CRAG dataset (unified)",
        "sample_size": len(samples),
        "corpus_size": len(corpus),
        "seed": seed,
        "avg_content_length": round(avg_length),
        "domain_distribution": {},
        "question_type_distribution": {},
    }

    for q in queries:
        domain = q.get("domain", "unknown")
        qtype = q.get("question_type", "unknown")
        metadata["domain_distribution"][domain] = (
            metadata["domain_distribution"].get(domain, 0) + 1
        )
        metadata["question_type_distribution"][qtype] = (
            metadata["question_type_distribution"].get(qtype, 0) + 1
        )

    metadata_path = output_dir / "metadata.json"
    with open(metadata_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2, ensure_ascii=False)
    print(f"Wrote metadata to {metadata_path}")

    # Summary
    print("\n=== Summary ===")
    print(f"Questions: {len(queries)}")
    print(f"Corpus size: {len(corpus)} pages")
    print(f"Avg content length: {avg_length:.0f} chars")
    print(f"Domain distribution: {metadata['domain_distribution']}")
    print(f"Question type distribution: {metadata['question_type_distribution']}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build unified corpus from CRAG dataset"
    )
    parser.add_argument(
        "--input",
        type=str,
        default="datasets/crag/data.jsonl",
        help="Input CRAG data file",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="datasets/crag-unified",
        help="Output directory",
    )
    parser.add_argument(
        "--sample-size",
        type=int,
        default=100,
        help="Number of questions to sample",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed",
    )
    args = parser.parse_args()

    script_dir = Path(__file__).parent.parent
    input_path = script_dir / args.input
    output_dir = script_dir / args.output_dir

    if not input_path.exists():
        print(f"Error: Input file not found: {input_path}")
        print("Run download_crag.py first to get the CRAG dataset.")
        return

    build_unified_corpus(
        input_path=input_path,
        output_dir=output_dir,
        sample_size=args.sample_size,
        seed=args.seed,
    )


if __name__ == "__main__":
    main()
