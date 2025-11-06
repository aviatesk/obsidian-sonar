import { BM25Store } from './BM25Store';
import { MetadataStore } from './MetadataStore';
import type { SearchResult, SearchOptions } from './SearchManager';
import type { ConfigManager } from './ConfigManager';
import { WithLogging } from './WithLogging';
import { aggregateChunkScores } from './ChunkAggregation';

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
   * ChunkId format: "filePath#title"
   */
  async searchTitle(
    query: string,
    topK: number,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    const chunkTopKMultiplier = this.configManager.get('chunkTopKMultiplier');
    const chunkCount = options?.chunkTopK ?? topK * chunkTopKMultiplier;
    const bm25Results = await this.bm25Store.search(query, chunkCount);

    if (bm25Results.length === 0) {
      return [];
    }

    // Filter only title results and extract filePath
    const titleScores = new Map<string, number>();
    for (const result of bm25Results) {
      const chunkId = result.docId;
      if (chunkId.endsWith('#title')) {
        const filePath = this.extractFilePathFromChunkId(chunkId);
        titleScores.set(filePath, result.score);
      }
    }

    return this.createSearchResults(titleScores, topK);
  }

  /**
   * Search content only
   * ChunkId format: "filePath#0", "filePath#1", ...
   */
  async searchContent(
    query: string,
    topK: number,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    const chunkTopKMultiplier = this.configManager.get('chunkTopKMultiplier');
    const chunkCount = options?.chunkTopK ?? topK * chunkTopKMultiplier;
    const bm25Results = await this.bm25Store.search(query, chunkCount);

    if (bm25Results.length === 0) {
      return [];
    }

    // Filter only content chunks and aggregate by filePath
    const fileScores = new Map<string, number[]>();
    for (const result of bm25Results) {
      const chunkId = result.docId;
      if (!chunkId.endsWith('#title')) {
        const filePath = this.extractFilePathFromChunkId(chunkId);

        if (!fileScores.has(filePath)) {
          fileScores.set(filePath, []);
        }
        fileScores.get(filePath)!.push(result.score);
      }
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

    return this.createSearchResults(aggregatedScores, topK);
  }

  /**
   * Helper to create SearchResult array from score map
   */
  private async createSearchResults(
    scoreMap: Map<string, number>,
    topK: number
  ): Promise<SearchResult[]> {
    if (scoreMap.size === 0) {
      return [];
    }

    const allDocuments = await this.metadataStore.getAllDocuments();
    const docsByFilePath = new Map<string, typeof allDocuments>();

    for (const doc of allDocuments) {
      const filePath = doc.filePath;
      if (!docsByFilePath.has(filePath)) {
        docsByFilePath.set(filePath, []);
      }
      docsByFilePath.get(filePath)!.push(doc);
    }

    // Convert to SearchResult format
    const searchResults: SearchResult[] = [];

    for (const [filePath, score] of scoreMap.entries()) {
      const fileDocs = docsByFilePath.get(filePath);
      if (!fileDocs || fileDocs.length === 0) continue;

      const topDoc = fileDocs[0];

      searchResults.push({
        filePath,
        title: topDoc.title || filePath,
        score,
        topChunk: {
          content: topDoc.content,
          score,
          metadata: topDoc,
        },
        chunkCount: fileDocs.length,
        fileSize: topDoc.size,
      });
    }

    // Sort by score and limit to topK
    searchResults.sort((a, b) => b.score - a.score);

    return searchResults.slice(0, topK);
  }

  /**
   * Extract filePath from chunkId
   * Format: "filePath#title" or "filePath#chunkIndex"
   */
  private extractFilePathFromChunkId(chunkId: string): string {
    const lastHashIndex = chunkId.lastIndexOf('#');
    return chunkId.substring(0, lastHashIndex);
  }
}
