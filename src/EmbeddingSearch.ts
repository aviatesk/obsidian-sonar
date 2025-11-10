import { EmbeddingStore } from './EmbeddingStore';
import { MetadataStore, type DocumentMetadata } from './MetadataStore';
import type { Embedder } from './Embedder';
import { ConfigManager } from './ConfigManager';
import type { SearchResult, FullSearchOptions } from './SearchManager';
import { WithLogging } from './WithLogging';
import { aggregateChunkScores } from './ChunkAggregation';
import { hasNaNEmbedding, countNaNValues } from './Utils';

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

    const metadataById = new Map<string, DocumentMetadata>();
    const metadataByFilePath = new Map<string, DocumentMetadata>();
    for (const meta of metadata) {
      metadataById.set(meta.id, meta);
      if (!metadataByFilePath.has(meta.filePath)) {
        metadataByFilePath.set(meta.filePath, meta);
      }
    }

    for (const emb of filteredEmbeddings) {
      // For title entries, find the first chunk metadata of the file
      // For content entries, use the exact metadata match
      let meta: DocumentMetadata | undefined;
      if (emb.id.endsWith('#title')) {
        const filePath = emb.id.replace(/#title$/, '');
        meta = metadataByFilePath.get(filePath);
      } else {
        meta = metadataById.get(emb.id);
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
   * Computes similarity for all title embeddings, returns all results sorted by score
   */
  async searchTitle(
    query: string,
    options: FullSearchOptions
  ): Promise<SearchResult[]> {
    return this.searchByType(query, 'title', options);
  }

  /**
   * Search content only (searches chunk embeddings: path#0, path#1, ... entries)
   * Computes similarity for all chunks, aggregates by file, returns all documents sorted by score
   */
  async searchContent(
    query: string,
    options: FullSearchOptions
  ): Promise<SearchResult[]> {
    return this.searchByType(query, 'content', options);
  }

  /**
   * Core search implementation for a specific type (title or content)
   * Computes similarity for all chunks, aggregates, and returns all results
   */
  private async searchByType(
    query: string,
    type: 'title' | 'content',
    options: FullSearchOptions
  ): Promise<SearchResult[]> {
    const queryEmbeddings = await this.embedder.getEmbeddings([query]);
    const queryEmbedding = queryEmbeddings[0];

    const documents = await this.getCombinedDocuments(type);

    // Check for NaN embeddings in stored documents
    const docsWithNaN = documents.filter(doc => hasNaNEmbedding(doc.embedding));
    if (docsWithNaN.length > 0) {
      const errorMsg = `Found ${docsWithNaN.length} document(s) with NaN embeddings in database. Rebuild index to fix this issue.`;
      const docList = docsWithNaN
        .slice(0, 5)
        .map(
          doc =>
            `${doc.id} (${countNaNValues(doc.embedding)}/${doc.embedding.length} NaN)`
        )
        .join(', ');
      const fullMsg =
        docsWithNaN.length <= 5
          ? `${errorMsg} Documents: ${docList}`
          : `${errorMsg} First 5: ${docList}`;
      this.error(fullMsg);
      throw new Error(fullMsg);
    }

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

    // Apply chunk-level limit before aggregation
    const chunksToAggregate = results.slice(0, options.retrievalLimit);

    if (type === 'title') {
      // For title search, return all results (one per file, no aggregation needed)
      return chunksToAggregate.map(result => ({
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
      // For content search, aggregate chunks by file (after chunk-level limiting)
      const groupedByFile = new Map<string, typeof results>();
      for (const result of chunksToAggregate) {
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

      // Return all aggregated documents (no topK limit)
      return aggregated;
    }
  }
}
