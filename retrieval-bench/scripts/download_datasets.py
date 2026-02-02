#!/usr/bin/env python3
"""
Download and preprocess datasets for retrieval benchmarking using ir-datasets.

Supports:
- MIRACL (Japanese/English)
- SCIDOCS (via BEIR)

Output format: BEIR-compatible (corpus.jsonl, queries.jsonl, qrels.tsv)
"""

import argparse
import json
import shutil
from pathlib import Path
from typing import List, Optional

import ir_datasets
from tqdm import tqdm


def download_miracl(
    language: str, output_dir: Path, splits: Optional[List[str]] = None
) -> None:
    """
    Download MIRACL dataset for specified language using ir-datasets.

    Args:
        language: Language code (ja, en, etc.)
        output_dir: Output directory
        splits: Dataset splits to download (default: ['dev'])
    """
    if splits is None:
        splits = ["dev"]

    print(f"Downloading MIRACL-{language}...")

    for split in splits:
        print(f"\n  Loading {split} split...")

        # Load dataset via ir-datasets
        dataset_id = f"miracl/{language}/{split}"
        try:
            dataset = ir_datasets.load(dataset_id)
        except Exception as e:
            print(f"  Error loading {dataset_id}: {e}")
            continue

        # Write corpus
        corpus_file = output_dir / f"miracl_{language}_corpus_{split}.jsonl"
        print(f"  Writing corpus to {corpus_file}...")

        doc_ids = set()
        with open(corpus_file, "w", encoding="utf-8") as f:
            for doc in tqdm(dataset.docs_iter(), desc="  Corpus"):
                if doc.doc_id not in doc_ids:
                    doc_ids.add(doc.doc_id)
                    corpus_entry = {
                        "_id": doc.doc_id,
                        "title": doc.title,
                        "text": doc.text,
                    }
                    f.write(json.dumps(corpus_entry, ensure_ascii=False) + "\n")

        print(f"  Corpus saved: {corpus_file} ({len(doc_ids)} docs)")

        # Write queries
        queries_file = output_dir / f"miracl_{language}_queries_{split}.jsonl"
        print(f"  Writing queries to {queries_file}...")

        with open(queries_file, "w", encoding="utf-8") as f:
            query_count = 0
            for query in tqdm(dataset.queries_iter(), desc="  Queries"):
                query_entry = {"_id": query.query_id, "text": query.text}
                f.write(json.dumps(query_entry, ensure_ascii=False) + "\n")
                query_count += 1

        print(f"  Queries saved: {queries_file} ({query_count} queries)")

        # Write qrels
        qrels_file = output_dir / f"miracl_{language}_qrels_{split}.tsv"
        print(f"  Writing qrels to {qrels_file}...")

        with open(qrels_file, "w", encoding="utf-8") as f:
            f.write("query-id\tcorpus-id\tscore\n")
            qrel_count = 0
            for qrel in tqdm(dataset.qrels_iter(), desc="  Qrels"):
                f.write(f"{qrel.query_id}\t{qrel.doc_id}\t{qrel.relevance}\n")
                qrel_count += 1

        print(f"  Qrels saved: {qrels_file} ({qrel_count} judgments)")


def download_scidocs(output_dir: Path) -> None:
    """
    Download SCIDOCS dataset via ir-datasets (BEIR).

    Args:
        output_dir: Output directory
    """
    print("Downloading SCIDOCS...")

    # Load SCIDOCS via ir-datasets
    dataset_id = "beir/scidocs"
    try:
        dataset = ir_datasets.load(dataset_id)
    except Exception as e:
        print(f"  Error loading {dataset_id}: {e}")
        print("  Note: SCIDOCS may require manual download.")
        print("  See: https://ir-datasets.com/beir.html#beir/scidocs")
        return

    # Write corpus
    corpus_file = output_dir / "scidocs_corpus.jsonl"
    print(f"  Writing corpus to {corpus_file}...")

    doc_ids = set()
    with open(corpus_file, "w", encoding="utf-8") as f:
        for doc in tqdm(dataset.docs_iter(), desc="  Corpus"):
            if doc.doc_id not in doc_ids:
                doc_ids.add(doc.doc_id)
                corpus_entry = {
                    "_id": doc.doc_id,
                    "title": doc.title if hasattr(doc, "title") else "",
                    "text": doc.text,
                }
                f.write(json.dumps(corpus_entry, ensure_ascii=False) + "\n")

    print(f"  Corpus saved: {corpus_file} ({len(doc_ids)} docs)")

    # Write queries
    queries_file = output_dir / "scidocs_queries.jsonl"
    print(f"  Writing queries to {queries_file}...")

    with open(queries_file, "w", encoding="utf-8") as f:
        query_count = 0
        for query in tqdm(dataset.queries_iter(), desc="  Queries"):
            query_entry = {"_id": query.query_id, "text": query.text}
            f.write(json.dumps(query_entry, ensure_ascii=False) + "\n")
            query_count += 1

    print(f"  Queries saved: {queries_file} ({query_count} queries)")

    # Write qrels
    qrels_file = output_dir / "scidocs_qrels.tsv"
    print(f"  Writing qrels to {qrels_file}...")

    with open(qrels_file, "w", encoding="utf-8") as f:
        f.write("query-id\tcorpus-id\tscore\n")
        qrel_count = 0
        for qrel in tqdm(dataset.qrels_iter(), desc="  Qrels"):
            f.write(f"{qrel.query_id}\t{qrel.doc_id}\t{qrel.relevance}\n")
            qrel_count += 1

    print(f"  Qrels saved: {qrels_file} ({qrel_count} judgments)")


def list_available_datasets():
    """List all available MIRACL datasets."""
    print("\nAvailable MIRACL datasets:")
    print(
        "  Languages: ar, bn, en, es, fa, fi, fr, hi, id, ja, ko, ru, "
        "sw, te, th, zh, de, yo"
    )
    print("  Splits: train, dev, test (availability varies by language)")
    print("\nAvailable BEIR datasets:")
    print("  scidocs, nfcorpus, fiqa, trec-covid, and many more")
    print("  See: https://ir-datasets.com/beir.html")


def main():
    parser = argparse.ArgumentParser(
        description="Download retrieval benchmark datasets using ir-datasets"
    )
    parser.add_argument(
        "--datasets",
        type=str,
        default="miracl_ja,miracl_en,scidocs",
        help="Comma-separated dataset names (default: miracl_ja,miracl_en,scidocs)",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="./datasets/raw",
        help="Output directory for raw datasets (default: ./datasets/raw)",
    )
    parser.add_argument(
        "--splits",
        type=str,
        default="dev",
        help=(
            "MIRACL splits to download (comma-separated: dev,train,test) (default: dev)"
        ),
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List available datasets and exit",
    )

    args = parser.parse_args()

    if args.list:
        list_available_datasets()
        return

    # Parse arguments
    datasets = [d.strip() for d in args.datasets.split(",")]
    output_dir = Path(args.output_dir)
    splits = [s.strip() for s in args.splits.split(",")]

    # Clean output directory
    if output_dir.exists():
        print(f"Cleaning output directory: {output_dir}")
        shutil.rmtree(output_dir)

    # Create output directory
    output_dir.mkdir(parents=True, exist_ok=True)

    # Download datasets
    for dataset_name in datasets:
        print(f"\n{'=' * 60}")
        if dataset_name == "miracl_ja":
            download_miracl("ja", output_dir, splits)
        elif dataset_name == "miracl_en":
            download_miracl("en", output_dir, splits)
        elif dataset_name == "scidocs":
            download_scidocs(output_dir)
        else:
            print(f"Unknown dataset: {dataset_name}")
            print("Use --list to see available datasets")

    print(f"\n{'=' * 60}")
    print("Download complete!")
    print(f"Output directory: {output_dir.absolute()}")


if __name__ == "__main__":
    main()
