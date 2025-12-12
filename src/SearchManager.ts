import { EmbeddingSearch } from './EmbeddingSearch';
import { BM25Search } from './BM25Search';
import type { ChunkMetadata } from './MetadataStore';
import type { ConfigManager } from './ConfigManager';
import { WithLogging } from './WithLogging';

export interface ChunkSearchResult {
  content: string;
  score: number;
  metadata: ChunkMetadata;
}

export interface SearchResult {
  filePath: string;
  title: string;
  score: number;
  topChunk: ChunkSearchResult;
  chunkCount: number;
  fileSize: number;
}

interface QueuedSearchRequest {
  componentId: string;
  query: string;
  options: SearchOptionsWithTopK;
  resolve: (value: SearchResult[] | null) => void;
  reject: (error: unknown) => void;
}

/**
 * Search options for both UI and benchmark searches
 *
 * Note: Sonar uses flat search (computes similarity for all chunks),
 * unlike Elasticsearch/Weaviate which use ANN indexes (HNSW).
 * This means Sonar doesn't need a chunkTopK parameter - all chunks
 * are processed, aggregated to documents, and then sliced to topK.
 */
export interface SearchOptions {
  excludeFilePath?: string;
  titleWeight?: number;
  contentWeight?: number;
  embeddingWeight?: number;
  bm25Weight?: number;
}

export interface SearchOptionsWithTopK extends SearchOptions {
  topK: number; // Number of results to return (for RRF limit calculation)
}

export interface FullSearchOptions extends SearchOptionsWithTopK {
  retrievalLimit: number; // Number of chunks to compare (before file level aggregation)
}

/**
 * Reciprocal Rank Fusion constant
 */
const RRF_K = 60;

/**
 * High-level search manager that orchestrates hybrid search
 * combining embedding-based and BM25 full-text search
 *
 * This manager uses a processing queue to handle concurrent requests from
 * multiple UI components (SemanticNoteFinder, RelatedNotesView). When a new
 * request arrives from the same component, any pending request is superseded and
 * resolved with null. This avoids sending stale requests to server.
 *
 * Note: Current queue implementation enforces sequential processing on client side.
 * If `--parallel > 1` is used on the server, the queue should track inFlightCount
 * and allow up to N concurrent requests. For `--parallel 1`, sequential is correct.
 */
export class SearchManager extends WithLogging {
  protected readonly componentName = 'SearchManager';
  private searchQueue: QueuedSearchRequest[] = [];
  private isProcessingSearch = false;

  constructor(
    private embeddingSearch: EmbeddingSearch,
    private bm25Search: BM25Search,
    protected configManager: ConfigManager
  ) {
    super();
    this.log('Initialized');
  }

  /**
   * Search with queue management for handling concurrent requests.
   *
   * When a new request arrives from the same component, any pending (not yet
   * processing) request from that component is removed from the queue and
   * resolved with `null`. This prevents stale results from updating the UI.
   *
   * @param componentId Identifier for the calling component (e.g., 'SemanticNoteFinder')
   * @param query Search query text
   * @param options Search weights and filters
   * @returns Search results, or null if superseded by a newer request
   */
  async search(
    componentId: string,
    query: string,
    options: SearchOptionsWithTopK
  ): Promise<SearchResult[] | null> {
    // Remove pending requests from the same component (resolve with null)
    const newQueue: QueuedSearchRequest[] = [];
    for (const request of this.searchQueue) {
      if (request.componentId === componentId) {
        request.resolve(null);
      } else {
        newQueue.push(request);
      }
    }
    this.searchQueue = newQueue;

    return new Promise((resolve, reject) => {
      this.searchQueue.push({
        componentId,
        query,
        options,
        resolve,
        reject,
      });
      this.processSearchQueue();
    });
  }

  private async processSearchQueue(): Promise<void> {
    if (this.isProcessingSearch || this.searchQueue.length === 0) {
      return;
    }

    this.isProcessingSearch = true;
    const request = this.searchQueue.shift()!;

    try {
      const results = await this.executeSearch(request.query, request.options);
      request.resolve(results);
    } catch (error) {
      request.reject(error);
    }

    this.isProcessingSearch = false;
    this.processSearchQueue();
  }

  /**
   * Core search implementation (flat search - all chunks processed)
   *
   * Unlike Elasticsearch/Weaviate which use ANN indexes (HNSW) to efficiently
   * retrieve top-k chunks, Sonar computes similarity for ALL chunks, then:
   * 1. Aggregate all chunks to documents
   * 2. Apply RRF fusion on all aggregated documents
   * 3. Return all documents sorted by score (caller slices to desired count)
   */
  private async executeSearch(
    query: string,
    options: SearchOptionsWithTopK
  ): Promise<SearchResult[]> {
    const titleWeight = options.titleWeight ?? 0.0;
    const contentWeight = options.contentWeight ?? 1.0;
    const embeddingWeight = options.embeddingWeight ?? 0.6;
    const bm25Weight = options.bm25Weight ?? 0.4;

    // Validate weights
    if (titleWeight === 0 && contentWeight === 0) {
      throw new Error(
        'At least one of titleWeight or contentWeight must be non-zero'
      );
    }
    if (embeddingWeight === 0 && bm25Weight === 0) {
      throw new Error(
        'At least one of embeddingWeight or bm25Weight must be non-zero'
      );
    }

    // Perform hybrid search for title and/or content
    const [titleResults, contentResults] = await Promise.all([
      titleWeight > 0
        ? this.hybridSearch(
            query,
            'title',
            embeddingWeight,
            bm25Weight,
            options
          )
        : Promise.resolve([]),
      contentWeight > 0
        ? this.hybridSearch(
            query,
            'content',
            embeddingWeight,
            bm25Weight,
            options
          )
        : Promise.resolve([]),
    ]);

    // Combine title and content results
    return this.combineSearchResults(
      titleResults,
      contentResults,
      titleWeight,
      contentWeight,
      options.topK
    );
  }

  /**
   * Combine title and content search results with weighted scores
   * Prioritizes content topChunk for excerpts, falls back to title topChunk
   */
  private combineSearchResults(
    titleResults: SearchResult[],
    contentResults: SearchResult[],
    titleWeight: number,
    contentWeight: number,
    topK: number
  ): SearchResult[] {
    // Build maps for quick lookup
    const titleByPath = new Map<string, SearchResult>();
    for (const result of titleResults) {
      titleByPath.set(result.filePath, result);
    }

    const contentByPath = new Map<string, SearchResult>();
    for (const result of contentResults) {
      contentByPath.set(result.filePath, result);
    }

    // Collect all file paths
    const allFilePaths = new Set([
      ...titleByPath.keys(),
      ...contentByPath.keys(),
    ]);

    const totalWeight = titleWeight + contentWeight;
    const results: SearchResult[] = [];

    for (const filePath of allFilePaths) {
      const titleResult = titleByPath.get(filePath);
      const contentResult = contentByPath.get(filePath);

      // Calculate weighted score
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

  /**
   * Hybrid search for either title or content
   * Returns SearchResult[] with scores normalized to [0, 1]
   *
   * For pure BM25/vector search (one weight is 0), returns raw aggregated scores.
   * For hybrid search (both weights > 0), applies RRF fusion.
   *
   * For hybrid results, embedding's topChunk is preferred when available
   * (semantic search typically finds more contextually relevant excerpts).
   */
  private async hybridSearch(
    query: string,
    type: 'title' | 'content',
    embeddingWeight: number,
    bm25Weight: number,
    options: SearchOptionsWithTopK
  ): Promise<SearchResult[]> {
    // Compute chunk-level limit before aggregation
    const retrievalMultiplier = this.configManager.get('retrievalMultiplier');
    const retrievalLimit = options.topK * retrievalMultiplier;

    // Run searches with chunk-level limiting
    const fullOptions = { ...options, retrievalLimit };
    const [embeddingResults, bm25Results] = await Promise.all([
      embeddingWeight > 0
        ? type === 'title'
          ? this.embeddingSearch.searchTitle(query, fullOptions)
          : this.embeddingSearch.searchContent(query, fullOptions)
        : Promise.resolve([]),
      bm25Weight > 0
        ? type === 'title'
          ? this.bm25Search.searchTitle(query, fullOptions)
          : this.bm25Search.searchContent(query, fullOptions)
        : Promise.resolve([]),
    ]);

    // Pure BM25 search: just return results
    if (embeddingWeight === 0 && bm25Weight > 0) {
      return bm25Results;
    }

    // Pure vector search: just return results
    if (bm25Weight === 0 && embeddingWeight > 0) {
      return embeddingResults;
    }

    // Hybrid search: apply RRF fusion and select best topChunk
    return this.fuseSearchResults(
      embeddingResults,
      bm25Results,
      embeddingWeight,
      bm25Weight
    );
  }

  /**
   * Fuse embedding and BM25 search results using RRF
   * Selects the best topChunk for each file based on chunk scores
   */
  private fuseSearchResults(
    embeddingResults: SearchResult[],
    bm25Results: SearchResult[],
    embeddingWeight: number,
    bm25Weight: number
  ): SearchResult[] {
    // Calculate RRF scores
    const rrfScores = this.reciprocalRankFusion(
      embeddingResults,
      bm25Results,
      embeddingWeight,
      bm25Weight
    );

    // Normalize by theoretical maximum RRF score
    const maxTheoreticalRRF = (embeddingWeight + bm25Weight) / (RRF_K + 1);

    // Build maps for quick lookup
    const embeddingByPath = new Map<string, SearchResult>();
    for (const result of embeddingResults) {
      embeddingByPath.set(result.filePath, result);
    }

    const bm25ByPath = new Map<string, SearchResult>();
    for (const result of bm25Results) {
      bm25ByPath.set(result.filePath, result);
    }

    // Build fused results
    // Prefer embedding result for topChunk (semantically relevant)
    const results: SearchResult[] = [];
    for (const [filePath, rrfScore] of rrfScores.entries()) {
      const normalizedScore = rrfScore / maxTheoreticalRRF;
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
   * Reciprocal Rank Fusion algorithm
   */
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

    const allFilePaths = new Set([
      ...embeddingRanks.keys(),
      ...bm25Ranks.keys(),
    ]);

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
}
