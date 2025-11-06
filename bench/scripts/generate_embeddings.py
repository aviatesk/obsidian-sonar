#!/usr/bin/env python3
"""
Generate embeddings for corpus documents with chunk-level granularity.

This script generates embeddings for all documents in a corpus using
sentence-transformers models. Long documents are split into overlapping chunks,
and each chunk is saved as a separate embedding. This allows for more precise
retrieval where specific sections of long documents can be matched.

The embeddings are saved to embeddings.jsonl which can be used by Elasticsearch
and Weaviate backends. Document-level aggregation (Top-m Sum, MaxP, etc.) is
performed at search time for better retrieval accuracy.

Features:
- GPU acceleration (CUDA/MPS) with automatic fallback to CPU
- Streaming processing for memory efficiency
- Automatic chunking for long documents with configurable overlap
- Chunk-level embeddings for precise retrieval
- Proper handling of documents exceeding model's max sequence length
"""

import argparse
import json
from pathlib import Path
from typing import List

import numpy as np
import torch
from sentence_transformers import SentenceTransformer
from tqdm import tqdm


def detect_device(device: str = "auto") -> str:
    """
    Detect the best available device.

    Args:
        device: Device specification ('auto', 'cuda', 'mps', 'cpu')

    Returns:
        Device string for PyTorch
    """
    if device != "auto":
        return device

    if torch.cuda.is_available():
        return "cuda"
    elif torch.backends.mps.is_available():
        return "mps"
    else:
        return "cpu"


def chunk_text(text: str, max_length: int, tokenizer, overlap: int = 50) -> List[str]:
    """
    Split text into overlapping chunks based on token count.

    Args:
        text: Input text
        max_length: Maximum tokens per chunk
        tokenizer: Tokenizer from SentenceTransformer model
        overlap: Number of overlapping tokens between chunks

    Returns:
        List of text chunks
    """
    # Tokenize the entire text
    tokens = tokenizer.tokenize(text)

    # If text fits in one chunk, return as is
    if len(tokens) <= max_length:
        return [text]

    # Split into chunks with overlap
    chunks = []
    start = 0

    while start < len(tokens):
        end = min(start + max_length, len(tokens))
        chunk_tokens = tokens[start:end]

        # Convert tokens back to text
        chunk_text = tokenizer.convert_tokens_to_string(chunk_tokens)
        chunks.append(chunk_text)

        # Move to next chunk with overlap
        if end >= len(tokens):
            break
        start += max_length - overlap

    return chunks


def generate_embeddings(
    corpus_file: Path,
    output_file: Path,
    model_name: str = "intfloat/multilingual-e5-base",
    batch_size: int = 32,
    device: str = "auto",
    max_chunk_tokens: int = 512,
    chunk_overlap: int = 128,
) -> None:
    """
    Generate chunk-level embeddings for corpus documents.

    Each document is split into overlapping chunks, and each chunk gets its own
    embedding. Chunks are identified as {doc_id}#chunk{i}. Document-level
    aggregation (Top-m Sum, MaxP, etc.) is performed at search time.

    Args:
        corpus_file: Path to corpus.jsonl
        output_file: Path to output embeddings.jsonl
        model_name: Model name from Hugging Face Hub
        batch_size: Batch size for encoding
        device: Device to use ('auto', 'cuda', 'mps', 'cpu')
        max_chunk_tokens: Max tokens per chunk (default: 512)
        chunk_overlap: Number of overlapping tokens between chunks (default: 128)
    """
    device = detect_device(device)
    print(f"Using device: {device}")

    print(f"Loading model: {model_name}")
    model = SentenceTransformer(model_name, device=device)

    print(f"Max tokens per chunk: {max_chunk_tokens}")
    print(f"Chunk overlap: {chunk_overlap} tokens")

    # Get tokenizer for chunking
    tokenizer = model.tokenizer

    # Count total documents for progress bar
    print(f"Counting documents in {corpus_file}...")
    with open(corpus_file, "r", encoding="utf-8") as f:
        total_docs = sum(1 for _ in f)
    print(f"Total documents: {total_docs}")

    # Process documents one by one (streaming)
    print(f"Generating embeddings...")
    doc_count = 0
    chunk_count = 0

    with (
        open(corpus_file, "r", encoding="utf-8") as fin,
        open(output_file, "w", encoding="utf-8") as fout,
    ):
        for line in tqdm(fin, total=total_docs, desc="Processing"):
            doc = json.loads(line)
            doc_id = doc["_id"]

            # Combine title and text for embedding
            text = doc.get("title", "") + " " + doc.get("text", "")
            if not text.strip():
                text = doc.get("text", "")

            # Split into chunks if needed
            chunks = chunk_text(text, max_chunk_tokens, tokenizer, chunk_overlap)

            # Generate embeddings for all chunks
            chunk_embeddings = model.encode(
                chunks,
                batch_size=batch_size,
                show_progress_bar=False,
                convert_to_numpy=True,
                normalize_embeddings=False,
            )

            # Write each chunk as a separate entry
            for i, chunk_embedding in enumerate(chunk_embeddings):
                chunk_id = f"{doc_id}#chunk{i}"
                entry = {
                    "_id": chunk_id,
                    "doc_id": doc_id,
                    "chunk_index": i,
                    "text": chunks[i],  # Include chunk text for BM25 search
                    "embedding": chunk_embedding.tolist(),
                }
                fout.write(json.dumps(entry, ensure_ascii=False) + "\n")
                chunk_count += 1

            doc_count += 1

    avg_chunks = chunk_count / doc_count if doc_count > 0 else 0
    print(f"Generated embeddings for {doc_count} documents")
    print(f"Total chunks: {chunk_count} (avg: {avg_chunks:.2f} chunks/doc)")
    print(f"Embedding dimensions: {model.get_sentence_embedding_dimension()}")
    print(f"Output written to: {output_file}")


def main():
    parser = argparse.ArgumentParser(
        description="Generate chunk-level embeddings for corpus documents",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Generate with auto device detection (prefers GPU)
  %(prog)s --corpus corpus.jsonl --output embeddings.jsonl

  # Force CPU usage
  %(prog)s --corpus corpus.jsonl --output embeddings.jsonl --device cpu

  # Use larger batch size on GPU
  %(prog)s --corpus corpus.jsonl --output embeddings.jsonl --batch-size 128

  # Use larger chunks with more overlap
  %(prog)s --corpus corpus.jsonl --output embeddings.jsonl --max-chunk-tokens 768 --chunk-overlap 192

  # Disable chunking (single chunk per document)
  %(prog)s --corpus corpus.jsonl --output embeddings.jsonl --max-chunk-tokens 999999 --chunk-overlap 0
        """,
    )
    parser.add_argument(
        "--corpus",
        type=str,
        required=True,
        help="Path to corpus.jsonl",
    )
    parser.add_argument(
        "--output",
        type=str,
        required=True,
        help="Path to output embeddings.jsonl",
    )
    parser.add_argument(
        "--model",
        type=str,
        default="intfloat/multilingual-e5-base",
        help="Model name (default: intfloat/multilingual-e5-base)",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=32,
        help="Batch size for encoding (default: 32, increase for GPU)",
    )
    parser.add_argument(
        "--device",
        type=str,
        default="auto",
        choices=["auto", "cuda", "mps", "cpu"],
        help="Device to use (default: auto - prefers CUDA > MPS > CPU)",
    )
    parser.add_argument(
        "--max-chunk-tokens",
        type=int,
        default=512,
        help="Max tokens per chunk (default: 512)",
    )
    parser.add_argument(
        "--chunk-overlap",
        type=int,
        default=128,
        help="Number of overlapping tokens between chunks (default: 128)",
    )

    args = parser.parse_args()

    corpus_file = Path(args.corpus)
    output_file = Path(args.output)

    if not corpus_file.exists():
        print(f"Error: Corpus file not found: {corpus_file}")
        return

    # Create output directory if needed
    output_file.parent.mkdir(parents=True, exist_ok=True)

    generate_embeddings(
        corpus_file=corpus_file,
        output_file=output_file,
        model_name=args.model,
        batch_size=args.batch_size,
        device=args.device,
        max_chunk_tokens=args.max_chunk_tokens,
        chunk_overlap=args.chunk_overlap,
    )


if __name__ == "__main__":
    main()
