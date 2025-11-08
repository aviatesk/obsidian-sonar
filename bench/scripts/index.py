#!/usr/bin/env python3
"""
Index dataset into search backends (Elasticsearch or Weaviate).

Supports:
- BM25 (keyword search)
- Dense vector (via pre-computed embeddings)
- Hybrid (both)
"""

import argparse
import json
from pathlib import Path
from typing import Any

import weaviate
import weaviate.classes as wvc
from elasticsearch import Elasticsearch
from elasticsearch.helpers import bulk as es_bulk
from tqdm import tqdm


def create_es_index(es: Elasticsearch, index_name: str, vector_dims: int | None = None):
    """Create Elasticsearch index with appropriate mappings."""
    settings = {
        "analysis": {
            "analyzer": {
                "multilingual_analyzer": {
                    "type": "custom",
                    "tokenizer": "kuromoji_tokenizer",
                    "filter": [
                        "kuromoji_baseform",
                        "kuromoji_part_of_speech",
                        "lowercase",
                    ],
                }
            }
        }
    }

    mappings: dict[str, Any] = {
        "properties": {
            "doc_id": {"type": "keyword"},
            "chunk_index": {"type": "integer"},
            "text": {"type": "text", "analyzer": "multilingual_analyzer"},
        }
    }

    if vector_dims:
        embedding_config: dict[str, str | int | bool] = {
            "type": "dense_vector",
            "dims": vector_dims,
            "index": True,
            "similarity": "cosine",
        }
        mappings["properties"]["embedding"] = embedding_config

    if es.indices.exists(index=index_name):
        es.indices.delete(index=index_name)

    es.indices.create(index=index_name, mappings=mappings, settings=settings)


def create_weaviate_schema(client: weaviate.WeaviateClient, class_name: str):
    """Create Weaviate schema for chunk-level indexing."""
    if client.collections.exists(class_name):
        client.collections.delete(class_name)

    client.collections.create(
        name=class_name,
        properties=[
            wvc.config.Property(
                name="doc_id",
                data_type=wvc.config.DataType.TEXT,
                tokenization=wvc.config.Tokenization.FIELD,
            ),
            wvc.config.Property(
                name="chunk_index",
                data_type=wvc.config.DataType.INT,
            ),
            wvc.config.Property(
                name="text",
                data_type=wvc.config.DataType.TEXT,
                tokenization=wvc.config.Tokenization.KAGOME_JA,
            ),
        ],
    )


def index_to_es(
    es: Elasticsearch,
    index_name: str,
    corpus_file: Path | None = None,
    embedding_file: Path | None = None,
):
    """Index corpus into Elasticsearch."""
    if embedding_file and embedding_file.exists():
        print(f"Indexing chunks with embeddings from {embedding_file}...")

        with open(embedding_file, "r", encoding="utf-8") as f:
            total_chunks = sum(1 for _ in f)

        batch_size = 100
        actions = []
        chunk_count = 0

        with open(embedding_file, "r", encoding="utf-8") as f:
            for line in tqdm(f, total=total_chunks, desc="Indexing"):
                chunk = json.loads(line)
                chunk_id = chunk["_id"]
                doc_id = chunk["doc_id"]
                chunk_index = chunk["chunk_index"]
                text = chunk["text"]
                embedding = chunk["embedding"]

                body = {
                    "doc_id": doc_id,
                    "chunk_index": chunk_index,
                    "text": text,
                    "embedding": embedding,
                }

                action = {"_index": index_name, "_id": chunk_id, "_source": body}
                actions.append(action)
                chunk_count += 1

                if len(actions) >= batch_size:
                    es_bulk(es, actions)
                    actions = []

        if actions:
            es_bulk(es, actions)

        print(f"Indexed {chunk_count} chunks with embeddings")

    elif corpus_file and corpus_file.exists():
        print(f"Indexing documents (BM25 only) from {corpus_file}...")

        with open(corpus_file, "r", encoding="utf-8") as f:
            total_docs = sum(1 for _ in f)

        batch_size = 100
        actions = []
        doc_count = 0

        with open(corpus_file, "r", encoding="utf-8") as f:
            for line in tqdm(f, total=total_docs, desc="Indexing"):
                doc = json.loads(line)
                doc_id = doc["_id"]

                body = {
                    "doc_id": doc_id,
                    "chunk_index": 0,
                    "text": doc.get("title", "") + " " + doc["text"],
                }

                action = {"_index": index_name, "_id": doc_id, "_source": body}
                actions.append(action)
                doc_count += 1

                if len(actions) >= batch_size:
                    es_bulk(es, actions)
                    actions = []

        if actions:
            es_bulk(es, actions)

        print(f"Indexed {doc_count} documents (BM25 only)")


def index_to_weaviate(
    client: weaviate.WeaviateClient,
    class_name: str,
    corpus_file: Path | None = None,
    embedding_file: Path | None = None,
):
    """Index corpus into Weaviate."""
    collection = client.collections.get(class_name)

    if embedding_file and embedding_file.exists():
        print(f"Indexing chunks with embeddings from {embedding_file}...")

        with open(embedding_file, "r", encoding="utf-8") as f:
            total_chunks = sum(1 for _ in f)

        chunk_count = 0

        with collection.batch.dynamic() as batch:
            with open(embedding_file, "r", encoding="utf-8") as f:
                for line in tqdm(f, total=total_chunks, desc="Indexing"):
                    chunk = json.loads(line)
                    chunk_id = chunk["_id"]
                    doc_id = chunk["doc_id"]
                    chunk_index = chunk["chunk_index"]
                    text = chunk["text"]
                    embedding = chunk["embedding"]

                    properties = {
                        "doc_id": doc_id,
                        "chunk_index": chunk_index,
                        "text": text,
                    }

                    batch.add_object(
                        properties=properties,
                        uuid=weaviate.util.generate_uuid5(chunk_id),
                        vector=embedding,
                    )
                    chunk_count += 1

        print(f"Indexed {chunk_count} chunks with embeddings")

    elif corpus_file and corpus_file.exists():
        print(f"Indexing documents (BM25 only) from {corpus_file}...")

        with open(corpus_file, "r", encoding="utf-8") as f:
            total_docs = sum(1 for _ in f)

        doc_count = 0

        with collection.batch.dynamic() as batch:
            with open(corpus_file, "r", encoding="utf-8") as f:
                for line in tqdm(f, total=total_docs, desc="Indexing"):
                    doc = json.loads(line)
                    doc_id = doc["_id"]

                    properties = {
                        "doc_id": doc_id,
                        "chunk_index": 0,
                        "text": doc.get("title", "") + " " + doc["text"],
                    }

                    batch.add_object(
                        properties=properties,
                        uuid=weaviate.util.generate_uuid5(doc_id),
                        vector=None,
                    )
                    doc_count += 1

        print(f"Indexed {doc_count} documents (BM25 only)")


def main():
    parser = argparse.ArgumentParser(
        description="Index documents into search backends (Elasticsearch or Weaviate)"
    )
    parser.add_argument(
        "--backend",
        type=str,
        choices=["elasticsearch", "weaviate"],
        required=True,
        help="Backend to use",
    )
    parser.add_argument(
        "--dataset",
        type=str,
        help="Path to dataset directory (for BM25-only mode, uses corpus.jsonl)",
    )
    parser.add_argument(
        "--embeddings",
        type=str,
        help="Path to embeddings.jsonl (for hybrid mode with embeddings)",
    )
    parser.add_argument(
        "--index-name",
        type=str,
        default="benchmark",
        help="Index/class name (default: benchmark for ES, Document for Weaviate)",
    )
    parser.add_argument(
        "--host",
        type=str,
        default=None,
        help=(
            "Backend host (default: localhost:9200 for ES, "
            "localhost:8080 for Weaviate)"
        ),
    )
    parser.add_argument(
        "--vector-dims",
        type=int,
        default=None,
        help=(
            "Vector dimensions for embeddings "
            "(default: None for BM25-only, 768 for embeddings)"
        ),
    )

    args = parser.parse_args()

    # Determine corpus and embedding files
    corpus_file = None
    embedding_file = None

    if args.dataset:
        corpus_file = Path(args.dataset) / "corpus.jsonl"
        if not corpus_file.exists():
            print(f"Error: Corpus file not found: {corpus_file}")
            return

    if args.embeddings:
        embedding_file = Path(args.embeddings)
        if not embedding_file.exists():
            print(f"Error: Embeddings file not found: {embedding_file}")
            return

    if not corpus_file and not embedding_file:
        print("Error: Either --dataset or --embeddings must be provided")
        return

    # Auto-detect vector dims if using embeddings
    if embedding_file and args.vector_dims is None:
        args.vector_dims = 768

    # Set default hosts
    if args.host is None:
        args.host = (
            "localhost:9200" if args.backend == "elasticsearch" else "localhost:8080"
        )

    # Index based on backend
    if args.backend == "elasticsearch":
        index_name = args.index_name
        es = Elasticsearch([f"http://{args.host}"])

        if not es.ping():
            print(f"Error: Cannot connect to Elasticsearch at {args.host}")
            return

        print(f"Connected to Elasticsearch at {args.host}")
        create_es_index(es, index_name, vector_dims=args.vector_dims)
        index_to_es(es, index_name, corpus_file, embedding_file)

    elif args.backend == "weaviate":
        class_name = args.index_name if args.index_name != "benchmark" else "Document"

        host_parts = args.host.split(":")
        http_host = host_parts[0]
        http_port = int(host_parts[1]) if len(host_parts) > 1 else 8080

        client = weaviate.connect_to_custom(
            http_host=http_host,
            http_port=http_port,
            http_secure=False,
            grpc_host=http_host,
            grpc_port=50051,
            grpc_secure=False,
            skip_init_checks=True,
        )

        if not client.is_ready():
            print(f"Error: Cannot connect to Weaviate at {args.host}")
            return

        print(f"Connected to Weaviate at {args.host}")
        create_weaviate_schema(client, class_name)
        index_to_weaviate(client, class_name, corpus_file, embedding_file)
        client.close()

    print("\nIndexing complete!")


if __name__ == "__main__":
    main()
