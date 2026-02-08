import { BM25Store } from './BM25Store';
import { MetadataStore } from './MetadataStore';
import {
  matchesFolderFilters,
  type ChunkResult,
  type SearchResult,
  type FullSearchOptions,
} from './SearchManager';
import type { ConfigManager } from './ConfigManager';
import { WithLogging } from './WithLogging';
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

    // Filter only title results and extract filePath with score
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

    if (titleScores.size === 0) {
      return [];
    }

    const allChunks = await this.metadataStore.getAllChunks();
    const titleChunkByPath = new Map<string, (typeof allChunks)[0]>();
    const chunkCountByFile = new Map<string, number>();

    for (const chunk of allChunks) {
      const filePath = chunk.filePath;
      chunkCountByFile.set(filePath, (chunkCountByFile.get(filePath) || 0) + 1);
      if (ChunkId.isTitle(chunk.id)) {
        titleChunkByPath.set(filePath, chunk);
      }
    }

    const results: SearchResult[] = [];
    for (const [filePath, score] of titleScores.entries()) {
      const titleChunk = titleChunkByPath.get(filePath);
      if (!titleChunk) continue;

      results.push({
        filePath,
        title: titleChunk.title || filePath,
        score,
        topChunk: {
          content: titleChunk.content,
          score,
          metadata: titleChunk,
        },
        chunkCount: chunkCountByFile.get(filePath) || 1,
        fileSize: titleChunk.size,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Search content only
   * ChunkId format: "filePath#0", "filePath#1", ...
   * Returns chunk-level results
   */
  async searchContent(
    query: string,
    options: FullSearchOptions
  ): Promise<ChunkResult[]> {
    const bm25Results = await this.bm25Store.search(
      query,
      Number.MAX_SAFE_INTEGER
    );

    if (bm25Results.length === 0) {
      return [];
    }

    const contentChunks = bm25Results.filter(result => {
      if (ChunkId.isTitle(result.docId)) return false;
      const filePath = ChunkId.getFilePath(result.docId);
      if (options?.excludeFilePath && filePath === options.excludeFilePath) {
        return false;
      }
      return matchesFolderFilters(filePath, options);
    });

    // Apply chunk-level limit
    const limitedChunks = contentChunks.slice(0, options.retrievalLimit);

    const allChunks = await this.metadataStore.getAllChunks();
    const metadataById = new Map(allChunks.map(c => [c.id, c]));

    const results: ChunkResult[] = [];
    for (const result of limitedChunks) {
      const metadata = metadataById.get(result.docId);
      if (!metadata) continue;

      results.push({
        chunkId: result.docId,
        filePath: ChunkId.getFilePath(result.docId),
        chunkIndex: ChunkId.getChunkIndex(result.docId),
        content: metadata.content,
        score: result.score,
        metadata,
      });
    }

    return results;
  }
}
