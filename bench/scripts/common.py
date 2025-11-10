"""Common functions for search backends."""


def rrf_fusion(hits1: list, hits2: list, k: int = 60) -> list:
    """
    Reciprocal Rank Fusion (RRF) for combining two ranked lists.

    Formula: score(d) = sum(1 / (k + rank_i)) for all rankings where d appears

    Args:
        hits1: List of (doc_id, score) tuples from first ranker
        hits2: List of (doc_id, score) tuples from second ranker
        k: RRF constant (default: 60)

    Returns:
        List of (doc_id, fused_score) tuples sorted by fused score
    """
    scores = {}

    for rank, (doc_id, _) in enumerate(hits1, 1):
        scores[doc_id] = scores.get(doc_id, 0) + 1 / (k + rank)

    for rank, (doc_id, _) in enumerate(hits2, 1):
        scores[doc_id] = scores.get(doc_id, 0) + 1 / (k + rank)

    return sorted(scores.items(), key=lambda x: x[1], reverse=True)


def aggregate_chunk_scores(
    chunk_hits: list, method: str = "top_m_sum", m: int = 3
) -> list:
    """
    Aggregate chunk-level scores to document-level scores.

    Args:
        chunk_hits: List of (doc_id, score) tuples
        method: Aggregation method (max_p, top_m_sum, top_m_avg, rrf_per_doc)
        m: Number of top chunks to consider for top_m_* methods

    Returns:
        List of (doc_id, aggregated_score) tuples sorted by score
    """
    # Group chunks by document
    doc_chunks = {}
    for doc_id, score in chunk_hits:
        if doc_id not in doc_chunks:
            doc_chunks[doc_id] = []
        doc_chunks[doc_id].append(score)

    # Aggregate scores per document
    doc_scores = []
    for doc_id, scores in doc_chunks.items():
        scores_sorted = sorted(scores, reverse=True)

        if method == "max_p":
            final_score = max(scores)
        elif method == "top_m_sum":
            final_score = sum(scores_sorted[:m])
        elif method == "top_m_avg":
            top_scores = scores_sorted[:m]
            final_score = sum(top_scores) / len(top_scores) if top_scores else 0.0
        elif method == "rrf_per_doc":
            k = 60
            final_score = sum(1 / (k + rank) for rank in range(1, len(scores) + 1))
        else:
            raise ValueError(f"Unknown aggregation method: {method}")

        doc_scores.append((doc_id, final_score))

    doc_scores.sort(key=lambda x: x[1], reverse=True)
    return doc_scores
