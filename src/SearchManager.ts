import { EmbeddingSearch } from './EmbeddingSearch';
import { BM25Search } from './BM25Search';
import type { ChunkMetadata } from './MetadataStore';
import type { ConfigManager } from './ConfigManager';
import { WithLogging } from './WithLogging';
import {
  fuseFileResults,
  combineSearchResults,
  aggregateChunksToFiles,
} from './SearchResultFusion';

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
}
