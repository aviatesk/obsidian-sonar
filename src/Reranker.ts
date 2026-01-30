import type { ModelStatus } from './SonarModelState';

export interface RerankResult {
  index: number;
  relevanceScore: number;
}

/**
 * Abstract interface for cross-encoder reranking
 */
export interface Reranker {
  readonly status: ModelStatus;

  initialize(): Promise<void>;

  rerank(
    query: string,
    documents: string[],
    topN?: number
  ): Promise<RerankResult[]>;

  isReady(): boolean;

  cleanup(): Promise<void>;
}

/**
 * No-op reranker that returns documents in their original order
 * Used when reranking is not available.
 */
export class NoopReranker implements Reranker {
  readonly status: ModelStatus = 'ready';

  initialize(): Promise<void> {
    return Promise.resolve();
  }

  rerank(
    _query: string,
    documents: string[],
    topN?: number
  ): Promise<RerankResult[]> {
    const n = topN ?? documents.length;
    const results: RerankResult[] = documents.slice(0, n).map((_, index) => ({
      index,
      relevanceScore: 1 - index / documents.length,
    }));
    return Promise.resolve(results);
  }

  isReady(): boolean {
    return true;
  }

  cleanup(): Promise<void> {
    return Promise.resolve();
  }
}
