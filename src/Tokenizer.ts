import type { ConfigManager } from './ConfigManager';
import type { Embedder } from './Embedder';
import { WithLogging } from './WithLogging';

/**
 * Transformers.js based tokenizer for accurate token counting
 * Uses Worker-based Embedder for tokenization
 */
export class Tokenizer extends WithLogging {
  protected readonly componentName = 'Tokenizer';
  private embedder: Embedder;

  private constructor(
    embedder: Embedder,
    protected configManager: ConfigManager
  ) {
    super();
    this.embedder = embedder;
  }

  static async initialize(
    embedder: Embedder,
    configManager: ConfigManager
  ): Promise<Tokenizer> {
    const tokenizer = new Tokenizer(embedder, configManager);
    tokenizer.log('Initialized with embedder');
    return tokenizer;
  }

  /**
   * Estimates the number of tokens in the given text.
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
   *   totalTokens += await tokenizer.estimateTokens(line);
   * }
   *
   * // Avoid: Processing entire large file at once
   * const tokens = await tokenizer.estimateTokens(largeFileContent); // May hang!
   */
  async estimateTokens(text: string): Promise<number> {
    if (!text) return 0;

    try {
      return await this.embedder.countTokens(text);
    } catch (error) {
      this.error(`Failed to tokenize: ${error}`);
      throw error;
    }
  }

  /**
   * Returns token IDs for the given text, excluding special tokens.
   *
   * WARNING: For large texts, this method may hang. Process line by line instead.
   *
   * @returns Array of token IDs (as numbers)
   */
  async getTokenIds(text: string): Promise<number[]> {
    if (!text) return [];

    try {
      return await this.embedder.getTokenIds(text);
    } catch (error) {
      this.error(`Failed to tokenize: ${error}`);
      throw error;
    }
  }

  static formatTokenCountShort(count: number): string {
    if (count < 1000) {
      return `${count} tokens`;
    } else if (count < 10000) {
      return `${(count / 1000).toFixed(1)}k tokens`;
    } else {
      return `${(count / 1000).toFixed(0)}k tokens`;
    }
  }
}
