export interface CommonRAGConfig {
  // Ollama関連
  ollamaUrl: string;
  embeddingModel: string;
  summaryModel: string;

  // Tokenizer関連
  tokenizerModel: string; // Empty string means auto-detection

  maxChunkSize: number;
  chunkOverlap: number;
  maxQueryTokens: number; // Maximum tokens for search queries

  defaultTopK: number;
}

export interface CLIConfig extends CommonRAGConfig {
  indexPath: string;
  dbPath: string;
  parallelServers: number;
  parallelPort: number;
}

export interface ObsidianConfig extends CommonRAGConfig {
  indexPath: string;
  debugMode: boolean;
  followCursor: boolean;
  withExtraction: boolean;
  excludedPaths: string[]; // Array of paths/patterns to ignore
}

export const DEFAULT_COMMON_CONFIG: CommonRAGConfig = {
  ollamaUrl: 'http://localhost:11434',
  embeddingModel: 'bge-m3:latest',
  summaryModel: 'gemma3n:e4b',
  tokenizerModel: '', // Empty string for auto-detection
  maxChunkSize: 512, // tokens
  chunkOverlap: 64, // tokens (roughly 10% of chunk size)
  maxQueryTokens: 128, // tokens for search queries
  defaultTopK: 5,
};

export const DEFAULT_CLI_CONFIG: CLIConfig = {
  ...DEFAULT_COMMON_CONFIG,
  indexPath: process.cwd(),
  dbPath: './db/sonar-index.json',
  parallelServers: 1,
  parallelPort: 11435,
};

export const DEFAULT_OBSIDIAN_CONFIG: ObsidianConfig = {
  ...DEFAULT_COMMON_CONFIG,
  indexPath: '/', // Root of vault
  debugMode: false,
  followCursor: false,
  withExtraction: false,
  excludedPaths: [], // Default to no ignored paths
};

export function isCommonConfig(config: any): config is CommonRAGConfig {
  return (
    typeof config === 'object' &&
    typeof config.ollamaUrl === 'string' &&
    typeof config.embeddingModel === 'string' &&
    typeof config.summaryModel === 'string' &&
    typeof config.maxChunkSize === 'number' &&
    typeof config.chunkOverlap === 'number' &&
    typeof config.defaultTopK === 'number'
  );
}

export function mergeWithDefaults<T extends CommonRAGConfig>(
  userConfig: Partial<T>,
  defaultConfig: T
): T {
  return {
    ...defaultConfig,
    ...userConfig,
  };
}
