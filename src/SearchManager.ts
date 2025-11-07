import { EmbeddingSearch } from './EmbeddingSearch';
import { BM25Search } from './BM25Search';
import type { MetadataStore, DocumentMetadata } from './MetadataStore';
import type { ConfigManager } from './ConfigManager';
import { WithLogging } from './WithLogging';

export interface ChunkSearchResult {
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

/**
 * Search options for both UI and benchmark searches
 *
 * Note: Sonar uses flat search (computes similarity for all chunks),
 * unlike Elasticsearch/Weaviate which use ANN indexes (HNSW).
 * This means Sonar doesn't need a chunkTopK parameter - all chunks
 * are processed, aggregated to documents, and then sliced to topK.
 */
export interface SearchOptions {
  excludeFilePath?: string;
  titleWeight?: number;
  contentWeight?: number;
  embeddingWeight?: number;
  bm25Weight?: number;
}

/**
 * Reciprocal Rank Fusion constant
 */
const RRF_K = 60;

/**
 * High-level search manager that orchestrates hybrid search
 * combining embedding-based and BM25 full-text search
 */
export class SearchManager extends WithLogging {
  protected readonly componentName = 'SearchManager';

  constructor(
    private embeddingSearch: EmbeddingSearch,
    private bm25Search: BM25Search,
    private metadataStore: MetadataStore,
    protected configManager: ConfigManager
  ) {
    super();
    this.log('Initialized');
  }

  /**
   * Core search implementation (flat search - all chunks processed)
   *
   * Unlike Elasticsearch/Weaviate which use ANN indexes (HNSW) to efficiently
   * retrieve top-k chunks, Sonar computes similarity for ALL chunks, then:
   * 1. Aggregate all chunks to documents
   * 2. Apply RRF fusion on all aggregated documents
   * 3. Return all documents sorted by score (caller slices to desired count)
   *
   * @param query Search query text
   * @param options Search weights and filters
   * @returns All aggregated documents sorted by score (no limit)
   */
  private async search(
    query: string,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    const titleWeight = options?.titleWeight ?? 0.0;
    const contentWeight = options?.contentWeight ?? 1.0;
    const embeddingWeight = options?.embeddingWeight ?? 0.6;
    const bm25Weight = options?.bm25Weight ?? 0.4;

    // Validate weights
    if (titleWeight === 0 && contentWeight === 0) {
      throw new Error(
        'At least one of titleWeight or contentWeight must be non-zero'
      );
    }
    if (embeddingWeight === 0 && bm25Weight === 0) {
      throw new Error(
        'At least one of embeddingWeight or bm25Weight must be non-zero'
      );
    }

    // Perform hybrid search for title and/or content
    const [titleHybrid, contentHybrid] = await Promise.all([
      titleWeight > 0
        ? this.hybridSearch(
            query,
            'title',
            embeddingWeight,
            bm25Weight,
            options
          )
        : Promise.resolve(new Map<string, number>()),
      contentWeight > 0
        ? this.hybridSearch(
            query,
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
    return this.createSearchResults(finalScores, options);
  }

  /**
   * UI search entry point
   * Uses searchResultsCount config to determine how many results to return
   */
  async searchUI(
    query: string,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    const searchResultsCount = this.configManager.get('searchResultsCount');
    const results = await this.search(query, options);
    return results.slice(0, searchResultsCount);
  }

  /**
   * Benchmark search entry point
   * Returns top-k documents for benchmark evaluation
   */
  async searchBenchmark(
    query: string,
    topK: number,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    const results = await this.search(query, options);
    return results.slice(0, topK);
  }

  /**
   * Hybrid search for either title or content
   * Returns Map<filePath, score> normalized to [0, 1] based on theoretical maximum
   */
  private async hybridSearch(
    query: string,
    type: 'title' | 'content',
    embeddingWeight: number,
    bm25Weight: number,
    options?: SearchOptions
  ): Promise<Map<string, number>> {
    // Run searches in parallel (skip if weight is 0)
    // Both embeddingSearch and bm25Search now return ALL aggregated documents
    const [embeddingResults, bm25Results] = await Promise.all([
      embeddingWeight > 0
        ? type === 'title'
          ? this.embeddingSearch.searchTitle(query, options)
          : this.embeddingSearch.searchContent(query, options)
        : Promise.resolve([]),
      bm25Weight > 0
        ? type === 'title'
          ? this.bm25Search.searchTitle(query, options)
          : this.bm25Search.searchContent(query, options)
        : Promise.resolve([]),
    ]);

    // Apply RRF (handles empty results gracefully)
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
   * Create SearchResults from score map
   */
  private async createSearchResults(
    scoreMap: Map<string, number>,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    const documents = await this.metadataStore.getAllDocuments();

    let filteredDocuments = documents;
    if (options?.excludeFilePath) {
      filteredDocuments = documents.filter(
        doc => doc.filePath !== options.excludeFilePath
      );
    }

    const docsByFilePath = new Map<string, typeof filteredDocuments>();
    for (const doc of filteredDocuments) {
      const filePath = doc.filePath;
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

    // Sort by score (already normalized to [0, 1] based on theoretical maximum)
    results.sort((a, b) => b.score - a.score);

    return results;
  }
}
