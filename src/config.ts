export type LogLevel = 'error' | 'warn' | 'log';
export type EmbedderType = 'transformers' | 'ollama';

export interface ObsidianSettings {
  // Embedder configuration
  embedderType: EmbedderType; // 'transformers' or 'ollama'
  embeddingModel: string; // HuggingFace model ID (e.g., 'Xenova/bge-m3') or Ollama model name

  // Search parameters
  maxChunkSize: number;
  chunkOverlap: number;
  maxQueryTokens: number; // Maximum tokens for search queries
  topK: number; // Number of search results to return
  scoreDecay: number; // Decay factor for multi-chunk scoring (0-1)

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
}

export const DEFAULT_SETTINGS: ObsidianSettings = {
  embedderType: 'transformers',
  embeddingModel: 'Xenova/bge-m3', // Transformers.js compatible model
  maxChunkSize: 512, // tokens
  chunkOverlap: 64, // tokens (roughly 10% of chunk size)
  maxQueryTokens: 128, // tokens for search queries
  topK: 10, // default number of search results
  scoreDecay: 0.1, // small bonus for additional chunks
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
};
