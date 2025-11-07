export type LogLevel = 'error' | 'warn' | 'log';
export type EmbedderType = 'transformers' | 'ollama';
export type AggregationMethod =
  | 'max_p'
  | 'top_m_sum'
  | 'top_m_avg'
  | 'rrf_per_doc'
  | 'weighted_top_l_sum';

export interface ObsidianSettings {
  // ===========================================================================
  // UI-configurable settings (exposed in SettingTab.ts)
  // ===========================================================================

  // Embedder configuration [UI]
  embeddingModel: string; // [UI] HuggingFace model ID (e.g., 'Xenova/bge-m3') or Ollama model name

  // Search parameters [UI]
  maxChunkSize: number; // [UI]
  chunkOverlap: number; // [UI]
  maxQueryTokens: number; // [UI] Maximum tokens for search queries
  searchResultsCount: number; // [UI] Number of final documents to return to user

  // Obsidian-specific [UI]
  indexPath: string; // [UI]
  debugMode: LogLevel; // [UI]
  excludedPaths: string[]; // [UI]
  autoOpenRelatedNotes: boolean; // [UI]
  autoIndex: boolean; // [UI]
  relatedNotesDebounceMs: number; // [UI]
  statusBarMaxLength: number; // [UI]

  // ===========================================================================
  // Hidden settings (not exposed in SettingTab.ts)
  // ===========================================================================

  // Embedder configuration (hidden)
  embedderType: EmbedderType; // 'transformers' or 'ollama'

  // Chunk retrieval and aggregation parameters (hidden, for benchmark compatibility)
  bm25AggMethod: AggregationMethod; // BM25 aggregation method (default: 'max_p')
  vectorAggMethod: AggregationMethod; // Vector aggregation method (default: 'weighted_top_l_sum')
  aggM: number; // Number of top chunks for top_m_sum/top_m_avg (default: 3)
  aggL: number; // Number of top chunks for weighted_top_l_sum (default: 3)
  aggDecay: number; // Decay factor for weighted_top_l_sum (default: 0.95)
  aggRrfK: number; // RRF k parameter for rrf_per_doc (default: 60)

  // UI view preferences (hidden)
  showRelatedNotesQuery: boolean;
  showRelatedNotesExcerpts: boolean;
  showKnowledgeGraph: boolean;

  // ===========================================================================
  // Benchmark-specific settings (not exposed in SettingTab.ts)
  // ===========================================================================

  benchmarkQueriesPath: string; // Absolute path to queries.jsonl file
  benchmarkQrelsPath: string; // Absolute path to qrels.tsv file
  benchmarkOutputDir: string; // Absolute path to directory for TREC output files
  benchmarkTopK: number; // Number of documents to return for benchmarks (default: 100)
}

export const DEFAULT_SETTINGS: ObsidianSettings = {
  // ===========================================================================
  // UI-configurable settings (exposed in SettingTab.ts)
  // ===========================================================================

  // Embedder configuration [UI]
  embeddingModel: 'Xenova/bge-m3', // Transformers.js compatible model

  // Search parameters [UI]
  maxChunkSize: 512, // tokens
  chunkOverlap: 64, // tokens (roughly 10% of chunk size)
  maxQueryTokens: 128, // tokens for search queries
  searchResultsCount: 10, // default number of documents to return to user

  // Obsidian-specific [UI]
  indexPath: '',
  debugMode: 'error',
  excludedPaths: [],
  autoOpenRelatedNotes: true,
  autoIndex: false,
  relatedNotesDebounceMs: 5000,
  statusBarMaxLength: 40,

  // ===========================================================================
  // Hidden settings (not exposed in UI)
  // ===========================================================================

  // Embedder configuration (hidden)
  embedderType: 'transformers',

  // Chunk retrieval and aggregation parameters (hidden, for benchmark compatibility)
  bm25AggMethod: 'max_p', // MaxP for BM25 (keyword dominance)
  vectorAggMethod: 'weighted_top_l_sum', // Weighted decay for vector (context matters)
  aggM: 3, // top 3 chunks for top_m_sum/avg
  aggL: 3, // top 3 chunks for weighted_top_l_sum
  aggDecay: 0.95, // decay factor for weighted aggregation
  aggRrfK: 60, // RRF k parameter

  // UI view preferences (hidden)
  showRelatedNotesQuery: true,
  showRelatedNotesExcerpts: true,
  showKnowledgeGraph: true,

  // ===========================================================================
  // Benchmark-specific settings
  // ===========================================================================

  benchmarkQueriesPath: '',
  benchmarkQrelsPath: '',
  benchmarkOutputDir: '',
  benchmarkTopK: 100,
};
