import { EmbeddingStore } from './EmbeddingStore';
import { MetadataStore, type DocumentMetadata } from './MetadataStore';
import type { Embedder } from './Embedder';
import { ConfigManager } from './ConfigManager';
import type { SearchResult, SearchOptions } from './SearchManager';
import { WithLogging } from './WithLogging';
import { aggregateChunkScores } from './ChunkAggregation';

interface CombinedDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata: DocumentMetadata;
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
    private embedder: Embedder,
    protected configManager: ConfigManager
  ) {
    super();
    this.log('Initialized');
  }

  /**
   * Combines metadata and embeddings into a unified view for search
   * Filters by type: 'title' returns only title entries, 'content' returns only chunk entries
   */
  private async getCombinedDocuments(
    type?: 'title' | 'content'
  ): Promise<CombinedDocument[]> {
    const [metadata, embeddings] = await Promise.all([
      this.metadataStore.getAllDocuments(),
      this.embeddingStore.getAllEmbeddings(),
    ]);

    const combined: CombinedDocument[] = [];

    // Filter embeddings by type
    const filteredEmbeddings = embeddings.filter(emb => {
      const isTitle = emb.id.endsWith('#title');
      if (type === 'title') return isTitle;
      if (type === 'content') return !isTitle;
      return true; // no filter
    });

    for (const emb of filteredEmbeddings) {
      // For title entries, find the first chunk metadata of the file
      // For content entries, use the exact metadata match
      let meta: DocumentMetadata | undefined;
      if (emb.id.endsWith('#title')) {
        const filePath = emb.id.replace(/#title$/, '');
        meta = metadata.find(m => m.filePath === filePath);
      } else {
        meta = metadata.find(m => m.id === emb.id);
      }

      if (meta) {
        combined.push({
          id: emb.id,
          content: emb.id.endsWith('#title') ? meta.title : meta.content,
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
    topK: number,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    return this.searchByType(query, topK, 'title', options);
  }

  /**
   * Search content only (searches chunk embeddings: path#0, path#1, ... entries)
   */
  async searchContent(
    query: string,
    topK: number,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    return this.searchByType(query, topK, 'content', options);
  }

  /**
   * Core search implementation for a specific type (title or content)
   */
  private async searchByType(
    query: string,
    topK: number,
    type: 'title' | 'content',
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    const queryEmbeddings = await this.embedder.getEmbeddings([query], 'query');
    const queryEmbedding = queryEmbeddings[0];

    const documents = await this.getCombinedDocuments(type);

    let filteredDocuments = documents;
    if (options?.excludeFilePath) {
      filteredDocuments = documents.filter(
        doc => doc.metadata.filePath !== options.excludeFilePath
      );
    }

    const results = filteredDocuments.map(doc => {
      const similarity = cosineSimilarity(queryEmbedding, doc.embedding);
      return {
        document: doc,
        score: similarity,
      };
    });

    results.sort((a, b) => b.score - a.score);

    if (type === 'title') {
      // For title search, return one result per file (no aggregation needed)
      const topResults = results.slice(0, topK);
      return topResults.map(result => ({
        filePath: result.document.metadata.filePath,
        title:
          result.document.metadata.title || result.document.metadata.filePath,
        score: result.score,
        topChunk: {
          content: result.document.content,
          score: result.score,
          metadata: result.document.metadata,
        },
        chunkCount: 1,
        fileSize: result.document.metadata.size,
      }));
    } else {
      // For content search, aggregate chunks by file
      const chunkTopKMultiplier = this.configManager.get('chunkTopKMultiplier');
      const chunkCount = options?.chunkTopK ?? topK * chunkTopKMultiplier;
      const topResults = results.slice(0, chunkCount);

      const groupedByFile = new Map<string, typeof results>();
      for (const result of topResults) {
        const filePath = result.document.metadata.filePath;
        if (!groupedByFile.has(filePath)) {
          groupedByFile.set(filePath, []);
        }
        groupedByFile.get(filePath)!.push(result);
      }

      // Prepare file scores for aggregation
      const fileScores = new Map<string, number[]>();
      for (const [filePath, chunks] of groupedByFile.entries()) {
        chunks.sort((a, b) => b.score - a.score);
        fileScores.set(
          filePath,
          chunks.map(c => c.score)
        );
      }

      // Aggregate chunk scores using configured method
      const vectorAggMethod = this.configManager.get('vectorAggMethod');
      const aggM = this.configManager.get('aggM');
      const aggL = this.configManager.get('aggL');
      const aggDecay = this.configManager.get('aggDecay');
      const aggRrfK = this.configManager.get('aggRrfK');

      const aggregatedScores = aggregateChunkScores(fileScores, {
        method: vectorAggMethod,
        m: aggM,
        l: aggL,
        decay: aggDecay,
        rrfK: aggRrfK,
      });

      const aggregated: SearchResult[] = [];
      for (const [filePath, aggregatedScore] of aggregatedScores.entries()) {
        const chunks = groupedByFile.get(filePath)!;
        const topChunk = chunks[0];

        aggregated.push({
          filePath,
          title: topChunk.document.metadata.title || filePath,
          score: aggregatedScore,
          topChunk: {
            content: topChunk.document.content,
            score: topChunk.score,
            metadata: topChunk.document.metadata,
          },
          chunkCount: chunks.length,
          fileSize: topChunk.document.metadata.size,
        });
      }

      aggregated.sort((a, b) => b.score - a.score);

      return aggregated.slice(0, topK);
    }
  }
}
