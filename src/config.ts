export type LogLevel = 'error' | 'warn' | 'log' | 'verbose';

export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  log: 2,
  verbose: 3,
} as const;

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
  enableRelatedNotesReranking: boolean; // Enable reranking in RelatedNotesView
  enableSearchReranking: boolean; // Enable reranking in SemanticNoteFinder
  showIntermediateResults: boolean; // Show initial results while reranking (only when reranking enabled)
  searchResultsCount: number; // Number of final documents to return to user
  relatedNotesDebounceMs: number; // Delay before updating related notes view

  // Chunking configuration
  // ======================
  maxChunkSize: number; // Maximum tokens per chunk
  chunkOverlap: number; // Overlapping tokens between chunks
  maxQueryTokens: number; // Maximum tokens for search queries

  // llama.cpp configuration
  // =======================
  llamacppServerPath: string; // Path to llama.cpp server binary (e.g., 'llama-server')
  llamaEmbedderModelRepo: string; // HuggingFace repository for llama.cpp (e.g., 'ggml-org/bge-m3-Q8_0-GGUF')
  llamaEmbedderModelFile: string; // GGUF filename in the repository (e.g., 'bge-m3-q8_0.gguf')
  llamaRerankerModelRepo: string; // HuggingFace repository for reranker (e.g., 'gpustack/bge-reranker-v2-m3-GGUF')
  llamaRerankerModelFile: string; // GGUF filename for reranker (e.g., 'bge-reranker-v2-m3-Q8_0.gguf')
  llamaChatModelRepo: string; // HuggingFace repository for chat model (e.g., 'Qwen/Qwen3-8B-GGUF')
  llamaChatModelFile: string; // GGUF filename for chat model (e.g., 'qwen3-8b-q8_0.gguf')

  // Chat generation parameters
  // ==========================
  chatTemperature: number; // Temperature for response generation (default: 0.6)
  chatTopK: number; // Top-k sampling, 0 to disable (default: 0)
  chatTopP: number; // Top-p (nucleus sampling) for response generation (default: 0.9)
  chatPresencePenalty: number; // Presence penalty to reduce repetition (default: 0.5)

  // Chat configuration
  // ==================
  chatMaxTokens: number; // Maximum tokens for response generation
  chatEnableThinking: boolean; // Enable thinking mode for Qwen3 (default: false)
  agentMaxIterations: number; // Maximum iterations for agent loop (default: 5)

  // Context settings
  // =================
  contextTokenBudget: number; // Maximum tokens for context

  // Builtin tools settings
  // ----------------------
  // Edit note
  editNoteAutoAllow: boolean; // Skip permission prompt for edit_note tool (default: false)
  // Fetch URL
  fetchUrlEnabled: boolean; // Enable fetch_url tool (default: false)

  // Extension tools
  // ---------------
  extensionToolsPath: string; // Vault folder containing extension tool scripts (.js files)

  // Vault context
  // -------------
  vaultContextFilePath: string; // Path to markdown file containing vault context for chat

  // Search parameters
  // =================
  bm25AggMethod: AggregationMethod; // BM25 aggregation method (default: 'max_p')
  vectorAggMethod: AggregationMethod; // Vector aggregation method (default: 'weighted_top_l_sum')
  aggM: number; // Number of top chunks for top_m_sum/top_m_avg (default: 3)
  aggL: number; // Number of top chunks for weighted_top_l_sum (default: 3)
  aggDecay: number; // Decay factor for weighted_top_l_sum (default: 0.95)
  aggRrfK: number; // RRF k parameter for rrf_per_doc (default: 60)
  retrievalMultiplier: number; // Multiplier for candidate retrieval (hybrid search fusion & reranking)

  // Audio transcription configuration
  // ==================================
  audioWhisperCliPath: string; // Path to whisper-cli binary (e.g., 'whisper-cli')
  audioWhisperModelPath: string; // Path to whisper.cpp model file (e.g., '~/whisper-models/ggml-large-v3-turbo-q5_0.bin')
  audioFfmpegPath: string; // Path to ffmpeg binary (e.g., 'ffmpeg')
  audioTranscriptionLanguage: string; // Language code for transcription (e.g., 'ja', 'en')

  // Logging configuration
  // =====================
  statusBarMaxLength: number; // Maximum characters in status bar (0 = no limit)
  debugMode: LogLevel; // Logging verbosity level

  // Benchmark configuration (optional, only used in development builds)
  // ===================================================================
  benchmarkQueriesPath: string; // Path to queries.jsonl file (absolute or vault-relative)
  benchmarkQrelsPath: string; // Path to qrels.tsv file (absolute or vault-relative)
  benchmarkOutputDir: string; // Path to directory for TREC output files (absolute or vault-relative)
  benchmarkTopK: number; // Number of documents to return for benchmarks (default: 100)

  // CRAG benchmark configuration (optional, only used in development builds)
  // ========================================================================
  cragDataPath: string; // Path to CRAG data.jsonl file (absolute or vault-relative)
  cragOutputDir: string; // Path to directory for CRAG benchmark output (absolute or vault-relative)
  cragSampleSize: number; // Number of samples to process (0 = all)
  cragSampleOffset: number; // Number of samples to skip (for resuming)
  cragOpenaiApiKey: string; // OpenAI API key for LLM-as-judge evaluation

  // CRAG Unified benchmark configuration (Benchmark B)
  // ===================================================
  cragUnifiedCorpusPath: string; // Path to corpus.jsonl file (absolute or vault-relative)
  cragUnifiedQueriesPath: string; // Path to queries.jsonl file (absolute or vault-relative)
  cragUnifiedOutputDir: string; // Path to directory for benchmark output (absolute or vault-relative)
  cragUnifiedSampleSize: number; // Number of queries to process (0 = all)
  cragUnifiedSampleOffset: number; // Number of queries to skip (for resuming)
}

export const DEFAULT_SETTINGS: SonarSettings = {
  // Index configuration
  // ===================
  indexPath: '',
  excludedPaths: [],
  indexingBatchSize: 32,
  autoIndex: true,

  // UI preferences
  // ==============
  autoOpenRelatedNotes: false,
  showRelatedNotesQuery: false,
  showRelatedNotesExcerpts: false,
  showKnowledgeGraph: false,
  enableRelatedNotesReranking: false,
  enableSearchReranking: false,
  showIntermediateResults: false,
  searchResultsCount: 10,
  relatedNotesDebounceMs: 5000,

  // Chunking configuration
  // ======================
  maxChunkSize: 512,
  chunkOverlap: 64,
  maxQueryTokens: 128,

  // llama.cpp configuration
  // =======================
  llamacppServerPath: 'llama-server',
  llamaEmbedderModelRepo: 'ggml-org/bge-m3-Q8_0-GGUF',
  llamaEmbedderModelFile: 'bge-m3-q8_0.gguf',
  llamaRerankerModelRepo: 'gpustack/bge-reranker-v2-m3-GGUF',
  llamaRerankerModelFile: 'bge-reranker-v2-m3-Q8_0.gguf',
  llamaChatModelRepo: 'Qwen/Qwen3-8B-GGUF',
  llamaChatModelFile: 'qwen3-8b-q8_0.gguf',

  // Chat generation parameters
  // ==========================
  chatTemperature: 0.6,
  chatTopK: 0,
  chatTopP: 0.9,
  chatPresencePenalty: 0.5,

  // Chat configuration
  // ==================
  chatMaxTokens: 8192,
  chatEnableThinking: false,
  agentMaxIterations: 5,

  // Context settings
  // =================
  contextTokenBudget: 8192,

  // Builtin tools settings
  // ----------------------
  // Edit note
  editNoteAutoAllow: false,
  // Fetch URL
  fetchUrlEnabled: false,
  // Extension tools
  extensionToolsPath: '',
  // Vault context
  vaultContextFilePath: '',

  // Search parameters
  // =================
  bm25AggMethod: 'max_p',
  vectorAggMethod: 'weighted_top_l_sum',
  aggM: 3,
  aggL: 3,
  aggDecay: 0.95,
  aggRrfK: 60,
  retrievalMultiplier: 10,

  // Audio transcription configuration
  // ==================================
  audioWhisperCliPath: 'whisper-cli',
  audioWhisperModelPath: '',
  audioFfmpegPath: 'ffmpeg',
  audioTranscriptionLanguage: 'auto',

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

  // CRAG benchmark configuration
  // ============================
  cragDataPath: '',
  cragOutputDir: '',
  cragSampleSize: 0,
  cragSampleOffset: 0,
  cragOpenaiApiKey: '',

  // CRAG Unified benchmark configuration
  // =====================================
  cragUnifiedCorpusPath: '',
  cragUnifiedQueriesPath: '',
  cragUnifiedOutputDir: '',
  cragUnifiedSampleSize: 0,
  cragUnifiedSampleOffset: 0,
};
