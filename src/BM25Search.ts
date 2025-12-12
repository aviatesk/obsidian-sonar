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

    // Group chunks by filePath with their scores and indices
    const chunksByFile = new Map<
      string,
      Array<{ chunkIndex: number; score: number }>
    >();
    for (const result of chunksToAggregate) {
      const filePath = ChunkId.getFilePath(result.docId);
      if (options?.excludeFilePath && filePath === options.excludeFilePath) {
        continue;
      }
      const chunkIndex = ChunkId.getChunkIndex(result.docId);
      if (!chunksByFile.has(filePath)) {
        chunksByFile.set(filePath, []);
      }
      chunksByFile.get(filePath)!.push({ chunkIndex, score: result.score });
    }

    // Extract scores for aggregation and find top chunk per file
    const fileScores = new Map<string, number[]>();
    const topChunkByFile = new Map<
      string,
      { chunkIndex: number; score: number }
    >();

    for (const [filePath, chunks] of chunksByFile.entries()) {
      chunks.sort((a, b) => b.score - a.score);
      fileScores.set(
        filePath,
        chunks.map(c => c.score)
      );
      topChunkByFile.set(filePath, chunks[0]);
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

    return this.createSearchResults(aggregatedScores, topChunkByFile);
  }

  /**
   * Helper to create SearchResult array from score map
   * When topChunkByFile is provided, uses the best-matching content chunk.
   * Otherwise, uses the title chunk (for title search).
   */
  private async createSearchResults(
    scoreMap: Map<string, number>,
    topChunkByFile?: Map<string, { chunkIndex: number; score: number }>
  ): Promise<SearchResult[]> {
    if (scoreMap.size === 0) {
      return [];
    }

    const allChunks = await this.metadataStore.getAllChunks();

    // Build maps for chunk lookup
    const titleChunkByPath = new Map<string, (typeof allChunks)[0]>();
    const contentChunkMap = new Map<
      string,
      Map<number, (typeof allChunks)[0]>
    >();
    const chunkCountByFile = new Map<string, number>();

    for (const chunk of allChunks) {
      const filePath = chunk.filePath;
      chunkCountByFile.set(filePath, (chunkCountByFile.get(filePath) || 0) + 1);

      if (ChunkId.isTitle(chunk.id)) {
        titleChunkByPath.set(filePath, chunk);
      } else {
        const chunkIndex = ChunkId.getChunkIndex(chunk.id);
        if (!contentChunkMap.has(filePath)) {
          contentChunkMap.set(filePath, new Map());
        }
        contentChunkMap.get(filePath)!.set(chunkIndex, chunk);
      }
    }

    const searchResults: SearchResult[] = [];

    for (const [filePath, fileScore] of scoreMap.entries()) {
      let topChunk: (typeof allChunks)[0] | undefined;
      let topChunkScore: number;

      if (topChunkByFile) {
        // Content search: use the best-matching chunk
        const topChunkInfo = topChunkByFile.get(filePath);
        if (!topChunkInfo) continue;

        const fileChunks = contentChunkMap.get(filePath);
        if (!fileChunks) continue;

        topChunk = fileChunks.get(topChunkInfo.chunkIndex);
        topChunkScore = topChunkInfo.score;
      } else {
        // Title search: use the title chunk
        topChunk = titleChunkByPath.get(filePath);
        topChunkScore = fileScore;
      }

      if (!topChunk) continue;

      searchResults.push({
        filePath,
        title: topChunk.title || filePath,
        score: fileScore,
        topChunk: {
          content: topChunk.content,
          score: topChunkScore,
          metadata: topChunk,
        },
        chunkCount: chunkCountByFile.get(filePath) || 1,
        fileSize: topChunk.size,
      });
    }

    searchResults.sort((a, b) => b.score - a.score);
    return searchResults;
  }
}
