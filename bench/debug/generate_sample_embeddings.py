#!/usr/bin/env python3
"""
Generate embeddings using sentence-transformers (Python)
for comparison with Transformers.js
"""

import argparse
import json
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer


def main():
    parser = argparse.ArgumentParser(
        description="Generate embeddings using sentence-transformers"
    )
    parser.add_argument(
        "--model",
        type=str,
        default="intfloat/multilingual-e5-small",
        help="Model name (default: intfloat/multilingual-e5-small)",
    )
    parser.add_argument(
        "--input-dir",
        type=str,
        default=None,
        help="Input directory containing *.txt files (default: bench/debug/)",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default=None,
        help="Output directory (default: bench/debug/samples/)",
    )

    args = parser.parse_args()

    # Resolve paths
    script_dir = Path(__file__).parent.resolve()

    if args.input_dir:
        input_dir = Path(args.input_dir)
    else:
        input_dir = script_dir

    if args.output_dir:
        output_dir = Path(args.output_dir)
    else:
        output_dir = script_dir / "samples"

    # Find all .txt files
    txt_files = sorted(input_dir.glob("*.txt"))
    if not txt_files:
        print(f"Error: No .txt files found in {input_dir}")
        return

    print(f"Loading model: {args.model}")
    model = SentenceTransformer(args.model)

    # Clean up old embeddings
    for old_file in output_dir.glob("python_embedding_*.json"):
        old_file.unlink()
        print(f"Deleted old file: {old_file}")

    output_dir.mkdir(parents=True, exist_ok=True)

    # Process each .txt file
    for txt_file in txt_files:
        with open(txt_file, encoding="utf-8") as f:
            text = f.read().strip()

        if not text:
            print(f"Skipping empty file: {txt_file}")
            continue

        print(f"\nProcessing: {txt_file.name}")
        print(f"  Text: {text[:50]}...")

        # Generate embedding WITHOUT normalization
        embedding_no_norm = model.encode(
            [text],
            batch_size=1,
            show_progress_bar=False,
            convert_to_numpy=True,
            normalize_embeddings=False,
        )[0]

        # Generate embedding WITH normalization
        embedding_with_norm = model.encode(
            [text],
            batch_size=1,
            show_progress_bar=False,
            convert_to_numpy=True,
            normalize_embeddings=True,
        )[0]

        # Print results
        print(f"  Dimension: {len(embedding_no_norm)}")
        print(f"  No norm - First 5: {embedding_no_norm[:5]}")
        print(f"  No norm - L2 norm: {np.linalg.norm(embedding_no_norm):.6f}")
        print(f"  With norm - L2 norm: {np.linalg.norm(embedding_with_norm):.6f}")

        # Save for comparison with Transformers.js
        output = {
            "text": text,
            "model": args.model,
            "embedding_no_norm": embedding_no_norm.tolist(),
            "embedding_with_norm": embedding_with_norm.tolist(),
        }

        # Use filename stem (without .txt) as identifier
        file_stem = txt_file.stem
        output_file = output_dir / f"python_embedding_{file_stem}.json"
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)

        print(f"  Saved to {output_file}")

    print(f"\n✓ Generated {len(txt_files)} embeddings")
    print(f"  Output directory: {output_dir}")
    print(
        "\nNext: Run Transformers.js embeddings via Obsidian command "
        "'Debug: Generate sample embeddings'"
    )


if __name__ == "__main__":
    main()
