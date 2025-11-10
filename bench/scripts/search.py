#!/usr/bin/env python3
"""
Search with backends (Elasticsearch or Weaviate) and output TREC run format.

Methods:
- bm25: Keyword search (BM25)
- vector: Dense vector search (via pre-computed embeddings)
- hybrid: Hybrid search with RRF fusion
"""

import argparse
import json
import sys
from pathlib import Path

# Add scripts directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

import weaviate
import weaviate.classes as wvc
from common import aggregate_chunk_scores, rrf_fusion
from elasticsearch import Elasticsearch
from tqdm import tqdm


def search_es_bm25(es, index_name, query_text, chunk_top_k, agg_method, agg_m):
    """BM25 search in Elasticsearch."""
    result = es.search(
        index=index_name,
        query={"match": {"text": query_text}},
        size=chunk_top_k,
    )

    chunk_hits = [
        (hit["_source"]["doc_id"], hit["_score"]) for hit in result["hits"]["hits"]
    ]
    return aggregate_chunk_scores(chunk_hits, method=agg_method, m=agg_m)


def search_es_vector(es, index_name, query_embedding, chunk_top_k, agg_method, agg_m):
    """
    Vector search in Elasticsearch using kNN with HNSW index.

    Uses ANN (Approximate Nearest Neighbor) search with HNSW algorithm,
    which efficiently searches large vector spaces. The num_candidates
    parameter controls the search quality-speed tradeoff.
    """
    # Elasticsearch has a hard limit of 10000 for num_candidates
    # See: https://www.elastic.co/guide/en/elasticsearch/reference/current/knn-search.html
    num_candidates = min(chunk_top_k * 2, 10000)

    result = es.search(
        index=index_name,
        knn={
            "field": "embedding",
            "query_vector": query_embedding,
            "k": chunk_top_k,
            # num_candidates: Number of candidates considered per shard
            # during ANN search. Higher values improve accuracy at the cost
            # of speed. Limited to 10000 (Elasticsearch constraint)
            "num_candidates": num_candidates,
        },
        size=chunk_top_k,
    )

    # Elasticsearch kNN returns normalized scores: score = (1 + cosine_similarity) / 2
    # Convert back to raw cosine similarity for fair comparison with other backends
    chunk_hits = [
        (hit["_source"]["doc_id"], hit["_score"] * 2 - 1)
        for hit in result["hits"]["hits"]
    ]
    return aggregate_chunk_scores(chunk_hits, method=agg_method, m=agg_m)


def search_es_hybrid(
    es, index_name, query_text, query_embedding, chunk_top_k, agg_method, agg_m, rrf_k
):
    """Hybrid search in Elasticsearch."""
    bm25_docs = search_es_bm25(
        es, index_name, query_text, chunk_top_k, agg_method, agg_m
    )
    vector_docs = search_es_vector(
        es, index_name, query_embedding, chunk_top_k, agg_method, agg_m
    )
    return rrf_fusion(bm25_docs, vector_docs, k=rrf_k)


def search_weaviate_bm25(
    client, class_name, query_text, chunk_top_k, agg_method, agg_m
):
    """BM25 search in Weaviate."""
    collection = client.collections.get(class_name)

    response = collection.query.bm25(
        query=query_text,
        limit=chunk_top_k,
        return_metadata=wvc.query.MetadataQuery(score=True),
    )

    chunk_hits = [
        (obj.properties["doc_id"], obj.metadata.score) for obj in response.objects
    ]
    return aggregate_chunk_scores(chunk_hits, method=agg_method, m=agg_m)


def search_weaviate_vector(
    client, class_name, query_embedding, chunk_top_k, agg_method, agg_m
):
    """
    Vector search in Weaviate using HNSW index.

    Uses ANN (Approximate Nearest Neighbor) search with HNSW algorithm,
    which efficiently searches large vector spaces. The limit parameter
    controls how many results to retrieve.
    """
    collection = client.collections.get(class_name)

    response = collection.query.near_vector(
        near_vector=query_embedding,
        limit=chunk_top_k,
        return_metadata=wvc.query.MetadataQuery(distance=True),
    )

    chunk_hits = [
        (obj.properties["doc_id"], 1 - obj.metadata.distance)
        for obj in response.objects
    ]
    return aggregate_chunk_scores(chunk_hits, method=agg_method, m=agg_m)


def search_weaviate_hybrid(
    client,
    class_name,
    query_text,
    query_embedding,
    chunk_top_k,
    agg_method,
    agg_m,
    rrf_k,
):
    """Hybrid search in Weaviate."""
    bm25_docs = search_weaviate_bm25(
        client, class_name, query_text, chunk_top_k, agg_method, agg_m
    )
    vector_docs = search_weaviate_vector(
        client, class_name, query_embedding, chunk_top_k, agg_method, agg_m
    )
    return rrf_fusion(bm25_docs, vector_docs, k=rrf_k)


def write_trec_run(output_file, run_id, results):
    """Write results in TREC run format."""
    with open(output_file, "w", encoding="utf-8") as f:
        for query_id, hits in results.items():
            for rank, (doc_id, score) in enumerate(hits, 1):
                f.write(f"{query_id} Q0 {doc_id} {rank} {score} {run_id}\n")


def main():
    parser = argparse.ArgumentParser(
        description="Search with backends (Elasticsearch or Weaviate)"
    )
    parser.add_argument(
        "--backend",
        type=str,
        choices=["elasticsearch", "weaviate"],
        required=True,
        help="Backend to use",
    )
    parser.add_argument(
        "--queries", type=str, required=True, help="Path to queries.jsonl"
    )
    parser.add_argument(
        "--output", type=str, required=True, help="Output TREC run file"
    )
    parser.add_argument(
        "--method",
        type=str,
        choices=["bm25", "vector", "hybrid"],
        default="bm25",
        help="Search method (default: bm25)",
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
            "Backend host (default: localhost:9200 for ES, localhost:8080 for Weaviate)"
        ),
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=100,
        help="Number of documents to return (default: 100)",
    )
    parser.add_argument(
        "--retrieval-multiplier",
        type=int,
        default=10,
        help=(
            "Multiplier for hybrid search pre-fusion limit (default: 10). "
            "Limit = top_k * retrieval_multiplier. Lower values (e.g., 5) "
            "focus on high-quality results, higher values (e.g., 20) increase recall."
        ),
    )
    parser.add_argument(
        "--agg-method",
        type=str,
        default="max_p",
        choices=["max_p", "top_m_sum", "top_m_avg", "rrf_per_doc"],
        help="Document aggregation method (default: max_p)",
    )
    parser.add_argument(
        "--agg-m",
        type=int,
        default=3,
        help="Number of top chunks per document for top_m_* methods (default: 3)",
    )
    parser.add_argument(
        "--rrf-k",
        type=int,
        default=60,
        help="RRF k parameter for hybrid search (default: 60)",
    )
    parser.add_argument(
        "--embeddings",
        type=str,
        default=None,
        help="Path to query embeddings (required for vector/hybrid methods)",
    )

    args = parser.parse_args()

    # Calculate chunk_top_k from top_k and retrieval_multiplier
    chunk_top_k = args.top_k * args.retrieval_multiplier

    queries_file = Path(args.queries)
    output_file = Path(args.output)

    if not queries_file.exists():
        print(f"Error: Queries file not found: {queries_file}")
        return

    # Load query embeddings if needed
    query_embeddings = {}
    if args.method in ["vector", "hybrid"]:
        if not args.embeddings:
            print(f"Error: --embeddings required for {args.method} method")
            return

        embeddings_file = Path(args.embeddings)
        if not embeddings_file.exists():
            print(f"Error: Embeddings file not found: {embeddings_file}")
            return

        print(f"Loading query embeddings from {embeddings_file}...")
        with open(embeddings_file, "r", encoding="utf-8") as f:
            for line in f:
                data = json.loads(line)
                query_embeddings[data["doc_id"]] = data["embedding"]

    # Set default hosts
    if args.host is None:
        args.host = (
            "localhost:9200" if args.backend == "elasticsearch" else "localhost:8080"
        )

    # Load queries
    print(f"Loading queries from {queries_file}...")
    queries = {}
    with open(queries_file, "r", encoding="utf-8") as f:
        for line in f:
            query = json.loads(line)
            queries[query["_id"]] = query["text"]

    # Initialize backend and search
    results = {}

    if args.backend == "elasticsearch":
        index_name = args.index_name
        es = Elasticsearch([f"http://{args.host}"])

        if not es.ping():
            print(f"Error: Cannot connect to Elasticsearch at {args.host}")
            return

        print(f"Connected to Elasticsearch at {args.host}")
        print(f"Searching with method: {args.method}")

        for query_id, query_text in tqdm(queries.items(), desc="Searching"):
            hits = []
            if args.method == "bm25":
                hits = search_es_bm25(
                    es,
                    index_name,
                    query_text,
                    chunk_top_k,
                    args.agg_method,
                    args.agg_m,
                )
            elif args.method == "vector":
                query_embedding = query_embeddings.get(query_id)
                if not query_embedding:
                    continue
                hits = search_es_vector(
                    es,
                    index_name,
                    query_embedding,
                    chunk_top_k,
                    args.agg_method,
                    args.agg_m,
                )
            elif args.method == "hybrid":
                query_embedding = query_embeddings.get(query_id)
                if not query_embedding:
                    continue
                hits = search_es_hybrid(
                    es,
                    index_name,
                    query_text,
                    query_embedding,
                    chunk_top_k,
                    args.agg_method,
                    args.agg_m,
                    args.rrf_k,
                )

            results[query_id] = hits[: args.top_k]

        if len(results) == 0:
            print(
                "Warning: No results found for any queries. "
                "Check if embeddings match query IDs."
            )

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
        print(f"Searching with method: {args.method}")

        for query_id, query_text in tqdm(queries.items(), desc="Searching"):
            hits = []
            if args.method == "bm25":
                hits = search_weaviate_bm25(
                    client,
                    class_name,
                    query_text,
                    chunk_top_k,
                    args.agg_method,
                    args.agg_m,
                )
            elif args.method == "vector":
                query_embedding = query_embeddings.get(query_id)
                if not query_embedding:
                    continue
                hits = search_weaviate_vector(
                    client,
                    class_name,
                    query_embedding,
                    chunk_top_k,
                    args.agg_method,
                    args.agg_m,
                )
            elif args.method == "hybrid":
                query_embedding = query_embeddings.get(query_id)
                if not query_embedding:
                    continue
                hits = search_weaviate_hybrid(
                    client,
                    class_name,
                    query_text,
                    query_embedding,
                    chunk_top_k,
                    args.agg_method,
                    args.agg_m,
                    args.rrf_k,
                )

            results[query_id] = hits[: args.top_k]

        client.close()

        if len(results) == 0:
            print(
                "Warning: No results found for any queries. "
                "Check if embeddings match query IDs."
            )

    # Write TREC run file
    output_file.parent.mkdir(parents=True, exist_ok=True)
    run_id = f"{args.backend}.{args.method}"
    write_trec_run(output_file, run_id, results)

    print(f"\nSearch complete! Results written to {output_file}")
    print(f"  Queries: {len(results)}")
    print(f"  Method: {args.method}")


if __name__ == "__main__":
    main()
