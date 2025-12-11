import type { ConfigManager } from './ConfigManager';
import { WithLogging } from './WithLogging';
import { progressiveWait } from './utils';

/**
 * Base class for embedder implementations with common initialization logic
 * Implements progressive delay waiting pattern (1s, 5s, 10s, 30s, 60s, ...)
 * Supports both Transformers.js and llama.cpp backends
 */
export abstract class Embedder extends WithLogging {
  constructor(
    protected configManager: ConfigManager,
    private statusCallback: (status: string) => void
  ) {
    super();
  }

  /**
   * Update status via callback if set
   */
  protected updateStatus(status: string): void {
    this.statusCallback(status);
  }

  /**
   * Template method pattern: common initialization logic
   * Subclasses implement startInitialization() and checkReady()
   */
  async initialize(): Promise<void> {
    try {
      if (this.shouldUpdateStatusDuringWait()) {
        this.updateStatus('Loading model...');
      }

      // Start backend-specific initialization
      await this.startInitialization();

      // Wait with progressive delays
      await progressiveWait({
        checkReady: async () => {
          if (await this.checkReady()) {
            await this.onInitializationComplete();
            this.updateStatus('Ready');
            return true;
          }
          return false;
        },
        onStillWaiting: () => {
          this.log(
            `Still waiting... (Model download may take several minutes on first run)`
          );
          if (this.shouldUpdateStatusDuringWait()) {
            this.updateStatus('Still loading...');
          }
        },
      });
    } catch (error) {
      this.error(
        `Failed to initialize: ${error instanceof Error ? error.message : String(error)}`
      );
      this.updateStatus('Failed to initialize');
      throw error;
    }
  }

  /**
   * Start backend-specific initialization (non-blocking)
   * For llama.cpp: start server process
   * For Transformers: start worker RPC call
   */
  protected abstract startInitialization(): Promise<void>;

  /**
   * Check if initialization is complete
   * For llama.cpp: health check
   * For Transformers: check worker progress state
   */
  protected abstract checkReady(): Promise<boolean>;

  /**
   * Called when initialization completes successfully
   * Subclasses can override for additional setup
   */
  protected abstract onInitializationComplete(): Promise<void>;

  /**
   * Whether to update status during wait loop
   * Override to false if backend provides its own detailed progress
   */
  protected shouldUpdateStatusDuringWait(): boolean {
    return true;
  }

  abstract getEmbeddings(
    texts: string[],
    type?: 'query' | 'passage'
  ): Promise<number[][]>;

  /**
   * Counts the number of tokens in the given text.
   *
   * @param text - The text to tokenize
   * @returns The total number of tokens
   */
  abstract countTokens(text: string): Promise<number>;

  /**
   * Returns token IDs for the given text.
   *
   * @param text - The text to tokenize
   * @returns Array of token IDs (as numbers)
   */
  abstract getTokenIds(text: string): Promise<number[]>;

  /**
   * Decodes token IDs back to their string representations.
   *
   * @param tokenIds - Array of token IDs to decode
   * @returns Array of decoded token strings
   */
  abstract decodeTokenIds(tokenIds: number[]): Promise<string[]>;

  abstract getDevice(): string;
  abstract cleanup(): Promise<void>;
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
