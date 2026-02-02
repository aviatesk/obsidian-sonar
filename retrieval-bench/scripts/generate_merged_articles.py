#!/usr/bin/env python3
"""
Generate merged article corpus from chunked MIRACL dataset.

Takes an existing query-driven subset (with chunk-level corpus) and:
1. Extracts required article IDs from qrels
2. Loads complete articles from raw corpus (all chunks per article)
3. Merges chunks into complete articles
4. Converts qrels from chunk-level to article-level

Output: article-level corpus for long-document retrieval evaluation
"""

import argparse
import json
import shutil
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Set

from tqdm import tqdm


def parse_doc_id(doc_id: str) -> tuple[str, int]:
    """
    Parse document ID to extract article ID and chunk ID.

    Args:
        doc_id: Document ID in format "miracl_en_dev#1210#24" or "1210#24"

    Returns:
        Tuple of (article_id, chunk_id)
        Example: "miracl_en_dev#1210#24" -> ("miracl_en_dev#1210", 24)
        Example: "1210#24" -> ("1210", 24)
    """
    parts = doc_id.rsplit("#", 1)
    if len(parts) != 2:
        raise ValueError(f"Invalid doc_id format: {doc_id}")

    article_id = parts[0]
    try:
        chunk_id = int(parts[1])
    except ValueError:
        raise ValueError(f"Invalid chunk_id in doc_id: {doc_id}")

    return article_id, chunk_id


def extract_prefix(full_article_id: str) -> tuple[str, str]:
    """
    Extract prefix and base article ID.

    Args:
        full_article_id: Full article ID with prefix (e.g., "miracl_en_dev#1210")

    Returns:
        Tuple of (prefix, base_article_id)
        Example: "miracl_en_dev#1210" -> ("miracl_en_dev#", "1210")
    """
    # Known prefixes
    prefixes = ["miracl_en_dev#", "miracl_ja_dev#"]

    for prefix in prefixes:
        if full_article_id.startswith(prefix):
            base_article_id = full_article_id[len(prefix) :]
            return prefix, base_article_id

    # No prefix found, return empty prefix
    return "", full_article_id


def extract_article_ids_from_qrels(qrels_file: Path) -> Set[str]:
    """
    Extract unique article IDs from chunk-level qrels.

    Args:
        qrels_file: Path to qrels TSV file

    Returns:
        Set of article IDs
    """
    article_ids = set()

    with open(qrels_file, "r", encoding="utf-8") as f:
        next(f)  # Skip header
        for line in f:
            parts = line.strip().split("\t")
            if len(parts) < 3:
                continue

            corpus_id = parts[1]
            try:
                article_id, _ = parse_doc_id(corpus_id)
                article_ids.add(article_id)
            except ValueError as e:
                print(f"  Warning: {e}")
                continue

    return article_ids


def extract_article_ids_from_corpus(corpus_file: Path) -> Set[str]:
    """
    Extract unique article IDs from corpus.

    Args:
        corpus_file: Path to corpus JSONL file

    Returns:
        Set of article IDs
    """
    article_ids = set()

    with open(corpus_file, "r", encoding="utf-8") as f:
        for line in f:
            doc = json.loads(line)
            doc_id = doc["_id"]
            try:
                article_id, _ = parse_doc_id(doc_id)
                article_ids.add(article_id)
            except ValueError:
                continue

    return article_ids


def load_complete_articles(
    corpus_files: List[Path], required_article_ids: Set[str]
) -> Dict[str, Dict[str, str | int]]:
    """
    Load complete articles from raw corpus files.

    For each required article_id:
    1. Find all chunks belonging to the article
    2. Sort chunks by chunk_id
    3. Merge title + all texts with paragraph breaks

    Args:
        corpus_files: List of raw corpus JSONL files
        required_article_ids: Set of article IDs to load (with prefix)

    Returns:
        Dictionary mapping article_id (with prefix) to merged article data
    """
    # Collect all chunks per full article_id (with prefix)
    article_chunks = defaultdict(list)

    for corpus_file in corpus_files:
        print(f"\nLoading chunks from {corpus_file.name}...")

        # Determine which prefix this corpus file should use
        corpus_prefix = None
        if "miracl_en" in corpus_file.name:
            corpus_prefix = "miracl_en_dev#"
        elif "miracl_ja" in corpus_file.name:
            corpus_prefix = "miracl_ja_dev#"

        # Filter required article_ids for this corpus file
        relevant_article_ids = {
            aid for aid in required_article_ids
            if corpus_prefix and aid.startswith(corpus_prefix)
        }

        if not relevant_article_ids:
            print(f"  Skipping {corpus_file.name} (no relevant articles)")
            continue

        # Build mapping for this corpus file only
        base_to_full = {}
        for full_article_id in relevant_article_ids:
            prefix, base_article_id = extract_prefix(full_article_id)
            base_to_full[base_article_id] = full_article_id

        with open(corpus_file, "r", encoding="utf-8") as f:
            for line in tqdm(f, desc="  Reading corpus", leave=False):
                doc = json.loads(line)
                doc_id = doc["_id"]

                try:
                    article_id, chunk_id = parse_doc_id(doc_id)
                except ValueError:
                    continue

                # Check if this base article_id is required
                if article_id in base_to_full:
                    full_article_id = base_to_full[article_id]
                    article_chunks[full_article_id].append(
                        {
                            "chunk_id": chunk_id,
                            "title": doc.get("title", ""),
                            "text": doc["text"],
                        }
                    )

    # Merge chunks into complete articles
    print("\nMerging chunks into articles...")
    merged_articles = {}

    for full_article_id in tqdm(
        sorted(article_chunks.keys()), desc="  Merging articles", leave=False
    ):
        chunks = article_chunks[full_article_id]

        # Sort by chunk_id
        chunks.sort(key=lambda x: x["chunk_id"])

        # Use first chunk's title
        title = chunks[0]["title"]

        # Merge all texts with double newline separator
        merged_text = "\n\n".join(chunk["text"] for chunk in chunks)

        merged_articles[full_article_id] = {
            "title": title,
            "text": merged_text,
            "chunk_count": len(chunks),
        }

    return merged_articles


def convert_qrels_to_article_level(
    input_qrels_file: Path, output_qrels_file: Path
) -> Dict[str, Set[str]]:
    """
    Convert chunk-level qrels to article-level qrels.

    Removes duplicate entries where multiple chunks from the same article
    are relevant to the same query.

    Args:
        input_qrels_file: Path to chunk-level qrels TSV file
        output_qrels_file: Path to output article-level qrels TSV file

    Returns:
        Dictionary mapping query_id to set of article_ids
    """
    article_qrels = defaultdict(set)

    # Read chunk-level qrels and convert to article-level
    with open(input_qrels_file, "r", encoding="utf-8") as f:
        next(f)  # Skip header
        for line in f:
            parts = line.strip().split("\t")
            if len(parts) < 3:
                continue

            query_id = parts[0]
            corpus_id = parts[1]
            score = parts[2]

            # Skip non-relevant documents
            if float(score) <= 0:
                continue

            try:
                article_id, _ = parse_doc_id(corpus_id)
                article_qrels[query_id].add(article_id)
            except ValueError as e:
                print(f"  Warning: {e}")
                continue

    # Write article-level qrels
    with open(output_qrels_file, "w", encoding="utf-8") as f:
        f.write("query-id\tcorpus-id\tscore\n")
        for query_id in sorted(article_qrels.keys()):
            for article_id in sorted(article_qrels[query_id]):
                f.write(f"{query_id}\t{article_id}\t1\n")

    return article_qrels


def main():
    parser = argparse.ArgumentParser(
        description="Generate merged article corpus from chunked MIRACL dataset"
    )
    parser.add_argument(
        "--raw-corpus",
        type=str,
        required=True,
        help="Raw corpus JSONL file(s) with all chunks (comma-separated)",
    )
    parser.add_argument(
        "--subset-dir",
        type=str,
        required=True,
        help="Input subset directory with chunk-level corpus",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        help="Output directory (default: <subset-dir>_merged)",
    )

    args = parser.parse_args()

    # Parse paths
    corpus_files = [Path(f.strip()) for f in args.raw_corpus.split(",")]
    subset_dir = Path(args.subset_dir)

    # Determine output directory
    if args.output_dir:
        output_dir = Path(args.output_dir)
    else:
        output_dir = subset_dir.parent / f"{subset_dir.name}_merged"

    # Validate input files
    for corpus_file in corpus_files:
        if not corpus_file.exists():
            print(f"Error: Raw corpus file not found: {corpus_file}")
            return

    subset_qrels_file = subset_dir / "qrels.tsv"
    subset_queries_file = subset_dir / "queries.jsonl"
    subset_corpus_file = subset_dir / "corpus.jsonl"

    if not subset_qrels_file.exists():
        print(f"Error: Qrels file not found: {subset_qrels_file}")
        return

    if not subset_queries_file.exists():
        print(f"Error: Queries file not found: {subset_queries_file}")
        return

    if not subset_corpus_file.exists():
        print(f"Error: Corpus file not found: {subset_corpus_file}")
        return

    # Clean output directory
    if output_dir.exists():
        print(f"Cleaning output directory: {output_dir}")
        shutil.rmtree(output_dir)

    print(f"\n{'=' * 60}")
    print("MERGE ARTICLES FROM CHUNKED CORPUS")
    print(f"{'=' * 60}")
    print(f"Input subset: {subset_dir}")
    print(f"Raw corpus files: {len(corpus_files)}")
    for f in corpus_files:
        print(f"  - {f}")
    print(f"Output directory: {output_dir}")

    # Step 1: Extract required article IDs
    print(f"\n{'=' * 60}")
    print("STEP 1: Extract required article IDs")
    print(f"{'=' * 60}")
    qrels_article_ids = extract_article_ids_from_qrels(subset_qrels_file)
    print(f"Articles from qrels (relevant): {len(qrels_article_ids)}")

    corpus_article_ids = extract_article_ids_from_corpus(subset_corpus_file)
    print(f"Articles from corpus (distractors): {len(corpus_article_ids)}")
    required_article_ids = qrels_article_ids | corpus_article_ids
    print(f"Combined unique articles: {len(required_article_ids)}")

    # Step 2: Load complete articles from raw corpus
    print(f"\n{'=' * 60}")
    print("STEP 2: Load complete articles from raw corpus")
    print(f"{'=' * 60}")
    merged_articles = load_complete_articles(corpus_files, required_article_ids)
    print(f"Loaded articles: {len(merged_articles)}")

    # Check for missing articles
    missing_articles = required_article_ids - set(merged_articles.keys())
    if missing_articles:
        print(f"Warning: {len(missing_articles)} articles not found in raw corpus")
        for article_id in sorted(missing_articles)[:5]:
            print(f"  - {article_id}")
        if len(missing_articles) > 5:
            print(f"  ... and {len(missing_articles) - 5} more")

    # Print statistics
    chunk_counts = [int(article["chunk_count"]) for article in merged_articles.values()]
    avg_chunks = sum(chunk_counts) / len(chunk_counts) if chunk_counts else 0
    print("\nArticle statistics:")
    print(f"  Total articles: {len(merged_articles)}")
    print(f"  Average chunks per article: {avg_chunks:.1f}")
    print(f"  Min chunks: {min(chunk_counts) if chunk_counts else 0}")
    print(f"  Max chunks: {max(chunk_counts) if chunk_counts else 0}")

    # Step 3: Convert qrels to article-level
    print(f"\n{'=' * 60}")
    print("STEP 3: Convert qrels to article-level")
    print(f"{'=' * 60}")
    output_dir.mkdir(parents=True, exist_ok=True)
    output_qrels_file = output_dir / "qrels.tsv"
    article_qrels = convert_qrels_to_article_level(
        subset_qrels_file, output_qrels_file
    )
    print(f"Converted qrels saved: {output_qrels_file}")
    print(f"  Queries: {len(article_qrels)}")
    print(
        f"  Total relevance judgments: {sum(len(v) for v in article_qrels.values())}"
    )

    # Step 4: Write merged corpus
    print(f"\n{'=' * 60}")
    print("STEP 4: Write merged corpus")
    print(f"{'=' * 60}")
    output_corpus_file = output_dir / "corpus.jsonl"
    with open(output_corpus_file, "w", encoding="utf-8") as f:
        for article_id in tqdm(
            sorted(merged_articles.keys()), desc="Writing corpus", leave=False
        ):
            article = merged_articles[article_id]
            corpus_entry = {
                "_id": article_id,
                "title": article["title"],
                "text": article["text"],
            }
            f.write(json.dumps(corpus_entry, ensure_ascii=False) + "\n")
    print(f"Merged corpus saved: {output_corpus_file}")

    # Step 5: Copy queries file
    print(f"\n{'=' * 60}")
    print("STEP 5: Copy queries file")
    print(f"{'=' * 60}")
    output_queries_file = output_dir / "queries.jsonl"
    shutil.copy(subset_queries_file, output_queries_file)
    print(f"Queries copied: {output_queries_file}")

    # Step 6: Write metadata
    print(f"\n{'=' * 60}")
    print("STEP 6: Write metadata")
    print(f"{'=' * 60}")
    metadata = {
        "type": "merged_articles",
        "source_subset": str(subset_dir),
        "raw_corpus_files": [str(f) for f in corpus_files],
        "statistics": {
            "articles": len(merged_articles),
            "queries": len(article_qrels),
            "relevance_judgments": sum(len(v) for v in article_qrels.values()),
            "avg_chunks_per_article": avg_chunks,
        },
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    metadata_file = output_dir / "metadata.json"
    with open(metadata_file, "w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)
    print(f"Metadata saved: {metadata_file}")

    # Summary
    print(f"\n{'=' * 60}")
    print("SUMMARY")
    print(f"{'=' * 60}")
    print(f"Output directory: {output_dir}")
    print(f"  corpus.jsonl: {len(merged_articles)} articles")
    print(f"  queries.jsonl: {len(article_qrels)} queries")
    print(
        f"  qrels.tsv: {sum(len(v) for v in article_qrels.values())} judgments"
    )
    print("\nNext steps:")
    print("  1. Generate vault:")
    print(
        f"     uv run scripts/generate_vault.py --corpus {output_corpus_file} "
        f"--output bench/vaults/{output_dir.name}"
    )
    print("  2. Run benchmarks with the merged corpus")


if __name__ == "__main__":
    main()
