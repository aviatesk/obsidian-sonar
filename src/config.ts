export type LogLevel = 'error' | 'warn' | 'log';
export type EmbedderType = 'transformers' | 'ollama';
export type AggregationMethod =
  | 'max_p'
  | 'top_m_sum'
  | 'top_m_avg'
  | 'rrf_per_doc'
  | 'weighted_top_l_sum';

export interface SonarSettings {
  // Index configuration
  // ===================
  indexPath: string; // Path to index (empty = entire vault)
  excludedPaths: string[]; // Paths to ignore during indexing
  indexingBatchSize: number; // Number of texts to process in a single batch during indexing
  autoIndex: boolean; // Enable auto-indexing on file changes

  // UI preferences
  // ==============
  autoOpenRelatedNotes: boolean; // Auto-open related notes view on startup
  showRelatedNotesQuery: boolean; // Show search query in related notes view
  showRelatedNotesExcerpts: boolean; // Show text excerpts in related notes view
  showKnowledgeGraph: boolean; // Show knowledge graph visualization
  searchResultsCount: number; // Number of final documents to return to user
  relatedNotesDebounceMs: number; // Delay before updating related notes view

  // Chunking configuration
  // ======================
  maxChunkSize: number; // Maximum tokens per chunk
  chunkOverlap: number; // Overlapping tokens between chunks
  maxQueryTokens: number; // Maximum tokens for search queries

  // Embedder configuration
  // ======================
  embedderType: EmbedderType; // Embedder type: 'transformers' or 'ollama'
  embeddingModel: string; // HuggingFace model ID (e.g., 'Xenova/bge-m3') or Ollama model name

  // Search parameters
  // =================
  bm25AggMethod: AggregationMethod; // BM25 aggregation method (default: 'max_p')
  vectorAggMethod: AggregationMethod; // Vector aggregation method (default: 'weighted_top_l_sum')
  aggM: number; // Number of top chunks for top_m_sum/top_m_avg (default: 3)
  aggL: number; // Number of top chunks for weighted_top_l_sum (default: 3)
  aggDecay: number; // Decay factor for weighted_top_l_sum (default: 0.95)
  aggRrfK: number; // RRF k parameter for rrf_per_doc (default: 60)
  retrievalMultiplier: number; // Multiplier for hybrid search pre-fusion limit (default: 10, limit = top_k * multiplier)

  // Logging configuration
  // =====================
  statusBarMaxLength: number; // Maximum characters in status bar (0 = no limit)
  debugMode: LogLevel; // Logging verbosity level

  // Benchmark configuration
  // =======================
  benchmarkQueriesPath: string; // Path to queries.jsonl file (absolute or vault-relative)
  benchmarkQrelsPath: string; // Path to qrels.tsv file (absolute or vault-relative)
  benchmarkOutputDir: string; // Path to directory for TREC output files (absolute or vault-relative)
  benchmarkTopK: number; // Number of documents to return for benchmarks (default: 100)

  // Debug configuration
  // ===================
  debugSamplesPath: string; // Absolute path to debug samples directory (default: bench/debug)
}

export const DEFAULT_SETTINGS: SonarSettings = {
  // Index configuration
  // ===================
  indexPath: '',
  excludedPaths: [],
  indexingBatchSize: 32,
  autoIndex: false,

  // UI preferences
  // ==============
  autoOpenRelatedNotes: true,
  showRelatedNotesQuery: true,
  showRelatedNotesExcerpts: true,
  showKnowledgeGraph: true,
  searchResultsCount: 10,
  relatedNotesDebounceMs: 5000,

  // Chunking configuration
  // ======================
  maxChunkSize: 512,
  chunkOverlap: 64,
  maxQueryTokens: 128,

  // Embedder configuration
  // ======================
  embedderType: 'transformers',
  embeddingModel: 'Xenova/bge-m3',

  // Search parameters
  // =================
  bm25AggMethod: 'max_p',
  vectorAggMethod: 'weighted_top_l_sum',
  aggM: 3,
  aggL: 3,
  aggDecay: 0.95,
  aggRrfK: 60,
  retrievalMultiplier: 10,

  // Logging configuration
  // =====================
  statusBarMaxLength: 40,
  debugMode: 'error',

  // Benchmark configuration
  // =======================
  benchmarkQueriesPath: '',
  benchmarkQrelsPath: '',
  benchmarkOutputDir: '',
  benchmarkTopK: 100,

  // Debug configuration
  // ===================
  debugSamplesPath: '',
};
