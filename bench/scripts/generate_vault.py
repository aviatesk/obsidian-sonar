#!/usr/bin/env python3
"""
Generate Obsidian vault from corpus JSONL file.

This script reads a corpus.jsonl file and converts it to an Obsidian vault
directory structure with one markdown file per document.
"""

import argparse
import json
import shutil
from pathlib import Path
from typing import Dict

from tqdm import tqdm


def load_corpus_for_vault(corpus_file: Path) -> Dict[str, Dict[str, str]]:
    """
    Load corpus from JSONL file for vault generation.

    Args:
        corpus_file: Path to corpus JSONL file

    Returns:
        Dictionary of documents
    """
    corpus = {}
    with open(corpus_file, "r", encoding="utf-8") as f:
        for line in tqdm(f, desc="Loading corpus", unit=" docs"):
            doc = json.loads(line)
            doc_id = doc["_id"]
            corpus[doc_id] = {
                "title": doc.get("title", ""),
                "text": doc["text"],
            }
    return corpus


def write_vault_files(
    corpus: Dict[str, Dict[str, str]], doc_ids: list[str], vault_dir: Path
) -> None:
    """
    Write corpus documents to vault format.

    Args:
        corpus: Dictionary of documents
        doc_ids: List of document IDs to write
        vault_dir: Output directory for vault files
    """
    vault_dir.mkdir(parents=True, exist_ok=True)

    for doc_id in tqdm(sorted(doc_ids), desc="Writing vault files", unit=" files"):
        if doc_id not in corpus:
            continue

        doc = corpus[doc_id]
        # Use doc_id as filename (sanitize for filesystem)
        safe_filename = doc_id.replace("/", "_").replace("\\", "_") + ".md"
        doc_file = vault_dir / safe_filename

        # Write markdown (title + text only, no frontmatter or H1 header)
        # This matches the format used by ES/Weaviate for fair comparison
        with open(doc_file, "w", encoding="utf-8") as f:
            # Title on first line, followed by blank line, then text
            if doc["title"]:
                f.write(doc["title"])
                f.write("\n\n")
            f.write(doc["text"])


def main():
    parser = argparse.ArgumentParser(
        description="Generate Obsidian vault from corpus JSONL file"
    )
    parser.add_argument(
        "--corpus",
        type=str,
        required=True,
        help="Path to corpus.jsonl file",
    )
    parser.add_argument(
        "--output",
        type=str,
        required=True,
        help="Output directory for vault",
    )

    args = parser.parse_args()

    corpus_file = Path(args.corpus)
    output_dir = Path(args.output)

    if not corpus_file.exists():
        print(f"Error: Corpus file not found: {corpus_file}")
        return

    print(f"\nGenerating vault from corpus: {corpus_file}")
    print(f"Output directory: {output_dir}")

    # Clean output directory if it exists
    if output_dir.exists():
        print(f"\nCleaning output directory: {output_dir}")
        shutil.rmtree(output_dir)

    # Load corpus
    print("\nLoading corpus...")
    corpus = load_corpus_for_vault(corpus_file)
    doc_ids = list(corpus.keys())
    print(f"  Loaded {len(doc_ids)} documents")

    # Generate vault
    print("\nGenerating Obsidian vault...")
    write_vault_files(corpus, doc_ids, output_dir)

    print("\nVault generation complete!")
    print(f"  Output: {output_dir}")
    print(f"  Files: {len(doc_ids)}")


if __name__ == "__main__":
    main()
