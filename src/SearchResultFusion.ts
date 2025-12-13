import type { ChunkResult, SearchResult } from './SearchManager';
import {
  aggregateChunkScores,
  type AggregationParams,
} from './ChunkAggregation';

const RRF_K = 60;

/**
 * Aggregate chunk-level results to file-level results
 * Groups chunks by file, aggregates scores, and selects top chunk per file
 */
export function aggregateChunksToFiles(
  chunks: ChunkResult[],
  aggOptions: AggregationParams
): SearchResult[] {
  if (chunks.length === 0) return [];

  const chunksByFile = new Map<string, ChunkResult[]>();
  for (const chunk of chunks) {
    if (!chunksByFile.has(chunk.filePath)) {
      chunksByFile.set(chunk.filePath, []);
    }
    chunksByFile.get(chunk.filePath)!.push(chunk);
  }

  // Sort chunks within each file by score (descending)
  const fileScores = new Map<string, number[]>();
  for (const [filePath, fileChunks] of chunksByFile.entries()) {
    fileChunks.sort((a, b) => b.score - a.score);
    fileScores.set(
      filePath,
      fileChunks.map(c => c.score)
    );
  }

  const aggregatedScores = aggregateChunkScores(fileScores, aggOptions);

  const results: SearchResult[] = [];
  for (const [filePath, aggregatedScore] of aggregatedScores.entries()) {
    const fileChunks = chunksByFile.get(filePath)!;
    const topChunk = fileChunks[0]; // Best scoring chunk
    results.push({
      filePath,
      title: topChunk.metadata.title || filePath,
      score: aggregatedScore,
      topChunk: {
        content: topChunk.content,
        score: topChunk.score,
        metadata: topChunk.metadata,
      },
      chunkCount: fileChunks.length,
      fileSize: topChunk.metadata.size,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Reciprocal Rank Fusion algorithm
 * Combines rankings from multiple sources using weighted RRF scores
 *
 * Formula: RRF(d) = Σ weight_i / (k + rank_i(d))
 * where k is a constant (60) that mitigates the impact of high rankings
 */
export function reciprocalRankFusion(
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

  const allFilePaths = new Set([...embeddingRanks.keys(), ...bm25Ranks.keys()]);

  const rrfScores = new Map<string, number>();
  for (const filePath of allFilePaths) {
    let rrfScore = 0;

    const embeddingRank = embeddingRanks.get(filePath);
    if (embeddingRank !== undefined) {
      rrfScore += embeddingWeight * (1 / (RRF_K + embeddingRank));
    }

    const bm25Rank = bm25Ranks.get(filePath);
    if (bm25Rank !== undefined) {
      rrfScore += bm25Weight * (1 / (RRF_K + bm25Rank));
    }

    rrfScores.set(filePath, rrfScore);
  }

  return rrfScores;
}

/**
 * Fuse embedding and BM25 file-level results using RRF
 * Prefers embedding's topChunk when available (semantically relevant)
 */
export function fuseFileResults(
  embeddingResults: SearchResult[],
  bm25Results: SearchResult[],
  embeddingWeight: number,
  bm25Weight: number
): SearchResult[] {
  const rrfScores = reciprocalRankFusion(
    embeddingResults,
    bm25Results,
    embeddingWeight,
    bm25Weight
  );

  // Normalize by theoretical maximum RRF score (rank 1 in both)
  const maxTheoreticalRRF = (embeddingWeight + bm25Weight) / (RRF_K + 1);

  const embeddingByPath = new Map<string, SearchResult>();
  for (const result of embeddingResults) {
    embeddingByPath.set(result.filePath, result);
  }

  const bm25ByPath = new Map<string, SearchResult>();
  for (const result of bm25Results) {
    bm25ByPath.set(result.filePath, result);
  }

  const results: SearchResult[] = [];
  for (const [filePath, rrfScore] of rrfScores.entries()) {
    const normalizedScore = rrfScore / maxTheoreticalRRF;
    // Prefer embedding result for topChunk (semantically relevant)
    const baseResult =
      embeddingByPath.get(filePath) || bm25ByPath.get(filePath);
    if (!baseResult) continue;

    results.push({
      ...baseResult,
      score: normalizedScore,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Combine title and content search results with weighted scores
 * Prioritizes content topChunk for excerpts, falls back to title topChunk
 */
export function combineSearchResults(
  titleResults: SearchResult[],
  contentResults: SearchResult[],
  titleWeight: number,
  contentWeight: number,
  topK: number
): SearchResult[] {
  const titleByPath = new Map<string, SearchResult>();
  for (const result of titleResults) {
    titleByPath.set(result.filePath, result);
  }

  const contentByPath = new Map<string, SearchResult>();
  for (const result of contentResults) {
    contentByPath.set(result.filePath, result);
  }

  const allFilePaths = new Set([
    ...titleByPath.keys(),
    ...contentByPath.keys(),
  ]);

  const totalWeight = titleWeight + contentWeight;
  const results: SearchResult[] = [];

  for (const filePath of allFilePaths) {
    const titleResult = titleByPath.get(filePath);
    const contentResult = contentByPath.get(filePath);

    const titleScore = titleResult?.score || 0;
    const contentScore = contentResult?.score || 0;
    const weightedScore =
      titleWeight * titleScore + contentWeight * contentScore;
    const finalScore = totalWeight > 0 ? weightedScore / totalWeight : 0;

    // Prioritize content result for topChunk (better for excerpts)
    const baseResult = contentResult || titleResult;
    if (!baseResult) continue;

    results.push({
      ...baseResult,
      score: finalScore,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}
