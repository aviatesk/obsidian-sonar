import { EmbeddingStore } from './EmbeddingStore';
import { MetadataStore, type DocumentMetadata } from './MetadataStore';
import { OllamaClient } from './OllamaClient';
import { ConfigManager } from './ConfigManager';
import type { SearchResult, SearchOptions } from './SearchManager';

interface CombinedDocument {
  id: string;
  content: string;
  embedding: number[];
  titleEmbedding: number[];
  metadata: DocumentMetadata;
}

const L = 3;
const MULTIPLIER = 4;

function aggregateWeightedDecay(scoresDesc: number[], decay: number): number {
  let w = 1,
    acc = 0;
  for (let i = 0; i < Math.min(L, scoresDesc.length); i++) {
    acc += w * scoresDesc[i];
    w *= decay;
  }
  return acc;
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
export class EmbeddingSearch {
  constructor(
    private metadataStore: MetadataStore,
    private embeddingStore: EmbeddingStore,
    private ollamaClient: OllamaClient,
    private configManager: ConfigManager
  ) {}

  /**
   * Combines metadata and embeddings into a unified view for search
   */
  private async getCombinedDocuments(): Promise<CombinedDocument[]> {
    const [metadata, embeddings] = await Promise.all([
      this.metadataStore.getAllDocuments(),
      this.embeddingStore.getAllEmbeddings(),
    ]);

    const embeddingMap = new Map(embeddings.map(e => [e.id, e]));
    const combined: CombinedDocument[] = [];

    for (const meta of metadata) {
      const emb = embeddingMap.get(meta.id);
      if (emb) {
        combined.push({
          id: meta.id,
          content: meta.content,
          embedding: emb.embedding,
          titleEmbedding: emb.titleEmbedding,
          metadata: meta,
        });
      }
    }

    return combined;
  }

  /**
   * Search title only
   */
  async searchTitle(
    query: string,
    topK: number,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    return this.search(query, topK, {
      ...options,
      titleWeight: 1,
      contentWeight: 0,
    });
  }

  /**
   * Search content only
   */
  async searchContent(
    query: string,
    topK: number,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    return this.search(query, topK, {
      ...options,
      titleWeight: 0,
      contentWeight: 1,
    });
  }

  /**
   * Embedding search with title and content weighting
   */
  async search(
    query: string,
    topK: number,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    const queryEmbeddings = await this.ollamaClient.getEmbeddings([query]);
    const queryEmbedding = queryEmbeddings[0];

    const documents = await this.getCombinedDocuments();

    let filteredDocuments = documents;
    if (options?.excludeFilePath) {
      filteredDocuments = documents.filter(
        doc => doc.metadata.filePath !== options.excludeFilePath
      );
    }

    const titleWeight = options?.titleWeight ?? 0;
    const contentWeight = options?.contentWeight ?? 1;
    const scoreDecay = this.configManager.get('scoreDecay');

    const results = filteredDocuments.map(doc => {
      const contentSimilarity = cosineSimilarity(queryEmbedding, doc.embedding);
      const titleSimilarity = cosineSimilarity(
        queryEmbedding,
        doc.titleEmbedding
      );
      const score =
        contentWeight * contentSimilarity + titleWeight * titleSimilarity;
      return {
        document: doc,
        score,
      };
    });

    results.sort((a, b) => b.score - a.score);
    const topResults = results.slice(0, topK * MULTIPLIER);

    const groupedByFile = new Map<string, typeof results>();
    for (const result of topResults) {
      const filePath = result.document.metadata.filePath;
      if (!groupedByFile.has(filePath)) {
        groupedByFile.set(filePath, []);
      }
      groupedByFile.get(filePath)!.push(result);
    }

    const aggregated: SearchResult[] = [];
    for (const [filePath, chunks] of groupedByFile.entries()) {
      chunks.sort((a, b) => b.score - a.score);
      const scores = chunks.map(c => c.score);
      const aggregatedScore = aggregateWeightedDecay(scores, scoreDecay);
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

    // Calculate theoretical maximum considering title/content weights
    // Max chunk score = titleWeight + contentWeight
    const maxChunkScore = titleWeight + contentWeight;
    let maxTheoreticalScore = 0;
    let weight = maxChunkScore;
    for (let i = 0; i < L; i++) {
      maxTheoreticalScore += weight;
      weight *= scoreDecay;
    }

    // Normalize to [0, 1]
    if (maxTheoreticalScore > 0) {
      for (const result of aggregated) {
        result.score = result.score / maxTheoreticalScore;
      }
    }

    return aggregated.slice(0, topK);
  }
}
