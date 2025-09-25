import { VectorStore, type DocumentMetadata } from './VectorStore';
import { OllamaClient } from './OllamaClient';

interface ChunkSearchResult {
  content: string;
  score: number;
  metadata: DocumentMetadata;
}

export interface SearchResult {
  filePath: string;
  title: string;
  score: number;
  topChunk: ChunkSearchResult;
  chunkCount: number;
}

export interface SearchOptions {
  excludeFilePath?: string;
  titleWeight?: number;
  contentWeight?: number;
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
 * Search-only interface for semantic search
 * All DB modifications should go through IndexManager
 */
export class EmbeddingSearch {
  constructor(
    private vectorStore: VectorStore,
    private ollamaClient: OllamaClient,
    private scoreDecay: number = 0.1
  ) {}

  async search(
    query: string,
    topK: number,
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

    const titleWeight = options?.titleWeight ?? 0;
    const contentWeight = options?.contentWeight ?? 1;

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
      const aggregatedScore = aggregateWeightedDecay(scores, this.scoreDecay);
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
      });
    }

    aggregated.sort((a, b) => b.score - a.score);

    let maxTheoreticalScore = 0;
    let weight = 1;
    for (let i = 0; i < L; i++) {
      maxTheoreticalScore += weight;
      weight *= this.scoreDecay;
    }

    for (const result of aggregated) {
      result.score = result.score / maxTheoreticalScore;
    }

    return aggregated.slice(0, topK);
  }

  async close(): Promise<void> {
    await this.vectorStore.close();
  }
}
