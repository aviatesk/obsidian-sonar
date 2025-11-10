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
5. Output in BEIR format (corpus.jsonl, queries.jsonl, qrels.tsv)

Supports mixed-language evaluation (e.g., Japanese + English corpus).

Note: To generate Obsidian vault from corpus.jsonl, use generate_vault.py separately.
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
    corpus_file: Path,
    max_docs: int | None = None,
    required_doc_ids: Set[str] | None = None,
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

    required_found = len(required_doc_ids) - len(remaining_required)
    tqdm.write(
        f"  Loaded: {regular_count} regular docs + {required_found} required docs"
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
    queries: Dict[str, str],
    qrels: Dict[str, Set[str]],
    n: int,
    seed: int = 42,
    dataset_prefixes: List[str] | None = None,
    query_ratio: List[int] | None = None,
) -> List[str]:
    """
    Sample queries with at least one relevant document.

    For multiple datasets (with prefixes), performs stratified sampling
    according to the specified ratio. Default is equal distribution (1:1:...).

    Args:
        queries: Query dict
        qrels: Qrels dict
        n: Total number of queries to sample
        seed: Random seed
        dataset_prefixes: List of dataset prefixes
            (e.g., ["miracl_ja_dev#", "miracl_en_dev#"])
        query_ratio: List of integers specifying sampling ratio per dataset
            (e.g., [1, 1] for 1:1)

    Returns:
        List of sampled query IDs
    """
    random.seed(seed)

    # Filter queries with at least one relevant doc
    valid_queries = [qid for qid in queries.keys() if qid in qrels and qrels[qid]]

    # Single dataset or no prefixes: simple random sampling
    if not dataset_prefixes or len(dataset_prefixes) <= 1:
        if len(valid_queries) <= n:
            return valid_queries
        return random.sample(valid_queries, n)

    # Multiple datasets: stratified sampling by prefix
    # Group queries by prefix
    grouped_queries = {prefix: [] for prefix in dataset_prefixes}
    for qid in valid_queries:
        for prefix in dataset_prefixes:
            if qid.startswith(prefix):
                grouped_queries[prefix].append(qid)
                break

    # Default ratio: equal distribution
    if not query_ratio:
        query_ratio = [1] * len(dataset_prefixes)

    if len(query_ratio) != len(dataset_prefixes):
        raise ValueError("query_ratio must have same length as dataset_prefixes")

    # Calculate samples per dataset based on ratio
    total_ratio = sum(query_ratio)
    samples_per_dataset = []
    allocated_total = 0

    for i, ratio in enumerate(query_ratio):
        if i == len(query_ratio) - 1:
            # Last dataset gets remaining samples to ensure total = n
            samples = n - allocated_total
        else:
            samples = int(n * ratio / total_ratio)
            allocated_total += samples
        samples_per_dataset.append(samples)

    # Sample from each dataset
    sampled_queries = []
    for prefix, target_samples in zip(dataset_prefixes, samples_per_dataset):
        dataset_queries = grouped_queries[prefix]
        if len(dataset_queries) <= target_samples:
            sampled_queries.extend(dataset_queries)
        else:
            sampled_queries.extend(random.sample(dataset_queries, target_samples))

    return sampled_queries


def tokenize_simple(text: str) -> List[str]:
    """
    Hybrid tokenization: TinySegmenter for Japanese, whitespace for English.

    Uses TinySegmenter (pure Python, lightweight) for Japanese tokenization.
    For English and mixed text, also includes whitespace-based tokens.
    """
    # Lowercase
    text = text.lower()

    # Word-level tokens (for English and space-separated text)
    word_tokens = text.split()

    try:
        # Use TinySegmenter for Japanese tokenization
        import tinysegmenter

        segmenter = tinysegmenter.TinySegmenter()
        tiny_tokens = segmenter.tokenize(text)
        # Filter out whitespace-only tokens
        tiny_tokens = [t for t in tiny_tokens if t.strip()]

        # Combine word-level and TinySegmenter tokens (deduplicate)
        return list(set(word_tokens + tiny_tokens))
    except ImportError:
        # Fallback to character bigrams if TinySegmenter unavailable
        text_no_spaces = text.replace(" ", "")
        char_bigrams = [
            text_no_spaces[i : i + 2] for i in range(len(text_no_spaces) - 1)
        ]
        return word_tokens + char_bigrams


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
    results = [(doc_ids[i], float(scores[i])) for i in top_indices]

    return results


def main():
    parser = argparse.ArgumentParser(
        description=(
            "Generate query-driven candidate pool subset for efficient benchmarking"
        )
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
        "--max-docs-per-dataset",
        type=int,
        default=100000,
        help="Maximum number of documents to load per dataset (default: 100000)",
    )
    parser.add_argument(
        "--seed", type=int, default=42, help="Random seed (default: 42)"
    )
    parser.add_argument(
        "--query-ratio",
        type=str,
        help=(
            "Query sampling ratio for multiple datasets "
            "(e.g., '1:1' for equal distribution, '2:1' for 2x first dataset). "
            "Default: equal distribution"
        ),
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
            # Single dataset: use corpus file stem (remove _corpus only)
            base_name = corpus_files[0].stem.replace("_corpus", "")
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
                base = f.stem.replace("_corpus", "")
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

    # Step 4: Parse query ratio
    query_ratio = None
    if args.query_ratio:
        try:
            query_ratio = [int(x.strip()) for x in args.query_ratio.split(":")]
        except ValueError:
            print(f"Error: Invalid query ratio format: {args.query_ratio}")
            print("  Expected format: '1:1' or '2:1' (colon-separated integers)")
            return

    # Step 5: Process each dataset independently, then merge
    print("\nProcessing datasets...")
    if args.max_docs_per_dataset:
        print(f"  Max docs per dataset: {args.max_docs_per_dataset}")

    # Store per-dataset subsets
    all_corpus = {}
    all_queries = {}
    all_qrels = {}
    all_candidate_pool: Set[str] = set()
    dataset_prefixes = []

    if len(corpus_files) == 1:
        # Single dataset: process directly
        print(f"\nDataset: {corpus_files[0].stem}")

        qrels = load_qrels(qrels_files[0])
        required_doc_ids = set()
        for doc_ids in qrels.values():
            required_doc_ids.update(doc_ids)

        tqdm.write(f"  Required docs from qrels: {len(required_doc_ids)}")

        corpus = load_corpus(
            corpus_files[0],
            max_docs=args.max_docs_per_dataset,
            required_doc_ids=required_doc_ids,
        )
        queries = load_queries(queries_files[0])

        tqdm.write(f"  Corpus: {len(corpus)} docs")
        tqdm.write(f"  Queries: {len(queries)} queries")
        tqdm.write(f"  Qrels: {len(qrels)} queries with relevance judgments")

        # Sample queries
        print(f"\nSampling {args.n_queries} queries...")
        sampled_query_ids = sample_queries(queries, qrels, args.n_queries, args.seed)
        print(f"  Sampled: {len(sampled_query_ids)} queries")

        # Build BM25 index
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

        # Store results
        all_corpus = corpus
        all_queries = {qid: queries[qid] for qid in sampled_query_ids}
        all_qrels = {qid: qrels[qid] for qid in sampled_query_ids}
        all_candidate_pool = candidate_pool

    else:
        # Multiple datasets: process each independently, then merge
        print(f"\nProcessing {len(corpus_files)} datasets independently...")

        # Calculate queries per dataset based on ratio
        if query_ratio:
            if len(query_ratio) != len(corpus_files):
                print(
                    f"Error: query_ratio has {len(query_ratio)} values "
                    f"but {len(corpus_files)} datasets"
                )
                return
            print(f"  Using ratio: {':'.join(map(str, query_ratio))}")
        else:
            query_ratio = [1] * len(corpus_files)
            print("  Using equal distribution (1:1:...)")

        total_ratio = sum(query_ratio)
        queries_per_dataset = []
        allocated_total = 0
        for i, ratio in enumerate(query_ratio):
            if i == len(query_ratio) - 1:
                # Last dataset gets remaining queries
                queries_count = args.n_queries - allocated_total
            else:
                queries_count = int(args.n_queries * ratio / total_ratio)
                allocated_total += queries_count
            queries_per_dataset.append(queries_count)

        # Process each dataset
        for i, (corpus_file, queries_file, qrels_file) in enumerate(
            zip(corpus_files, queries_files, qrels_files)
        ):
            dataset_name = corpus_file.stem.replace("_corpus", "")
            dataset_queries = queries_per_dataset[i]
            prefix = f"{dataset_name}#"
            dataset_prefixes.append(prefix)

            print(
                f"\n[{i + 1}/{len(corpus_files)}] Processing {dataset_name} "
                f"(target: {dataset_queries} queries)..."
            )

            # Load data
            dataset_qrels = load_qrels(qrels_file)
            required_doc_ids = set()
            for doc_ids in dataset_qrels.values():
                required_doc_ids.update(doc_ids)

            tqdm.write(f"  Required docs from qrels: {len(required_doc_ids)}")

            dataset_corpus = load_corpus(
                corpus_file,
                max_docs=args.max_docs_per_dataset,
                required_doc_ids=required_doc_ids,
            )
            dataset_queries_all = load_queries(queries_file)

            tqdm.write(f"  Corpus: {len(dataset_corpus)} docs")
            tqdm.write(f"  Queries: {len(dataset_queries_all)} queries")
            tqdm.write(
                f"  Qrels: {len(dataset_qrels)} queries with relevance judgments"
            )

            # Sample queries for this dataset
            sampled_query_ids = sample_queries(
                dataset_queries_all, dataset_qrels, dataset_queries, args.seed + i
            )
            tqdm.write(f"  Sampled: {len(sampled_query_ids)} queries")

            # Build BM25 index for this dataset
            tqdm.write("  Building BM25 index...")
            bm25, doc_ids = build_bm25_index(dataset_corpus)

            # Build candidate pool for this dataset
            tqdm.write("  Building candidate pool...")
            candidate_pool = set()

            for query_id in tqdm(
                sampled_query_ids, desc="Processing queries", leave=False
            ):
                query_text = dataset_queries_all[query_id]

                # Add relevant docs from qrels
                relevant_docs = dataset_qrels[query_id]
                candidate_pool.update(relevant_docs)

                # Add BM25 top M
                bm25_results = bm25_retrieve(query_text, bm25, doc_ids, args.bm25_top_m)
                bm25_doc_ids = [doc_id for doc_id, _ in bm25_results]
                candidate_pool.update(bm25_doc_ids)

            tqdm.write(f"  Candidate pool: {len(candidate_pool)} docs")

            # Merge into global collections with prefix
            for doc_id in candidate_pool:
                prefixed_doc_id = prefix + doc_id
                all_corpus[prefixed_doc_id] = dataset_corpus[doc_id]
                all_candidate_pool.add(prefixed_doc_id)

            for query_id in sampled_query_ids:
                prefixed_query_id = prefix + query_id
                all_queries[prefixed_query_id] = dataset_queries_all[query_id]
                all_qrels[prefixed_query_id] = {
                    prefix + doc_id for doc_id in dataset_qrels[query_id]
                }

        # Print merged statistics
        print("\nMerged results:")
        print(f"  Total corpus: {len(all_corpus)} docs")
        print(f"  Total queries: {len(all_queries)} queries")
        print(f"  Total qrels: {len(all_qrels)} queries")
        for prefix in dataset_prefixes:
            doc_count = sum(
                1 for doc_id in all_candidate_pool if doc_id.startswith(prefix)
            )
            query_count = sum(1 for qid in all_queries.keys() if qid.startswith(prefix))
            dataset_name = prefix.rstrip("#")
            print(f"    {dataset_name}: {doc_count} docs, {query_count} queries")

    # Use merged collections
    corpus = all_corpus
    queries = all_queries
    qrels = all_qrels
    candidate_pool = all_candidate_pool

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
        for query_id in sorted(queries.keys()):
            query_entry = {"_id": query_id, "text": queries[query_id]}
            f.write(json.dumps(query_entry, ensure_ascii=False) + "\n")
    print(f"  Subset queries saved: {subset_queries_file}")

    # Write subset qrels
    subset_qrels_file = output_dir / "qrels.tsv"
    with open(subset_qrels_file, "w", encoding="utf-8") as f:
        f.write("query-id\tcorpus-id\tscore\n")
        for query_id in sorted(qrels.keys()):
            for doc_id in sorted(qrels[query_id]):
                # Only include docs in candidate pool
                if doc_id in candidate_pool:
                    f.write(f"{query_id}\t{doc_id}\t1\n")
    print(f"  Subset qrels saved: {subset_qrels_file}")

    print("\nSubset generation complete!")
    print(f"  Output: {output_dir}")
    print(f"  Corpus: {len(candidate_pool)} docs")
    print(f"  Queries: {len(queries)} queries")
    print("\nTo generate Obsidian vault, run:")
    print(
        f"  uv run scripts/generate_vault.py --corpus {subset_corpus_file} "
        "--output path/to/vault"
    )


if __name__ == "__main__":
    main()
