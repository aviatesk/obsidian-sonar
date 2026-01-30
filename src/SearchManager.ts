import { EmbeddingSearch } from './EmbeddingSearch';
import { BM25Search } from './BM25Search';
import type { ChunkMetadata } from './MetadataStore';
import type { ConfigManager } from './ConfigManager';
import { WithLogging } from './WithLogging';
import {
  fuseFileResults,
  combineSearchResults,
  aggregateChunksToFiles,
  mergeAndDeduplicateChunks,
} from './SearchResultFusion';
import type { LlamaCppReranker } from './LlamaCppReranker';

/**
 * Chunk-level search result returned by BM25Search/EmbeddingSearch
 * Used as intermediate result before file-level aggregation
 */
export interface ChunkResult {
  chunkId: string;
  filePath: string;
  chunkIndex: number;
  content: string;
  score: number;
  metadata: ChunkMetadata;
}

/**
 * Chunk info for display in SearchResult
 */
export interface ChunkSearchResult {
  content: string;
  score: number;
  metadata: ChunkMetadata;
}

/**
 * Search result representing a matched document.
 *
 * The `score` field is normalized to [0, 1] for UI display purposes (e.g.,
 * progress bars). It does NOT represent absolute relevance and should not
 * be compared across different queries.
 */
export interface SearchResult {
  filePath: string;
  title: string;
  /** Normalized score in [0, 1] for UI display. */
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

interface QueuedRerankRequest {
  componentId: string;
  query: string;
  results: SearchResult[];
  topK: number;
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
  prependTitleToChunks?: boolean; // Prepend title to chunks for reranking (default: true)
}

export interface FullSearchOptions extends SearchOptionsWithTopK {
  retrievalLimit: number; // Number of chunks to compare (before file level aggregation)
}

/**
 * Metadata about chunk-based reranking execution
 */
export interface ChunkRerankMetadata {
  embeddingChunkCount: number;
  bm25ChunkCount: number;
  mergedChunkCount: number;
  retrievalTimeMs: number;
  rerankTimeMs: number;
  totalTimeMs: number;
}

/**
 * Result of chunk-based reranking with metadata
 */
export interface ChunkRerankResult {
  results: SearchResult[];
  metadata: ChunkRerankMetadata;
}

/**
 * Debug data for chunk-based reranking analysis
 */
export interface ChunkRerankDebugData {
  query: string;
  embeddingChunks: ChunkResult[];
  bm25Chunks: ChunkResult[];
  mergedChunks: ChunkResult[];
  rerankedChunks: ChunkResult[];
  results: SearchResult[];
  metadata: ChunkRerankMetadata;
}

/**
 * High-level search manager that orchestrates hybrid search
 * combining embedding-based and BM25 full-text search
 *
 * This manager uses processing queues to handle concurrent requests from
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
  private rerankQueue: QueuedRerankRequest[] = [];
  private isProcessingSearch = false;
  private isProcessingRerank = false;

  constructor(
    private embeddingSearch: EmbeddingSearch,
    private bm25Search: BM25Search,
    private reranker: LlamaCppReranker,
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
        ? this.hybridTitleSearch(query, embeddingWeight, bm25Weight, options)
        : Promise.resolve([]),
      contentWeight > 0
        ? this.hybridContentSearch(query, embeddingWeight, bm25Weight, options)
        : Promise.resolve([]),
    ]);

    // Combine title and content results
    return combineSearchResults(
      titleResults,
      contentResults,
      titleWeight,
      contentWeight,
      options.topK
    );
  }

  /**
   * Rerank search results using cross-encoder with queue management.
   *
   * When a new request arrives from the same component, any pending (not yet
   * processing) request from that component is removed from the queue and
   * resolved with `null`. This prevents stale results from updating the UI
   * and avoids wasting server resources on outdated requests.
   *
   * @param componentId Identifier for the calling component (e.g., 'SemanticNoteFinder')
   * @param query Search query text
   * @param results Search results to rerank
   * @param topK Number of results to return
   * @returns Reranked results with normalized scores, or null if superseded/not ready
   */
  async rerank(
    componentId: string,
    query: string,
    results: SearchResult[],
    topK: number
  ): Promise<SearchResult[] | null> {
    if (!this.reranker.isReady() || results.length === 0) {
      return null;
    }

    // Remove pending requests from the same component (resolve with null)
    const newQueue: QueuedRerankRequest[] = [];
    for (const request of this.rerankQueue) {
      if (request.componentId === componentId) {
        request.resolve(null);
      } else {
        newQueue.push(request);
      }
    }
    this.rerankQueue = newQueue;

    return new Promise((resolve, reject) => {
      this.rerankQueue.push({
        componentId,
        query,
        results,
        topK,
        resolve,
        reject,
      });
      this.processRerankQueue();
    });
  }

  private async processRerankQueue(): Promise<void> {
    if (this.isProcessingRerank || this.rerankQueue.length === 0) {
      return;
    }

    this.isProcessingRerank = true;
    const request = this.rerankQueue.shift()!;

    try {
      const results = await this.executeRerank(
        request.query,
        request.results,
        request.topK
      );
      request.resolve(results);
    } catch (error) {
      request.reject(error);
    }

    this.isProcessingRerank = false;
    this.processRerankQueue();
  }

  private async executeRerank(
    query: string,
    results: SearchResult[],
    topK: number
  ): Promise<SearchResult[]> {
    const documents = results.map(r => r.topChunk.content);
    const rerankResults = await this.reranker.rerank(query, documents, topK);

    // Normalize scores to [0, 1]
    const maxScore = Math.max(...rerankResults.map(r => r.relevanceScore));
    const minScore = Math.min(...rerankResults.map(r => r.relevanceScore));
    const scoreRange = maxScore - minScore;

    return rerankResults.map(r => ({
      ...results[r.index],
      score: scoreRange > 0 ? (r.relevanceScore - minScore) / scoreRange : 1,
    }));
  }

  /**
   * Search with chunk-based reranking (direct execution, no queue).
   * Retrieves chunks from BM25 and Embedding, merges, reranks, then aggregates.
   */
  async searchWithChunkRerank(
    query: string,
    options: SearchOptionsWithTopK
  ): Promise<ChunkRerankResult | null> {
    if (!this.reranker.isReady()) {
      return null;
    }
    return this.executeChunkRerank(query, options);
  }

  /**
   * Execute chunk-based reranking.
   * 1. Get content chunks from BM25 and Embedding
   * 2. Merge and deduplicate
   * 3. Rerank with title prepended to each chunk
   * 4. Aggregate to file-level results
   */
  private async executeChunkRerank(
    query: string,
    options: SearchOptionsWithTopK
  ): Promise<ChunkRerankResult> {
    const totalStart = performance.now();

    const embeddingWeight = options.embeddingWeight ?? 0.6;
    const bm25Weight = options.bm25Weight ?? 0.4;
    const totalWeight = embeddingWeight + bm25Weight;

    const retrievalMultiplier = this.configManager.get('retrievalMultiplier');
    const retrievalLimit = options.topK * retrievalMultiplier;

    // Distribute retrievalLimit based on embedding/bm25 weights
    const embeddingLimit = Math.round(
      (retrievalLimit * embeddingWeight) / totalWeight
    );
    const bm25Limit = Math.round((retrievalLimit * bm25Weight) / totalWeight);

    // Get content chunks from both sources
    const retrievalStart = performance.now();
    const [embeddingChunks, bm25Chunks] = await Promise.all([
      embeddingWeight > 0
        ? this.embeddingSearch.searchContent(query, {
            ...options,
            retrievalLimit: embeddingLimit,
          })
        : Promise.resolve([]),
      bm25Weight > 0
        ? this.bm25Search.searchContent(query, {
            ...options,
            retrievalLimit: bm25Limit,
          })
        : Promise.resolve([]),
    ]);
    const retrievalTimeMs = performance.now() - retrievalStart;

    // Merge and deduplicate
    const mergedChunks = mergeAndDeduplicateChunks(embeddingChunks, bm25Chunks);

    if (mergedChunks.length === 0) {
      return {
        results: [],
        metadata: {
          embeddingChunkCount: 0,
          bm25ChunkCount: 0,
          mergedChunkCount: 0,
          retrievalTimeMs,
          rerankTimeMs: 0,
          totalTimeMs: performance.now() - totalStart,
        },
      };
    }

    // Rerank all chunks (optionally with title prepended for better relevance)
    const rerankStart = performance.now();
    const prependTitle = options.prependTitleToChunks ?? true;
    const documents = mergedChunks.map(c => {
      if (!prependTitle) return c.content;
      const title = c.metadata.title || '';
      return title ? `${title}\n\n${c.content}` : c.content;
    });
    const rerankResults = await this.reranker.rerank(query, documents);
    const rerankTimeMs = performance.now() - rerankStart;

    // Update chunk scores with rerank scores
    const rerankedChunks: ChunkResult[] = rerankResults.map(r => ({
      ...mergedChunks[r.index],
      score: r.relevanceScore,
    }));

    // Aggregate to file-level results
    const aggOptions = {
      method: this.configManager.get('vectorAggMethod'),
      m: this.configManager.get('aggM'),
      l: this.configManager.get('aggL'),
      decay: this.configManager.get('aggDecay'),
      rrfK: this.configManager.get('aggRrfK'),
    };
    const results = aggregateChunksToFiles(rerankedChunks, aggOptions);

    // Normalize scores to [0, 1]
    if (results.length > 0) {
      const maxScore = results[0].score;
      const minScore = results[results.length - 1].score;
      const scoreRange = maxScore - minScore;
      for (const result of results) {
        result.score =
          scoreRange > 0 ? (result.score - minScore) / scoreRange : 1;
      }
    }

    return {
      results: results.slice(0, options.topK),
      metadata: {
        embeddingChunkCount: embeddingChunks.length,
        bm25ChunkCount: bm25Chunks.length,
        mergedChunkCount: mergedChunks.length,
        retrievalTimeMs,
        rerankTimeMs,
        totalTimeMs: performance.now() - totalStart,
      },
    };
  }

  /**
   * Hybrid search for title (returns file-level results directly)
   */
  private async hybridTitleSearch(
    query: string,
    embeddingWeight: number,
    bm25Weight: number,
    options: SearchOptionsWithTopK
  ): Promise<SearchResult[]> {
    const retrievalMultiplier = this.configManager.get('retrievalMultiplier');
    const retrievalLimit = options.topK * retrievalMultiplier;
    const fullOptions = { ...options, retrievalLimit };

    const [embeddingResults, bm25Results] = await Promise.all([
      embeddingWeight > 0
        ? this.embeddingSearch.searchTitle(query, fullOptions)
        : Promise.resolve([]),
      bm25Weight > 0
        ? this.bm25Search.searchTitle(query, fullOptions)
        : Promise.resolve([]),
    ]);

    if (embeddingWeight === 0) return bm25Results;
    if (bm25Weight === 0) return embeddingResults;

    return fuseFileResults(
      embeddingResults,
      bm25Results,
      embeddingWeight,
      bm25Weight
    );
  }

  /**
   * Hybrid search for content (aggregates chunk-level to file-level)
   */
  private async hybridContentSearch(
    query: string,
    embeddingWeight: number,
    bm25Weight: number,
    options: SearchOptionsWithTopK
  ): Promise<SearchResult[]> {
    const retrievalMultiplier = this.configManager.get('retrievalMultiplier');
    const retrievalLimit = options.topK * retrievalMultiplier;
    const fullOptions = { ...options, retrievalLimit };

    const [embeddingChunks, bm25Chunks] = await Promise.all([
      embeddingWeight > 0
        ? this.embeddingSearch.searchContent(query, fullOptions)
        : Promise.resolve([]),
      bm25Weight > 0
        ? this.bm25Search.searchContent(query, fullOptions)
        : Promise.resolve([]),
    ]);

    const aggOptions = {
      method: this.configManager.get('vectorAggMethod'),
      m: this.configManager.get('aggM'),
      l: this.configManager.get('aggL'),
      decay: this.configManager.get('aggDecay'),
      rrfK: this.configManager.get('aggRrfK'),
    };
    const bm25AggOptions = {
      ...aggOptions,
      method: this.configManager.get('bm25AggMethod'),
    };

    const embeddingResults = aggregateChunksToFiles(
      embeddingChunks,
      aggOptions
    );
    const bm25Results = aggregateChunksToFiles(bm25Chunks, bm25AggOptions);

    if (embeddingWeight === 0) return bm25Results;
    if (bm25Weight === 0) return embeddingResults;

    return fuseFileResults(
      embeddingResults,
      bm25Results,
      embeddingWeight,
      bm25Weight
    );
  }

  /**
   * Retrieve reranked chunks for RAG context building.
   * Returns chunk-level results sorted by rerank score (not aggregated to files).
   *
   * @param query Search query
   * @param maxChunks Maximum number of chunks to return
   * @returns Reranked chunks, or null if reranker is not ready
   */
  async getRerankedChunksForRAG(
    query: string,
    maxChunks: number
  ): Promise<ChunkResult[] | null> {
    if (!this.reranker.isReady()) {
      return null;
    }

    const retrievalMultiplier = this.configManager.get('retrievalMultiplier');
    const retrievalLimit = maxChunks * retrievalMultiplier;

    // Distribute based on default weights (0.6 embedding, 0.4 bm25)
    const embeddingLimit = Math.ceil(retrievalLimit * 0.6);
    const bm25Limit = Math.ceil(retrievalLimit * 0.4);

    // Get chunks from both sources
    const [embeddingChunks, bm25Chunks] = await Promise.all([
      this.embeddingSearch.searchContent(query, {
        topK: maxChunks,
        retrievalLimit: embeddingLimit,
      }),
      this.bm25Search.searchContent(query, {
        topK: maxChunks,
        retrievalLimit: bm25Limit,
      }),
    ]);

    // Merge and deduplicate
    const mergedChunks = mergeAndDeduplicateChunks(embeddingChunks, bm25Chunks);

    if (mergedChunks.length === 0) {
      return [];
    }

    // Rerank with title prepended
    const documents = mergedChunks.map(c => {
      const title = c.metadata.title || '';
      return title ? `${title}\n\n${c.content}` : c.content;
    });

    const rerankResults = await this.reranker.rerank(
      query,
      documents,
      maxChunks
    );

    // Return reranked chunks
    return rerankResults.map(r => ({
      ...mergedChunks[r.index],
      score: r.relevanceScore,
    }));
  }

  /**
   * Cancel all pending requests from a component.
   * Use this when a component is being destroyed (e.g., modal closing).
   */
  cancelPendingRequests(componentId: string): void {
    const newSearchQueue: QueuedSearchRequest[] = [];
    for (const request of this.searchQueue) {
      if (request.componentId === componentId) {
        request.resolve(null);
      } else {
        newSearchQueue.push(request);
      }
    }
    this.searchQueue = newSearchQueue;

    const newRerankQueue: QueuedRerankRequest[] = [];
    for (const request of this.rerankQueue) {
      if (request.componentId === componentId) {
        request.resolve(null);
      } else {
        newRerankQueue.push(request);
      }
    }
    this.rerankQueue = newRerankQueue;
  }
}
