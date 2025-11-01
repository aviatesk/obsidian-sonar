import { EmbeddingStore } from './EmbeddingStore';
import { MetadataStore, type DocumentMetadata } from './MetadataStore';
import { OllamaClient } from './OllamaClient';
import type { BM25Search } from './BM25Search';

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
  fileSize: number;
}

interface CombinedDocument {
  id: string;
  content: string;
  embedding: number[];
  titleEmbedding: number[];
  metadata: DocumentMetadata;
}

export interface SearchOptions {
  excludeFilePath?: string;
  titleWeight?: number;
  contentWeight?: number;
  embeddingWeight?: number;
  bm25Weight?: number;
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
 * Reciprocal Rank Fusion constant
 */
const RRF_K = 60;

/**
 * Search interface with hybrid embedding + BM25 support
 * All DB modifications should go through IndexManager
 */
export class EmbeddingSearch {
  constructor(
    private metadataStore: MetadataStore,
    private embeddingStore: EmbeddingStore,
    private ollamaClient: OllamaClient,
    private scoreDecay: number = 0.1,
    private bm25Search: BM25Search
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

  setScoreDecay(value: number) {
    this.scoreDecay = value;
  }

  async search(
    query: string,
    topK: number,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    const titleWeight = options?.titleWeight ?? 0.0;
    const contentWeight = options?.contentWeight ?? 1.0;
    const embeddingWeight = options?.embeddingWeight ?? 0.6;
    const bm25Weight = options?.bm25Weight ?? 0.4;

    // If no BM25 or either weight is 0, use embedding-only search
    if (embeddingWeight === 0 || bm25Weight === 0) {
      return this.embeddingSearch(query, topK, options);
    }

    // Hybrid search: combine embedding and BM25 with RRF
    const [titleHybrid, contentHybrid] = await Promise.all([
      titleWeight > 0
        ? this.hybridSearchSingle(
            query,
            topK,
            'title',
            embeddingWeight,
            bm25Weight,
            options
          )
        : Promise.resolve(new Map<string, number>()),
      contentWeight > 0
        ? this.hybridSearchSingle(
            query,
            topK,
            'content',
            embeddingWeight,
            bm25Weight,
            options
          )
        : Promise.resolve(new Map<string, number>()),
    ]);

    // Combine title and content scores
    const allFilePaths = new Set([
      ...titleHybrid.keys(),
      ...contentHybrid.keys(),
    ]);

    const finalScores = new Map<string, number>();
    const totalWeight = titleWeight + contentWeight;

    for (const filePath of allFilePaths) {
      const titleScore = titleHybrid.get(filePath) || 0;
      const contentScore = contentHybrid.get(filePath) || 0;
      const weightedScore =
        titleWeight * titleScore + contentWeight * contentScore;
      // Normalize to [0, 1] based on total weight
      const finalScore = totalWeight > 0 ? weightedScore / totalWeight : 0;
      finalScores.set(filePath, finalScore);
    }

    // Get documents and create SearchResults
    return this.createSearchResults(finalScores, topK, options);
  }

  /**
   * Hybrid search for either title or content
   * Returns Map<filePath, score> normalized to [0, 1] based on theoretical maximum
   */
  private async hybridSearchSingle(
    query: string,
    topK: number,
    type: 'title' | 'content',
    embeddingWeight: number,
    bm25Weight: number,
    options?: SearchOptions
  ): Promise<Map<string, number>> {
    // Run both searches in parallel
    const [embeddingResults, bm25Results] = await Promise.all([
      type === 'title'
        ? this.embeddingSearchTitle(query, topK * 2, options)
        : this.embeddingSearchContent(query, topK * 2, options),
      type === 'title'
        ? this.bm25Search.searchTitle(query, topK * 2)
        : this.bm25Search.searchContent(query, topK * 2),
    ]);

    // Apply RRF
    const rrfScores = this.reciprocalRankFusion(
      embeddingResults,
      bm25Results,
      embeddingWeight,
      bm25Weight
    );

    // Normalize by theoretical maximum RRF score
    // Max occurs when both ranks = 1: (embeddingWeight + bm25Weight) / (RRF_K + 1)
    const maxTheoreticalRRF = (embeddingWeight + bm25Weight) / (RRF_K + 1);

    const normalizedScores = new Map<string, number>();
    for (const [filePath, score] of rrfScores.entries()) {
      normalizedScores.set(filePath, score / maxTheoreticalRRF);
    }

    return normalizedScores;
  }

  /**
   * Reciprocal Rank Fusion algorithm
   */
  private reciprocalRankFusion(
    embeddingResults: SearchResult[],
    bm25Results: SearchResult[],
    embeddingWeight: number,
    bm25Weight: number
  ): Map<string, number> {
    const embeddingRanks = new Map<string, number>();
    embeddingResults.forEach((result, index) => {
      embeddingRanks.set(result.filePath, index + 1);
    });

    const bm25Ranks = new Map<string, number>();
    bm25Results.forEach((result, index) => {
      bm25Ranks.set(result.filePath, index + 1);
    });

    const allFilePaths = new Set([
      ...embeddingRanks.keys(),
      ...bm25Ranks.keys(),
    ]);

    const rrfScores = new Map<string, number>();
    for (const filePath of allFilePaths) {
      let rrfScore = 0;

      const embeddingRank = embeddingRanks.get(filePath);
      if (embeddingRank !== undefined) {
        rrfScore += embeddingWeight * (1 / (RRF_K + embeddingRank));
      }

      const bm25Rank = bm25Ranks.get(filePath);
      if (bm25Rank !== undefined) {
        rrfScore += bm25Weight * (1 / (RRF_K + bm25Rank));
      }

      rrfScores.set(filePath, rrfScore);
    }

    return rrfScores;
  }

  /**
   * Embedding-only search for title
   */
  private async embeddingSearchTitle(
    query: string,
    topK: number,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    return this.embeddingSearch(query, topK, {
      ...options,
      titleWeight: 1,
      contentWeight: 0,
    });
  }

  /**
   * Embedding-only search for content
   */
  private async embeddingSearchContent(
    query: string,
    topK: number,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    return this.embeddingSearch(query, topK, {
      ...options,
      titleWeight: 0,
      contentWeight: 1,
    });
  }

  /**
   * Original embedding-only search logic
   */
  private async embeddingSearch(
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
      weight *= this.scoreDecay;
    }

    // Normalize to [0, 1]
    if (maxTheoreticalScore > 0) {
      for (const result of aggregated) {
        result.score = result.score / maxTheoreticalScore;
      }
    }

    return aggregated.slice(0, topK);
  }

  /**
   * Create SearchResults from score map
   */
  private async createSearchResults(
    scoreMap: Map<string, number>,
    topK: number,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    const documents = await this.getCombinedDocuments();

    let filteredDocuments = documents;
    if (options?.excludeFilePath) {
      filteredDocuments = documents.filter(
        doc => doc.metadata.filePath !== options.excludeFilePath
      );
    }

    const docsByFilePath = new Map<string, typeof filteredDocuments>();
    for (const doc of filteredDocuments) {
      const filePath = doc.metadata.filePath;
      if (!docsByFilePath.has(filePath)) {
        docsByFilePath.set(filePath, []);
      }
      docsByFilePath.get(filePath)!.push(doc);
    }

    const results: SearchResult[] = [];
    for (const [filePath, score] of scoreMap.entries()) {
      const fileDocs = docsByFilePath.get(filePath);
      if (!fileDocs || fileDocs.length === 0) continue;

      const topDoc = fileDocs[0];
      results.push({
        filePath,
        title: topDoc.metadata.title || filePath,
        score,
        topChunk: {
          content: topDoc.content,
          score,
          metadata: topDoc.metadata,
        },
        chunkCount: fileDocs.length,
        fileSize: topDoc.metadata.size,
      });
    }

    // Sort by score (already normalized to [0, 1] based on theoretical maximum)
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, topK);
  }
}
