import { VectorStore, DocumentMetadata } from './VectorStore';
import { OllamaClient } from './OllamaClient';

export interface SearchResult {
  content: string;
  score: number;
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
 * Search-only interface for semantic search
 * All DB modifications should go through IndexManager
 */
export class EmbeddingSearch {
  constructor(
    private vectorStore: VectorStore,
    private ollamaClient: OllamaClient
  ) {}

  async search(query: string, topK: number = 5): Promise<SearchResult[]> {
    // Get embedding for query
    const queryEmbeddings = await this.ollamaClient.getEmbeddings([query]);
    const queryEmbedding = queryEmbeddings[0];

    // Get all documents from store
    const documents = await this.vectorStore.getAllDocuments();

    // Calculate similarity scores
    const results = documents.map(doc => ({
      document: doc,
      score: cosineSimilarity(queryEmbedding, doc.embedding),
    }));

    // Sort by score and take top K
    results.sort((a, b) => b.score - a.score);
    const topResults = results.slice(0, topK);

    // Transform to SearchResult format
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
