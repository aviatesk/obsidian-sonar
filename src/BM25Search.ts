import { BM25Store } from './BM25Store';
import { MetadataStore } from './MetadataStore';
import type { SearchResult, FullSearchOptions } from './SearchManager';
import type { ConfigManager } from './ConfigManager';
import { WithLogging } from './WithLogging';
import { aggregateChunkScores } from './ChunkAggregation';
import { ChunkId } from './chunkId';

/**
 * BM25 full-text search interface
 * Returns results in the same format as EmbeddingSearch for easy integration
 * Supports separate title and content search
 */
export class BM25Search extends WithLogging {
  protected readonly componentName = 'BM25Search';

  constructor(
    private bm25Store: BM25Store,
    private metadataStore: MetadataStore,
    protected configManager: ConfigManager
  ) {
    super();
    this.log('Initialized');
  }

  /**
   * Search title only
   * Computes BM25 for all titles, returns all results sorted by score
   */
  async searchTitle(
    query: string,
    options: FullSearchOptions
  ): Promise<SearchResult[]> {
    const bm25Results = await this.bm25Store.search(
      query,
      Number.MAX_SAFE_INTEGER
    );

    if (bm25Results.length === 0) {
      return [];
    }

    // Filter only title results and extract filePath
    const titleScores = new Map<string, number>();
    for (const result of bm25Results) {
      if (ChunkId.isTitle(result.docId)) {
        const filePath = ChunkId.getFilePath(result.docId);
        if (options?.excludeFilePath && filePath === options.excludeFilePath) {
          continue;
        }
        titleScores.set(filePath, result.score);
      }
    }

    return this.createSearchResults(titleScores);
  }

  /**
   * Search content only
   * ChunkId format: "filePath#0", "filePath#1", ...
   * Computes BM25 for all chunks, aggregates by file, returns all documents sorted by score
   */
  async searchContent(
    query: string,
    options: FullSearchOptions
  ): Promise<SearchResult[]> {
    const bm25Results = await this.bm25Store.search(
      query,
      Number.MAX_SAFE_INTEGER
    );

    if (bm25Results.length === 0) {
      return [];
    }

    // Filter only content chunks
    const contentChunks = bm25Results.filter(
      result => !ChunkId.isTitle(result.docId)
    );

    // Apply chunk-level limit before aggregation
    const chunksToAggregate = contentChunks.slice(0, options.retrievalLimit);

    // Aggregate by filePath
    const fileScores = new Map<string, number[]>();
    for (const result of chunksToAggregate) {
      const filePath = ChunkId.getFilePath(result.docId);
      if (options?.excludeFilePath && filePath === options.excludeFilePath) {
        continue;
      }
      if (!fileScores.has(filePath)) {
        fileScores.set(filePath, []);
      }
      fileScores.get(filePath)!.push(result.score);
    }

    // Aggregate chunk scores using configured method
    const bm25AggMethod = this.configManager.get('bm25AggMethod');
    const aggM = this.configManager.get('aggM');
    const aggL = this.configManager.get('aggL');
    const aggDecay = this.configManager.get('aggDecay');
    const aggRrfK = this.configManager.get('aggRrfK');

    const aggregatedScores = aggregateChunkScores(fileScores, {
      method: bm25AggMethod,
      m: aggM,
      l: aggL,
      decay: aggDecay,
      rrfK: aggRrfK,
    });

    return this.createSearchResults(aggregatedScores);
  }

  /**
   * Helper to create SearchResult array from score map
   * Returns all results sorted by score (no limit)
   */
  private async createSearchResults(
    scoreMap: Map<string, number>
  ): Promise<SearchResult[]> {
    if (scoreMap.size === 0) {
      return [];
    }

    const allChunks = await this.metadataStore.getAllChunks();
    const chunksByFilePath = new Map<string, typeof allChunks>();

    for (const chunk of allChunks) {
      const filePath = chunk.filePath;
      if (!chunksByFilePath.has(filePath)) {
        chunksByFilePath.set(filePath, []);
      }
      chunksByFilePath.get(filePath)!.push(chunk);
    }

    // Convert to SearchResult format
    const searchResults: SearchResult[] = [];

    for (const [filePath, score] of scoreMap.entries()) {
      const fileChunks = chunksByFilePath.get(filePath);
      if (!fileChunks || fileChunks.length === 0) continue;

      const topChunk = fileChunks[0];

      searchResults.push({
        filePath,
        title: topChunk.title || filePath,
        score,
        topChunk: {
          content: topChunk.content,
          score,
          metadata: topChunk,
        },
        chunkCount: fileChunks.length,
        fileSize: topChunk.size,
      });
    }

    // Sort by score and return all results (no topK limit)
    searchResults.sort((a, b) => b.score - a.score);

    return searchResults;
  }
}
