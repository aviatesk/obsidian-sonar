/**
 * Unified interface for embedding generation
 * Supports both Transformers.js and llama.cpp backends
 */
export interface Embedder {
  /**
   * Initialize the embedder (optional, for backends that need async setup)
   */
  initialize?(): Promise<void>;

  getEmbeddings(
    texts: string[],
    type?: 'query' | 'passage'
  ): Promise<number[][]>;

  /**
   * Counts the number of tokens in the given text.
   *
   * WARNING: For large texts (e.g., entire file contents), this method may hang
   * or perform poorly. When processing large documents, split the text by lines
   * and call this method for each line separately to avoid performance issues.
   *
   * @example
   * // Good: Process line by line for large texts
   * const lines = content.split('\n');
   * let totalTokens = 0;
   * for (const line of lines) {
   *   totalTokens += await embedder.countTokens(line);
   * }
   *
   * // Avoid: Processing entire large file at once
   * const tokens = await embedder.countTokens(largeFileContent); // May hang!
   */
  countTokens(text: string): Promise<number>;

  /**
   * Returns token IDs for the given text, excluding special tokens.
   *
   * WARNING: For large texts, this method may hang. Process line by line instead.
   *
   * @returns Array of token IDs (as numbers)
   */
  getTokenIds(text: string): Promise<number[]>;

  getDevice(): string;
  cleanup(): void;
}

export function formatTokenCountShort(count: number): string {
  if (count < 1000) {
    return `${count} tokens`;
  } else if (count < 10000) {
    return `${(count / 1000).toFixed(1)}k tokens`;
  } else {
    return `${(count / 1000).toFixed(0)}k tokens`;
  }
}
