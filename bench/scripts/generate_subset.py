#!/usr/bin/env python3
"""
Generate query-driven candidate pool subset for efficient benchmarking.

Strategy:
1. Load one or more datasets (e.g., miracl_ja, miracl_en)
2. Sample N queries (stratified across datasets if multiple)
3. For each query, retrieve:
   - BM25 Top M candidates
   - All relevant docs from qrels
4. Create subset corpus from union of all candidates
5. Output in BEIR format + Obsidian vault format

Supports mixed-language evaluation (e.g., Japanese + English corpus).
"""

import argparse
import json
import random
import shutil
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Set, Tuple

from rank_bm25 import BM25Okapi
from tqdm import tqdm


def count_lines(file_path: Path) -> int:
    """Count lines in a file efficiently."""
    with open(file_path, "rb") as f:
        return sum(1 for _ in f)


def load_corpus(
    corpus_file: Path, max_docs: int = None, required_doc_ids: Set[str] = None
) -> Dict[str, Dict[str, str]]:
    """
    Load corpus from JSONL file.

    Args:
        corpus_file: Path to corpus JSONL file
        max_docs: Maximum number of documents to load (default: None = load all)
        required_doc_ids: Set of document IDs that must be included (e.g., from qrels)

    Returns:
        Dictionary of documents
    """
    corpus = {}
    required_doc_ids = required_doc_ids or set()
    remaining_required = required_doc_ids.copy()
    regular_count = 0

    # Count total lines for progress bar
    total_lines = count_lines(corpus_file)

    with open(corpus_file, "r", encoding="utf-8") as f:
        for line in tqdm(
            f,
            desc="Loading corpus",
            total=total_lines,
            unit=" docs",
            leave=False,
        ):
            doc = json.loads(line)
            doc_id = doc["_id"]

            # Always include required docs (from qrels)
            if doc_id in required_doc_ids:
                corpus[doc_id] = {
                    "title": doc.get("title", ""),
                    "text": doc["text"],
                }
                remaining_required.discard(doc_id)
                continue

            # Regular docs: respect max_docs limit
            if max_docs and regular_count >= max_docs:
                # Continue scanning for required docs
                if not remaining_required:
                    break
                continue

            corpus[doc_id] = {
                "title": doc.get("title", ""),
                "text": doc["text"],
            }
            regular_count += 1

    if remaining_required:
        tqdm.write(
            f"  Warning: {len(remaining_required)} required docs not found in corpus"
        )

    tqdm.write(
        f"  Loaded: {regular_count} regular docs + {len(required_doc_ids) - len(remaining_required)} required docs"
    )
    return corpus


def load_queries(queries_file: Path) -> Dict[str, str]:
    """Load queries from JSONL file."""
    queries = {}
    with open(queries_file, "r", encoding="utf-8") as f:
        for line in f:
            query = json.loads(line)
            queries[query["_id"]] = query["text"]
    return queries


def load_qrels(qrels_file: Path) -> Dict[str, Set[str]]:
    """Load qrels from TSV file."""
    qrels = defaultdict(set)
    with open(qrels_file, "r", encoding="utf-8") as f:
        next(f)  # Skip header
        for line in f:
            parts = line.strip().split("\t")
            if len(parts) < 3:
                continue
            query_id, doc_id, score = parts[0], parts[1], parts[2]
            # Include only relevant docs (score > 0)
            if float(score) > 0:
                qrels[query_id].add(doc_id)
    return qrels


def sample_queries(
    queries: Dict[str, str], qrels: Dict[str, Set[str]], n: int, seed: int = 42
) -> List[str]:
    """
    Sample queries with at least one relevant document.

    Args:
        queries: Query dict
        qrels: Qrels dict
        n: Number of queries to sample
        seed: Random seed

    Returns:
        List of sampled query IDs
    """
    random.seed(seed)

    # Filter queries with at least one relevant doc
    valid_queries = [qid for qid in queries.keys() if qid in qrels and qrels[qid]]

    if len(valid_queries) <= n:
        return valid_queries

    return random.sample(valid_queries, n)


def tokenize_simple(text: str) -> List[str]:
    """Simple whitespace tokenization."""
    return text.lower().split()


def build_bm25_index(corpus: Dict[str, Dict[str, str]]) -> Tuple[BM25Okapi, List[str]]:
    """
    Build BM25 index from corpus.

    Args:
        corpus: Corpus dict

    Returns:
        Tuple of (BM25 index, list of doc IDs)
    """
    doc_ids = list(corpus.keys())
    tokenized_corpus = [
        tokenize_simple(corpus[doc_id]["title"] + " " + corpus[doc_id]["text"])
        for doc_id in tqdm(doc_ids, desc="Tokenizing corpus for BM25", leave=False)
    ]

    bm25 = BM25Okapi(tokenized_corpus)

    return bm25, doc_ids


def bm25_retrieve(
    query: str, bm25: BM25Okapi, doc_ids: List[str], top_m: int
) -> List[Tuple[str, float]]:
    """
    Retrieve top M documents using BM25.

    Args:
        query: Query text
        bm25: Pre-built BM25 index
        doc_ids: List of document IDs (same order as BM25 index)
        top_m: Number of top documents to retrieve

    Returns:
        List of (doc_id, score) tuples
    """
    # Retrieve
    tokenized_query = tokenize_simple(query)
    scores = bm25.get_scores(tokenized_query)

    # Get top M
    top_indices = scores.argsort()[-top_m:][::-1]
    results = [(doc_ids[i], scores[i]) for i in top_indices]

    return results


def main():
    parser = argparse.ArgumentParser(
        description="Generate query-driven candidate pool subset"
    )
    parser.add_argument(
        "--corpus",
        type=str,
        required=True,
        help="Corpus JSONL file(s) (comma-separated for multiple datasets)",
    )
    parser.add_argument(
        "--queries",
        type=str,
        required=True,
        help="Queries JSONL file(s) (comma-separated for multiple datasets)",
    )
    parser.add_argument(
        "--qrels",
        type=str,
        required=True,
        help="Qrels TSV file(s) (comma-separated for multiple datasets)",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        help="Output directory for subset (auto-generated if not specified)",
    )
    parser.add_argument(
        "--n-queries",
        type=int,
        default=200,
        help="Number of queries to sample (default: 200)",
    )
    parser.add_argument(
        "--bm25-top-m",
        type=int,
        default=200,
        help="Number of BM25 candidates per query (default: 200)",
    )
    parser.add_argument(
        "--max-corpus-docs",
        type=int,
        default=700000,
        help="Maximum number of corpus documents to load per dataset (default: 700000)",
    )
    parser.add_argument(
        "--seed", type=int, default=42, help="Random seed (default: 42)"
    )

    args = parser.parse_args()

    # Step 1: Parse file paths
    corpus_files = [Path(f.strip()) for f in args.corpus.split(",")]
    queries_files = [Path(f.strip()) for f in args.queries.split(",")]
    qrels_files = [Path(f.strip()) for f in args.qrels.split(",")]

    # Validate file counts match
    if not (len(corpus_files) == len(queries_files) == len(qrels_files)):
        print("Error: Number of corpus, queries, and qrels files must match")
        print(f"  Corpus files: {len(corpus_files)}")
        print(f"  Queries files: {len(queries_files)}")
        print(f"  Qrels files: {len(qrels_files)}")
        return

    # Step 2: Determine output directory
    if args.output_dir:
        output_dir = Path(args.output_dir)
    else:
        # Auto-generate from file names
        if len(corpus_files) == 1:
            # Single dataset: use corpus file stem
            base_name = corpus_files[0].stem.replace("_corpus", "").replace("_dev", "").replace("_test", "").replace("_train", "")
            output_dir = (
                Path(__file__).parent.parent
                / "datasets"
                / "processed"
                / f"{base_name}_subset"
            )
        else:
            # Multiple datasets: combine base names
            base_names = []
            for f in corpus_files:
                base = f.stem.replace("_corpus", "").replace("_dev", "").replace("_test", "").replace("_train", "")
                base_names.append(base)
            merged_name = "_".join(base_names)
            output_dir = (
                Path(__file__).parent.parent
                / "datasets"
                / "processed"
                / f"{merged_name}_subset"
            )

    # Step 2: Clean output directory
    if output_dir.exists():
        print(f"Cleaning output directory: {output_dir}")
        shutil.rmtree(output_dir)

    # Step 3: Validate files exist
    for i, (corpus_file, queries_file, qrels_file) in enumerate(
        zip(corpus_files, queries_files, qrels_files)
    ):
        if not corpus_file.exists():
            print(f"Error: Corpus file not found: {corpus_file}")
            return
        if not queries_file.exists():
            print(f"Error: Queries file not found: {queries_file}")
            return
        if not qrels_file.exists():
            print(f"Error: Qrels file not found: {qrels_file}")
            return

    # Step 4: Load data
    print("\nLoading data...")
    if args.max_corpus_docs:
        print(f"  Max corpus docs per dataset: {args.max_corpus_docs}")

    if len(corpus_files) == 1:
        # Single dataset
        print(f"  Dataset: {corpus_files[0].stem}")

        qrels = load_qrels(qrels_files[0])
        required_doc_ids = set()
        for doc_ids in qrels.values():
            required_doc_ids.update(doc_ids)

        tqdm.write(f"  Required docs from qrels: {len(required_doc_ids)}")

        corpus = load_corpus(
            corpus_files[0],
            max_docs=args.max_corpus_docs,
            required_doc_ids=required_doc_ids,
        )
        queries = load_queries(queries_files[0])

        tqdm.write(f"  Corpus: {len(corpus)} docs")
        tqdm.write(f"  Queries: {len(queries)} queries")
        tqdm.write(f"  Qrels: {len(qrels)} queries with relevance judgments")

    else:
        # Multiple datasets: load and merge with prefixing
        print(f"  Datasets: {len(corpus_files)}")

        corpus = {}
        queries = {}
        qrels = {}

        for i, (corpus_file, queries_file, qrels_file) in enumerate(
            zip(corpus_files, queries_files, qrels_files)
        ):
            dataset_name = corpus_file.stem.replace("_corpus", "").replace("_dev", "").replace("_test", "").replace("_train", "")
            print(f"  Loading dataset {i + 1}/{len(corpus_files)}: {dataset_name}")

            # Load qrels first
            dataset_qrels = load_qrels(qrels_file)
            required_doc_ids = set()
            for doc_ids in dataset_qrels.values():
                required_doc_ids.update(doc_ids)

            tqdm.write(f"    Required docs from qrels: {len(required_doc_ids)}")

            # Load corpus and queries
            dataset_corpus = load_corpus(
                corpus_file,
                max_docs=args.max_corpus_docs,
                required_doc_ids=required_doc_ids,
            )
            dataset_queries = load_queries(queries_file)

            tqdm.write(f"    Corpus: {len(dataset_corpus)} docs")
            tqdm.write(f"    Queries: {len(dataset_queries)} queries")
            tqdm.write(
                f"    Qrels: {len(dataset_qrels)} queries with relevance judgments"
            )

            # Merge with prefix
            prefix = f"{dataset_name}#"
            for doc_id, doc in dataset_corpus.items():
                corpus[prefix + doc_id] = doc
            for query_id, query_text in dataset_queries.items():
                queries[prefix + query_id] = query_text
            for query_id, relevant_docs in dataset_qrels.items():
                qrels[prefix + query_id] = {prefix + doc_id for doc_id in relevant_docs}

        print(f"\nMerged datasets:")
        tqdm.write(f"  Total corpus: {len(corpus)} docs")
        tqdm.write(f"  Total queries: {len(queries)} queries")
        tqdm.write(f"  Total qrels: {len(qrels)} queries with relevance judgments")

    # Generate subset using loaded data
    # Sample queries
    print(f"\nSampling {args.n_queries} queries...")
    sampled_query_ids = sample_queries(queries, qrels, args.n_queries, args.seed)
    print(f"  Sampled: {len(sampled_query_ids)} queries")

    # Build BM25 index once
    print("\nBuilding BM25 index...")
    bm25, doc_ids = build_bm25_index(corpus)

    # Build candidate pool
    print("\nBuilding candidate pool...")
    candidate_pool: Set[str] = set()

    for query_id in tqdm(sampled_query_ids, desc="Processing queries", leave=False):
        query_text = queries[query_id]

        # Add relevant docs from qrels
        relevant_docs = qrels[query_id]
        candidate_pool.update(relevant_docs)

        # Add BM25 top M
        bm25_results = bm25_retrieve(query_text, bm25, doc_ids, args.bm25_top_m)
        bm25_doc_ids = [doc_id for doc_id, _ in bm25_results]
        candidate_pool.update(bm25_doc_ids)

    print(f"  Candidate pool size: {len(candidate_pool)} docs")

    # Create output directory
    print(f"\nWriting results to: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)

    # Write subset corpus
    subset_corpus_file = output_dir / "corpus.jsonl"
    print("\nWriting subset corpus...")
    with open(subset_corpus_file, "w", encoding="utf-8") as f:
        for doc_id in tqdm(sorted(candidate_pool), desc="Writing corpus", leave=False):
            if doc_id in corpus:
                doc_entry = {
                    "_id": doc_id,
                    "title": corpus[doc_id]["title"],
                    "text": corpus[doc_id]["text"],
                }
                f.write(json.dumps(doc_entry, ensure_ascii=False) + "\n")
    print(f"  Subset corpus saved: {subset_corpus_file}")

    # Write subset queries
    subset_queries_file = output_dir / "queries.jsonl"
    with open(subset_queries_file, "w", encoding="utf-8") as f:
        for query_id in sorted(sampled_query_ids):
            query_entry = {"_id": query_id, "text": queries[query_id]}
            f.write(json.dumps(query_entry, ensure_ascii=False) + "\n")
    print(f"  Subset queries saved: {subset_queries_file}")

    # Write subset qrels
    subset_qrels_file = output_dir / "qrels.tsv"
    with open(subset_qrels_file, "w", encoding="utf-8") as f:
        f.write("query-id\tcorpus-id\tscore\n")
        for query_id in sorted(sampled_query_ids):
            for doc_id in sorted(qrels[query_id]):
                # Only include docs in candidate pool
                if doc_id in candidate_pool:
                    f.write(f"{query_id}\t{doc_id}\t1\n")
    print(f"  Subset qrels saved: {subset_qrels_file}")

    # Generate Obsidian vault format
    print("\nGenerating Obsidian vault format...")
    vault_dir = output_dir / "vault"
    vault_dir.mkdir(exist_ok=True)

    for doc_id in tqdm(sorted(candidate_pool), desc="Writing vault files", leave=False):
        if doc_id not in corpus:
            continue

        doc = corpus[doc_id]
        # Use doc_id as filename (sanitize for filesystem)
        safe_filename = doc_id.replace("/", "_").replace("\\", "_") + ".md"
        doc_file = vault_dir / safe_filename

        # Write markdown
        with open(doc_file, "w", encoding="utf-8") as f:
            f.write("---\n")
            f.write(f"doc_id: {doc_id}\n")
            f.write(f"title: {doc['title']}\n")
            f.write("---\n\n")
            f.write(f"# {doc['title']}\n\n")
            f.write(doc["text"])

    print(f"  Vault format saved: {vault_dir} ({len(candidate_pool)} files)")

    print("\nSubset generation complete!")


if __name__ == "__main__":
    main()
