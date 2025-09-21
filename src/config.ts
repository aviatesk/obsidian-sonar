export interface CommonConfig {
  // Ollama
  ollamaUrl: string;
  embeddingModel: string;
  summaryModel: string;

  // Transformer.js
  tokenizerModel: string; // Empty string means auto-detection

  maxChunkSize: number;
  chunkOverlap: number;
  maxQueryTokens: number; // Maximum tokens for search queries
  topK: number; // Number of search results to return
}

export interface ScriptConfig extends CommonConfig {
  indexPath: string;
  dbPath: string;
  parallelServers: number;
  parallelPort: number;
}

export interface ObsidianSettings extends CommonConfig {
  indexPath: string;
  debugMode: boolean;
  followCursor: boolean;
  withExtraction: boolean;
  excludedPaths: string[]; // Array of paths/patterns to ignore
  autoOpenRelatedNotes: boolean;
  autoIndex: boolean;
  indexDebounceMs: number;
  relatedNotesDebounceMs: number;
  showIndexNotifications: boolean;
  statusBarMaxLength: number;
}

export const DEFAULT_COMMON_CONFIG: CommonConfig = {
  ollamaUrl: 'http://localhost:11434',
  embeddingModel: 'bge-m3:latest',
  summaryModel: 'gemma3n:e4b',
  tokenizerModel: '', // Empty string for auto-detection
  maxChunkSize: 512, // tokens
  chunkOverlap: 64, // tokens (roughly 10% of chunk size)
  maxQueryTokens: 128, // tokens for search queries
  topK: 10, // default number of search results
};

export const DEFAULT_SCRIPT_CONFIG: ScriptConfig = {
  ...DEFAULT_COMMON_CONFIG,
  indexPath: process.cwd(),
  dbPath: './db/sonar-index.json',
  parallelServers: 1,
  parallelPort: 11435,
};

export const DEFAULT_SETTINGS: ObsidianSettings = {
  ...DEFAULT_COMMON_CONFIG,
  indexPath: '/', // Root of vault
  debugMode: false,
  followCursor: false,
  withExtraction: false,
  excludedPaths: [], // Default to no ignored paths
  autoOpenRelatedNotes: true,
  autoIndex: false,
  indexDebounceMs: 10000, // 10s for auto-indexing
  relatedNotesDebounceMs: 10000, // 10s for related notes view updates
  showIndexNotifications: true,
  statusBarMaxLength: 40,
};
