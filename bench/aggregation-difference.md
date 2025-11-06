# Chunk Aggregation Comparison: ES/Weaviate vs Sonar

This document compares the chunk-level search and document-level aggregation
algorithms between the benchmark suite (Elasticsearch/Weaviate backends) and the
Sonar Obsidian plugin.

## Overview

Both implementations follow the same high-level workflow:

1. Retrieve chunks at chunk-level
2. Aggregate chunk scores to document/file level
3. Fuse BM25 and vector rankings with RRF for hybrid search

However, they differ significantly in their aggregation strategies and design
philosophies.

## 1. Chunk Retrieval

| Aspect         | ES/Weaviate (bench)                                            | Sonar                                             |
| -------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| Chunk count    | `chunk_top_k=100` (configurable)                               | `topK * 4` (fixed multiplier)                     |
| Implementation | `backends/es/search.py:48`<br>`backends/weaviate/search.py:47` | `EmbeddingSearch.ts:177`<br>`BM25Search.ts:29,53` |
| Flexibility    | User-adjustable parameter                                      | Hardcoded 4x multiplier                           |

## 2. BM25 Chunk Aggregation

### ES/Weaviate (bench)

**Four aggregation methods available** (via `--agg-method`):

```python
# backends/common.py:36-100
def aggregate_chunk_scores(chunk_hits, method="top_m_sum", m=3):
    # Group by document
    for chunk_id, score in chunk_hits:
        doc_id = chunk_id.split("#chunk")[0]
        doc_chunks[doc_id].append(score)

    # Aggregate
    if method == "max_p":
        final_score = max(scores)
    elif method == "top_m_sum":
        final_score = sum(sorted(scores, reverse=True)[:m])
    elif method == "top_m_avg":
        final_score = mean(sorted(scores, reverse=True)[:m])
    elif method == "rrf_per_doc":
        final_score = sum(1/(k+rank) for rank in range(1, len(scores)+1))
```

**Default**: `top_m_sum` with `m=3`

### Sonar

**MaxP only** (maximum score):

```typescript
// BM25Search.ts:52-80
async searchContent(query: string, topK: number) {
  const bm25Results = await this.bm25Store.search(query, topK * 4);

  // Group by file
  const fileScores = new Map<string, number[]>();
  for (const result of bm25Results) {
    const filePath = this.extractFilePathFromChunkId(result.docId);
    fileScores.get(filePath)!.push(result.score);
  }

  // Use max score for each file
  const maxScores = new Map<string, number>();
  for (const [filePath, scores] of fileScores.entries()) {
    maxScores.set(filePath, Math.max(...scores));  // MaxP
  }
}
```

**Rationale**: BM25 scores represent keyword match strength. The highest-scoring
chunk is most relevant.

## 3. Vector Chunk Aggregation

### ES/Weaviate (bench)

**Same four methods as BM25** (via `--agg-method`):

Default is `top_m_sum` without weighting:

```python
# top_m_sum
final_score = sum(scores_sorted[:3])  # Equal weights
```

### Sonar

**Weighted Top-L Sum with decay** (fixed):

```typescript
// EmbeddingSearch.ts:15-26
const L = 3;

function aggregateWeightedDecay(scoresDesc: number[], decay: number): number {
  let w = 1, acc = 0;
  for (let i = 0; i < Math.min(L, scoresDesc.length); i++) {
    acc += w * scoresDesc[i];  // Weighted sum
    w *= decay;                 // Decay: w = 1, decay, decay²
  }
  return acc;
}

// EmbeddingSearch.ts:176-212
const topResults = results.slice(0, topK * MULTIPLIER);
const groupedByFile = /* group chunks by file */;

for (const [filePath, chunks] of groupedByFile.entries()) {
  chunks.sort((a, b) => b.score - a.score);
  const scores = chunks.map(c => c.score);
  const aggregatedScore = aggregateWeightedDecay(scores, scoreDecay);
}
```

**Parameters**:

- `L = 3` (hardcoded)
- `scoreDecay` (configurable, typically 0.95)

**Rationale**: Semantic similarity benefits from document-wide context. Weight
earlier chunks more heavily while integrating information from multiple chunks.

## 4. Hybrid Fusion

Both use **Reciprocal Rank Fusion (RRF)** with `k=60`:

### ES/Weaviate (bench)

```python
# backends/common.py:8-33
def rrf_fusion(hits1: list, hits2: list, k: int = 60) -> list:
    scores = {}

    for rank, (doc_id, _) in enumerate(hits1, 1):
        scores[doc_id] = scores.get(doc_id, 0) + 1 / (k + rank)

    for rank, (doc_id, _) in enumerate(hits2, 1):
        scores[doc_id] = scores.get(doc_id, 0) + 1 / (k + rank)

    return sorted(scores.items(), key=lambda x: x[1], reverse=True)
```

**Workflow**:

1. BM25 chunk search → doc aggregation
2. Vector chunk search → doc aggregation
3. **Fuse doc rankings with RRF**

### Sonar

```typescript
// SearchManager.ts:174-213
private reciprocalRankFusion(
  embeddingResults: SearchResult[],
  bm25Results: SearchResult[],
  embeddingWeight: number,
  bm25Weight: number
): Map<string, number> {
  const embeddingRanks = new Map<string, number>();
  embeddingResults.forEach((result, index) => {
    embeddingRanks.set(result.filePath, index + 1);
  });

  const bm25Ranks = new Map<string, number>();
  bm25Results.forEach((result, index) => {
    bm25Ranks.set(result.filePath, index + 1);
  });

  for (const filePath of allFilePaths) {
    const embeddingRank = embeddingRanks.get(filePath);
    if (embeddingRank !== undefined) {
      rrfScore += embeddingWeight * (1 / (RRF_K + embeddingRank));
    }

    const bm25Rank = bm25Ranks.get(filePath);
    if (bm25Rank !== undefined) {
      rrfScore += bm25Weight * (1 / (RRF_K + bm25Rank));
    }
  }
}
```

**Workflow** (same as ES/Weaviate):

1. BM25 file ranking
2. Vector file ranking
3. **Fuse file rankings with RRF**

**Additional feature**: Weighted RRF (default: `embeddingWeight=0.6`,
`bm25Weight=0.4`)

## 5. Key Differences Summary

| Aspect                 | ES/Weaviate (bench)             | Sonar                          |
| ---------------------- | ------------------------------- | ------------------------------ |
| **BM25 aggregation**   | 4 choices (default: top_m_sum)  | MaxP only                      |
| **Vector aggregation** | 4 choices (default: top_m_sum)  | Weighted Top-L Sum only        |
| **Weighting**          | No weighting in top_m_sum       | Decay weighting (w \*= decay)  |
| **Consistency**        | Same method for BM25 and Vector | Different methods              |
| **Top chunks**         | `m=3` (configurable)            | `L=3` (fixed)                  |
| **Parameters**         | Highly configurable             | Fixed with few config options  |
| **RRF weights**        | Equal weights (1:1)             | Configurable weights (0.6:0.4) |

## 6. Conceptual Model

### ES/Weaviate Workflow

```
┌─────────────────────────────────────────────────────────────┐
│ Elasticsearch/Weaviate (Benchmark Suite)                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ 1. Retrieve chunks (chunk_top_k=100)                        │
│    ├─ BM25:   100 chunks                                    │
│    └─ Vector: 100 chunks                                    │
│                                                             │
│ 2. Aggregate to document level (per retriever)              │
│    ├─ BM25:   top_m_sum(m=3) → doc rankings                 │
│    └─ Vector: top_m_sum(m=3) → doc rankings                 │
│                                                             │
│ 3. Fuse doc rankings                                        │
│    └─ RRF_k=60 (equal weights)                              │
│                                                             │
│ Result: Unified document ranking                            │
└─────────────────────────────────────────────────────────────┘
```

### Sonar Workflow

```
┌─────────────────────────────────────────────────────────────┐
│ Sonar (Obsidian Plugin)                                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ 1. Retrieve chunks (topK * 4)                               │
│    ├─ BM25:   topK * 4 chunks                               │
│    └─ Vector: topK * 4 chunks                               │
│                                                             │
│ 2. Aggregate to file level (per retriever)                  │
│    ├─ BM25:   MaxP → file rankings                          │
│    └─ Vector: Weighted Top-L Sum(L=3, decay) → rankings     │
│                                                             │
│ 3. Fuse file rankings                                       │
│    └─ RRF_k=60 (weighted: 0.6 vector, 0.4 BM25)             │
│                                                             │
│ Result: Unified file ranking                                │
└─────────────────────────────────────────────────────────────┘
```

## 7. Design Philosophy

### ES/Weaviate (bench)

**Target**: Long-form documents (scientific papers, technical reports)

**Design goals**:

- Flexibility: Multiple aggregation strategies for different use cases
- Consistency: Same method can be applied to both BM25 and vector
- Based on research: Implements recommendations from retrieval research
- Evaluation-friendly: Easy to compare different aggregation methods

**Aggregation choices**:

- `max_p`: For single-passage dominance
- `top_m_sum`: Balance between sharpness and distributed evidence (recommended)
- `top_m_avg`: Length-normalized aggregation
- `rrf_per_doc`: Score normalization-free approach

### Sonar

**Target**: Short-form notes (Obsidian vault, typically 100-1000 words per note)

**Design goals**:

- Simplicity: Fixed strategies optimized for typical use case
- Performance: Fast decisions without parameter tuning
- Domain-specific: Tailored to knowledge management workflows
- User-friendly: No complex configuration needed

**Aggregation rationale**:

- BM25 → MaxP: Keywords match strongest in one chunk
- Vector → Weighted decay: Context matters, prioritize beginning

## 8. Implementation References

### ES/Weaviate (bench)

- Chunk aggregation: `bench/backends/common.py:36-100`
- RRF fusion: `bench/backends/common.py:8-33`
- ES search: `bench/backends/es/search.py:26-102`
- Weaviate search: `bench/backends/weaviate/search.py:23-103`

### Sonar

- Vector aggregation: `src/EmbeddingSearch.ts:15-26, 176-212`
- BM25 aggregation: `src/BM25Search.ts:52-80`
- RRF fusion: `src/SearchManager.ts:174-213`
- Hybrid search: `src/SearchManager.ts:56-123`

## 9. Performance Considerations

### ES/Weaviate

- **Chunk retrieval**: O(chunk_top_k) per query
- **Aggregation**: O(chunk_top_k) grouping + O(m log m) sorting per document
- **Flexibility overhead**: Minimal (single switch statement)

### Sonar

- **Chunk retrieval**: O(topK \* 4) per query
- **Vector aggregation**: O(topK _ 4 _ MULTIPLIER) + O(L) per file (L=3 fixed)
- **BM25 aggregation**: O(topK \* 4) + O(chunks_per_file) max operation
- **Optimization**: Fixed L=3 allows loop unrolling

## 10. Conclusion

Both implementations achieve the same goal (chunk-level retrieval with
document-level aggregation) but with different design priorities:

**ES/Weaviate** prioritizes:

- Flexibility for research and evaluation
- Consistency across retrieval methods
- Adaptability to different document types and lengths

**Sonar** prioritizes:

- Simplicity and ease of use
- Domain-specific optimization (short notes)
- Performance with minimal configuration

The choice between MaxP (BM25) and Weighted Top-L Sum (Vector) in Sonar reflects
domain knowledge about keyword vs. semantic search, while ES/Weaviate's unified
approach allows for systematic evaluation of different strategies.
