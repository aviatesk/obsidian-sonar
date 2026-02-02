#!/usr/bin/env python3
"""
Evaluate TREC run files using ir_measures.

Supports metrics:
- nDCG@10
- Recall@10, Recall@100
- MRR@10
- MAP (Mean Average Precision)
"""

import argparse
import csv
from pathlib import Path
from typing import Dict, List

import ir_measures
from ir_measures import calc_aggregate, read_trec_qrels, read_trec_run


def load_qrels(qrels_file: Path):
    """
    Load qrels from TSV file and convert to ir_measures format.

    Args:
        qrels_file: Path to qrels TSV file (query-id, corpus-id, score)

    Returns:
        Generator of ir_measures.Qrel named tuples
    """
    with open(qrels_file, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            query_id = row["query-id"]
            corpus_id = row["corpus-id"]
            score = int(row["score"])
            yield ir_measures.Qrel(query_id, corpus_id, score)


def evaluate_runs(
    run_files: List[Path], qrels_file: Path, output_file: Path | None = None
) -> None:
    """
    Evaluate TREC run files.

    Args:
        run_files: List of TREC run file paths
        qrels_file: Path to qrels file
        output_file: Optional output CSV file for results
    """
    # Define metrics
    metrics = [
        ir_measures.nDCG @ 10,
        ir_measures.R @ 10,  # Recall@10
        ir_measures.R @ 100,  # Recall@100
        ir_measures.RR @ 10,  # Reciprocal Rank (MRR = mean of RR)
        ir_measures.AP,  # Average Precision (MAP = mean of AP)
    ]

    # Load qrels
    print(f"Loading qrels from {qrels_file}...")
    if qrels_file.suffix == ".tsv":
        # Convert TSV to TREC format
        qrels = list(load_qrels(qrels_file))
    else:
        # Assume TREC format
        qrels = read_trec_qrels(str(qrels_file))

    print(f"Loaded {len(set(q.query_id for q in qrels))} queries")

    # Evaluate each run
    results = []
    for run_file in run_files:
        print(f"\nEvaluating {run_file.name}...")
        run = read_trec_run(str(run_file))

        # Calculate metrics
        aggregated = calc_aggregate(metrics, qrels, run)

        # Extract results
        result: Dict[str, str | float] = {"run": run_file.stem}
        for measure, value in aggregated.items():
            # Format metric name (check longer/specific strings first
            # to avoid substring matches)
            metric_name = str(measure)
            # Replace measure names for clarity
            if "nDCG@10" in metric_name:
                metric_name = "nDCG@10"
            elif "RR@10" in metric_name:
                metric_name = "MRR@10"
            elif "R@100" in metric_name:
                metric_name = "Recall@100"
            elif "R@10" in metric_name:
                metric_name = "Recall@10"
            elif "AP" in metric_name:
                metric_name = "MAP"

            result[metric_name] = value

        results.append(result)

        # Print results
        print(f"  nDCG@10:    {result.get('nDCG@10', 0):.4f}")
        print(f"  Recall@10:  {result.get('Recall@10', 0):.4f}")
        print(f"  Recall@100: {result.get('Recall@100', 0):.4f}")
        print(f"  MRR@10:     {result.get('MRR@10', 0):.4f}")
        print(f"  MAP:        {result.get('MAP', 0):.4f}")

    # Write results to CSV
    if output_file:
        output_file.parent.mkdir(parents=True, exist_ok=True)
        with open(output_file, "w", encoding="utf-8", newline="") as f:
            if results:
                fieldnames = list(results[0].keys())
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(results)
        print(f"\nResults saved to {output_file}")

    # Print comparison table
    length = 96
    print("\n" + "=" * length)
    print("COMPARISON TABLE")
    print("=" * length)
    print(
        f"{'Run':<40} {'nDCG@10':>10} {'Recall@10':>10} "
        f"{'Recall@100':>11} {'MRR@10':>10} {'MAP':>10}"
    )
    print("-" * length)
    for result in results:
        print(
            f"{result['run']:<40} "
            f"{result.get('nDCG@10', 0):>10.4f} "
            f"{result.get('Recall@10', 0):>10.4f} "
            f"{result.get('Recall@100', 0):>11.4f} "
            f"{result.get('MRR@10', 0):>10.4f} "
            f"{result.get('MAP', 0):>10.4f}"
        )
    print("=" * length)


def main():
    parser = argparse.ArgumentParser(
        description="Evaluate TREC run files using ir_measures"
    )
    parser.add_argument(
        "--runs", type=str, nargs="+", required=True, help="TREC run files"
    )
    parser.add_argument(
        "--qrels", type=str, required=True, help="Qrels file (TSV or TREC format)"
    )
    parser.add_argument("--output", type=str, help="Output CSV file for results")

    args = parser.parse_args()

    # Convert to Path objects
    run_files = [Path(run) for run in args.runs]
    qrels_file = Path(args.qrels)
    output_file = Path(args.output) if args.output else None

    evaluate_runs(run_files, qrels_file, output_file)


if __name__ == "__main__":
    main()
