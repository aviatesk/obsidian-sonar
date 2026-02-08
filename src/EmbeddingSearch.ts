import { EmbeddingStore } from './EmbeddingStore';
import { MetadataStore, type ChunkMetadata } from './MetadataStore';
import type { LlamaCppEmbedder } from './LlamaCppEmbedder';
import { ConfigManager } from './ConfigManager';
import {
  matchesFolderFilters,
  type ChunkResult,
  type SearchResult,
  type FullSearchOptions,
} from './SearchManager';
import { WithLogging } from './WithLogging';
import { hasNaNEmbedding, countNaNValues } from './utils';
import { ChunkId } from './chunkId';

interface CombinedChunk {
  id: string;
  content: string;
  embedding: number[];
  metadata: ChunkMetadata;
}

function cosineSimilarity(vec1: number[], vec2: number[]): number {
  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;
  for (let i = 0; i < vec1.length; i++) {
    dotProduct += vec1[i] * vec2[i];
    norm1 += vec1[i] * vec1[i];
    norm2 += vec2[i] * vec2[i];
  }
  if (norm1 === 0 || norm2 === 0) {
    return 0;
  }
  return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
}

/**
 * Pure embedding-based semantic search
 * Returns results in the same format as BM25Search for easy integration
 * Supports separate title and content search
 */
export class EmbeddingSearch extends WithLogging {
  protected readonly componentName = 'EmbeddingSearch';

  constructor(
    private metadataStore: MetadataStore,
    private embeddingStore: EmbeddingStore,
    private embedder: LlamaCppEmbedder,
    protected configManager: ConfigManager
  ) {
    super();
    this.log('Initialized');
  }

  /**
   * Combines metadata and embeddings into a unified view for search
   * Filters by type: 'title' returns only title entries, 'content' returns only chunk entries
   */
  private async getCombinedChunks(
    type?: 'title' | 'content'
  ): Promise<CombinedChunk[]> {
    const [metadata, embeddings] = await Promise.all([
      this.metadataStore.getAllChunks(),
      this.embeddingStore.getAllEmbeddings(),
    ]);

    const combined: CombinedChunk[] = [];

    const filteredEmbeddings = embeddings.filter(emb => {
      const isTitle = ChunkId.isTitle(emb.id);
      if (type === 'title') return isTitle;
      if (type === 'content') return !isTitle;
      return true;
    });

    const metadataById = new Map<string, ChunkMetadata>();
    const metadataByFilePath = new Map<string, ChunkMetadata>();
    for (const meta of metadata) {
      metadataById.set(meta.id, meta);
      if (!metadataByFilePath.has(meta.filePath)) {
        metadataByFilePath.set(meta.filePath, meta);
      }
    }

    for (const emb of filteredEmbeddings) {
      // For title entries, find the first chunk metadata of the file
      // For content entries, use the exact metadata match
      let meta: ChunkMetadata | undefined;
      if (ChunkId.isTitle(emb.id)) {
        const filePath = ChunkId.getFilePath(emb.id);
        meta = metadataByFilePath.get(filePath);
      } else {
        meta = metadataById.get(emb.id);
      }

      if (meta) {
        combined.push({
          id: emb.id,
          content: ChunkId.isTitle(emb.id) ? meta.title : meta.content,
          embedding: emb.embedding,
          metadata: meta,
        });
      }
    }

    return combined;
  }

  /**
   * Search title only (searches title embeddings: path#title entries)
   */
  async searchTitle(
    query: string,
    options: FullSearchOptions
  ): Promise<SearchResult[]> {
    const scored = await this.searchChunks(query, 'title', options);

    return scored.slice(0, options.retrievalLimit).map(result => ({
      filePath: result.chunk.metadata.filePath,
      title: result.chunk.metadata.title || result.chunk.metadata.filePath,
      score: result.score,
      topChunk: {
        content: result.chunk.content,
        score: result.score,
        metadata: result.chunk.metadata,
      },
      chunkCount: 1,
      fileSize: result.chunk.metadata.size,
    }));
  }

  /**
   * Search content only (searches chunk embeddings: path#0, path#1, ... entries)
   */
  async searchContent(
    query: string,
    options: FullSearchOptions
  ): Promise<ChunkResult[]> {
    const scored = await this.searchChunks(query, 'content', options);

    return scored.slice(0, options.retrievalLimit).map(result => ({
      chunkId: result.chunk.id,
      filePath: result.chunk.metadata.filePath,
      chunkIndex: ChunkId.getChunkIndex(result.chunk.id),
      content: result.chunk.content,
      score: result.score,
      metadata: result.chunk.metadata,
    }));
  }

  /**
   * Core search: compute similarity scores for chunks of given type
   */
  private async searchChunks(
    query: string,
    type: 'title' | 'content',
    options: FullSearchOptions
  ): Promise<Array<{ chunk: CombinedChunk; score: number }>> {
    const queryEmbeddings = await this.embedder.getEmbeddings([query]);
    const queryEmbedding = queryEmbeddings[0];

    const chunks = await this.getCombinedChunks(type);

    const chunksWithNaN = chunks.filter(chunk =>
      hasNaNEmbedding(chunk.embedding)
    );
    if (chunksWithNaN.length > 0) {
      const errorMsg = `Found ${chunksWithNaN.length} chunk(s) with NaN embeddings in database. Rebuild search index to fix this issue.`;
      const chunkList = chunksWithNaN
        .slice(0, 5)
        .map(
          chunk =>
            `${chunk.id} (${countNaNValues(chunk.embedding)}/${chunk.embedding.length} NaN)`
        )
        .join(', ');
      const fullMsg =
        chunksWithNaN.length <= 5
          ? `${errorMsg} Chunks: ${chunkList}`
          : `${errorMsg} First 5: ${chunkList}`;
      this.error(fullMsg);
      throw new Error(fullMsg);
    }

    let filteredChunks = chunks;
    if (options?.excludeFilePath) {
      filteredChunks = filteredChunks.filter(
        chunk => chunk.metadata.filePath !== options.excludeFilePath
      );
    }
    filteredChunks = filteredChunks.filter(chunk =>
      matchesFolderFilters(chunk.metadata.filePath, options)
    );

    const results = filteredChunks.map(chunk => ({
      chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }));

    results.sort((a, b) => b.score - a.score);
    return results;
  }
}
