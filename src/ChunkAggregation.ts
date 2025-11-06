/**
 * Chunk aggregation methods for document-level scoring.
 *
 * Provides various strategies to aggregate chunk-level scores into
 * document/file-level scores, matching the benchmark suite implementation.
 */

export type AggregationMethod =
  | 'max_p'
  | 'top_m_sum'
  | 'top_m_avg'
  | 'rrf_per_doc'
  | 'weighted_top_l_sum';

export interface AggregationParams {
  method: AggregationMethod;
  m?: number; // For top_m_sum and top_m_avg (default: 3)
  l?: number; // For weighted_top_l_sum (default: 3)
  decay?: number; // For weighted_top_l_sum (default: 0.95)
  rrfK?: number; // For rrf_per_doc (default: 60)
}

/**
 * Aggregate chunk scores to file/document level.
 *
 * @param fileScores - Map of file paths to arrays of chunk scores
 * @param params - Aggregation parameters
 * @returns Map of file paths to aggregated scores
 */
export function aggregateChunkScores(
  fileScores: Map<string, number[]>,
  params: AggregationParams
): Map<string, number> {
  const aggregated = new Map<string, number>();

  for (const [filePath, scores] of fileScores.entries()) {
    if (scores.length === 0) {
      continue;
    }

    const scoresSorted = [...scores].sort((a, b) => b - a);
    let finalScore: number;

    switch (params.method) {
      case 'max_p':
        finalScore = aggregateMaxP(scoresSorted);
        break;
      case 'top_m_sum':
        finalScore = aggregateTopMSum(scoresSorted, params.m ?? 3);
        break;
      case 'top_m_avg':
        finalScore = aggregateTopMAvg(scoresSorted, params.m ?? 3);
        break;
      case 'rrf_per_doc':
        finalScore = aggregateRRFPerDoc(scores, params.rrfK ?? 60);
        break;
      case 'weighted_top_l_sum':
        finalScore = aggregateWeightedTopLSum(
          scoresSorted,
          params.l ?? 3,
          params.decay ?? 0.95
        );
        break;
      default:
        throw new Error(`Unknown aggregation method: ${params.method}`);
    }

    aggregated.set(filePath, finalScore);
  }

  return aggregated;
}

/**
 * MaxP: Maximum score across all chunks.
 * Good for keyword matching where the strongest match matters most.
 */
function aggregateMaxP(scoresSorted: number[]): number {
  return scoresSorted[0];
}

/**
 * Top-M Sum: Sum of top M chunk scores.
 * Balances between sharpness (MaxP) and distributed evidence.
 */
function aggregateTopMSum(scoresSorted: number[], m: number): number {
  return scoresSorted.slice(0, m).reduce((sum, score) => sum + score, 0);
}

/**
 * Top-M Average: Average of top M chunk scores.
 * Length-normalized variant of Top-M Sum.
 */
function aggregateTopMAvg(scoresSorted: number[], m: number): number {
  const topScores = scoresSorted.slice(0, m);
  if (topScores.length === 0) {
    return 0;
  }
  return topScores.reduce((sum, score) => sum + score, 0) / topScores.length;
}

/**
 * RRF Per-Document: RRF-style scoring within document chunks.
 * Score-normalization-free approach.
 */
function aggregateRRFPerDoc(scores: number[], k: number): number {
  let totalScore = 0;
  for (let rank = 1; rank <= scores.length; rank++) {
    totalScore += 1 / (k + rank);
  }
  return totalScore;
}

/**
 * Weighted Top-L Sum: Sum of top L chunks with exponential decay weighting.
 * Prioritizes top chunks while incorporating context from multiple chunks.
 *
 * Formula: w_0 * score[0] + w_1 * score[1] + ... where w_i = decay^i
 */
function aggregateWeightedTopLSum(
  scoresSorted: number[],
  l: number,
  decay: number
): number {
  let weight = 1;
  let accumulator = 0;

  for (let i = 0; i < Math.min(l, scoresSorted.length); i++) {
    accumulator += weight * scoresSorted[i];
    weight *= decay;
  }

  return accumulator;
}
