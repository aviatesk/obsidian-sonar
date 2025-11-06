export type LogLevel = 'error' | 'warn' | 'log';
export type EmbedderType = 'transformers' | 'ollama';
export type AggregationMethod =
  | 'max_p'
  | 'top_m_sum'
  | 'top_m_avg'
  | 'rrf_per_doc'
  | 'weighted_top_l_sum';

export interface ObsidianSettings {
  // Embedder configuration
  embedderType: EmbedderType; // 'transformers' or 'ollama'
  embeddingModel: string; // HuggingFace model ID (e.g., 'Xenova/bge-m3') or Ollama model name

  // Search parameters
  maxChunkSize: number;
  chunkOverlap: number;
  maxQueryTokens: number; // Maximum tokens for search queries
  topK: number; // Number of search results to return
  scoreDecay: number; // Decay factor for multi-chunk scoring (0-1) - legacy, use aggDecay

  // Chunk retrieval and aggregation parameters (for benchmark compatibility)
  chunkTopKMultiplier: number; // Multiplier for chunk retrieval (default: 4, retrieves topK * multiplier chunks)
  bm25AggMethod: AggregationMethod; // BM25 aggregation method (default: 'max_p')
  vectorAggMethod: AggregationMethod; // Vector aggregation method (default: 'weighted_top_l_sum')
  aggM: number; // Number of top chunks for top_m_sum/top_m_avg (default: 3)
  aggL: number; // Number of top chunks for weighted_top_l_sum (default: 3)
  aggDecay: number; // Decay factor for weighted_top_l_sum (default: 0.95)
  aggRrfK: number; // RRF k parameter for rrf_per_doc (default: 60)

  // Obsidian-specific
  indexPath: string;
  debugMode: LogLevel;
  excludedPaths: string[];
  autoOpenRelatedNotes: boolean;
  autoIndex: boolean;
  relatedNotesDebounceMs: number;
  statusBarMaxLength: number;
  showRelatedNotesQuery: boolean;
  showRelatedNotesExcerpts: boolean;
  showKnowledgeGraph: boolean;

  // Benchmark-specific
  benchmarkQueriesPath: string; // Absolute path to queries.jsonl file
  benchmarkQrelsPath: string; // Absolute path to qrels.tsv file
  benchmarkOutputDir: string; // Absolute path to directory for TREC output files
  benchmarkChunkTopK: number; // Number of chunks to retrieve for benchmarks
}

export const DEFAULT_SETTINGS: ObsidianSettings = {
  embedderType: 'transformers',
  embeddingModel: 'Xenova/bge-m3', // Transformers.js compatible model
  maxChunkSize: 512, // tokens
  chunkOverlap: 64, // tokens (roughly 10% of chunk size)
  maxQueryTokens: 128, // tokens for search queries
  topK: 10, // default number of search results
  scoreDecay: 0.1, // legacy - kept for backward compatibility
  chunkTopKMultiplier: 4, // retrieve topK * 4 chunks
  bm25AggMethod: 'max_p', // MaxP for BM25 (keyword dominance)
  vectorAggMethod: 'weighted_top_l_sum', // Weighted decay for vector (context matters)
  aggM: 3, // top 3 chunks for top_m_sum/avg
  aggL: 3, // top 3 chunks for weighted_top_l_sum
  aggDecay: 0.95, // decay factor for weighted aggregation
  aggRrfK: 60, // RRF k parameter
  indexPath: '',
  debugMode: 'error',
  excludedPaths: [],
  autoOpenRelatedNotes: true,
  autoIndex: false,
  relatedNotesDebounceMs: 5000,
  statusBarMaxLength: 40,
  showRelatedNotesQuery: true,
  showRelatedNotesExcerpts: true,
  showKnowledgeGraph: true,
  benchmarkQueriesPath: '',
  benchmarkQrelsPath: '',
  benchmarkOutputDir: '',
  benchmarkChunkTopK: 100,
};
