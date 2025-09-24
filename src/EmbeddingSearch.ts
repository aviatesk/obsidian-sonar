import { VectorStore, type DocumentMetadata } from './VectorStore';
import { OllamaClient } from './OllamaClient';

export interface SearchResult {
  content: string;
  score: number;
  metadata: DocumentMetadata;
}

export interface SearchOptions {
  excludeFilePath?: string;
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
 * Search-only interface for semantic search
 * All DB modifications should go through IndexManager
 */
export class EmbeddingSearch {
  constructor(
    private vectorStore: VectorStore,
    private ollamaClient: OllamaClient
  ) {}

  async search(
    query: string,
    topK: number = 5,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    const queryEmbeddings = await this.ollamaClient.getEmbeddings([query]);
    const queryEmbedding = queryEmbeddings[0];

    const documents = await this.vectorStore.getAllDocuments();

    let filteredDocuments = documents;
    if (options?.excludeFilePath) {
      filteredDocuments = documents.filter(
        doc => doc.metadata.filePath !== options.excludeFilePath
      );
    }

    const results = filteredDocuments.map(doc => ({
      document: doc,
      score: cosineSimilarity(queryEmbedding, doc.embedding),
    }));

    results.sort((a, b) => b.score - a.score);
    const topResults = results.slice(0, topK);

    return topResults.map(result => ({
      content: result.document.content,
      score: result.score,
      metadata: result.document.metadata,
    }));
  }

  async close(): Promise<void> {
    await this.vectorStore.close();
  }
}
