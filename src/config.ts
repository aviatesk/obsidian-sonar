export type LogLevel = 'error' | 'warn' | 'log';

export interface ObsidianSettings {
  // Ollama
  ollamaUrl: string;
  embeddingModel: string;
  summaryModel: string;

  // Transformer.js
  tokenizerModel: string; // Empty string means auto-detection

  // Search parameters
  maxChunkSize: number;
  chunkOverlap: number;
  maxQueryTokens: number; // Maximum tokens for search queries
  topK: number; // Number of search results to return
  scoreDecay: number; // Decay factor for multi-chunk scoring (0-1)

  // Obsidian-specific
  indexPath: string;
  debugMode: LogLevel;
  withExtraction: boolean;
  excludedPaths: string[];
  autoOpenRelatedNotes: boolean;
  autoIndex: boolean;
  indexDebounceMs: number;
  relatedNotesDebounceMs: number;
  statusBarMaxLength: number;
  showRelatedNotesQuery: boolean;
  showRelatedNotesExcerpts: boolean;
  showKnowledgeGraph: boolean;
}

export const DEFAULT_SETTINGS: ObsidianSettings = {
  ollamaUrl: 'http://localhost:11434',
  embeddingModel: 'bge-m3:latest',
  summaryModel: 'gemma3n:e4b',
  tokenizerModel: '', // Empty string for auto-detection
  maxChunkSize: 512, // tokens
  chunkOverlap: 64, // tokens (roughly 10% of chunk size)
  maxQueryTokens: 128, // tokens for search queries
  topK: 10, // default number of search results
  scoreDecay: 0.1, // small bonus for additional chunks
  indexPath: '',
  debugMode: 'error',
  withExtraction: false,
  excludedPaths: [],
  autoOpenRelatedNotes: true,
  autoIndex: false,
  indexDebounceMs: 1000,
  relatedNotesDebounceMs: 5000,
  statusBarMaxLength: 40,
  showRelatedNotesQuery: true,
  showRelatedNotesExcerpts: true,
  showKnowledgeGraph: true,
};
