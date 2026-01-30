import type { ConfigManager } from './ConfigManager';
import type { ModelStatus } from './SonarModelState';
import { WithLogging } from './WithLogging';
import { progressiveWait } from './utils';

/**
 * Base class for embedder implementations with common initialization logic
 * Implements progressive delay waiting pattern (1s, 5s, 10s, 30s, 60s, ...)
 */
export abstract class Embedder extends WithLogging {
  private _status: ModelStatus = 'uninitialized';

  constructor(
    protected configManager: ConfigManager,
    private statusCallback: (status: string) => void,
    private onStatusChange?: (status: ModelStatus) => void
  ) {
    super();
  }

  get status(): ModelStatus {
    return this._status;
  }

  private setStatus(status: ModelStatus): void {
    this._status = status;
    this.onStatusChange?.(status);
  }

  /**
   * Update status bar text via callback
   */
  protected updateStatusBar(status: string): void {
    this.statusCallback(status);
  }

  /**
   * Template method pattern: common initialization logic
   * Subclasses implement startInitialization() and checkReady()
   */
  async initialize(): Promise<void> {
    this.setStatus('initializing');
    try {
      if (this.shouldUpdateStatusDuringWait()) {
        this.updateStatusBar('Loading model...');
      }

      // Start backend-specific initialization
      await this.startInitialization();

      // Wait with progressive delays
      await progressiveWait({
        checkReady: async () => {
          if (await this.checkReady()) {
            await this.onInitializationComplete();
            this.setStatus('ready');
            this.updateStatusBar('Ready');
            return true;
          }
          return false;
        },
        onStillWaiting: () => {
          this.log(
            `Still waiting... (Model download may take several minutes on first run)`
          );
          if (this.shouldUpdateStatusDuringWait()) {
            this.updateStatusBar('Still loading...');
          }
        },
      });
    } catch (error) {
      this.setStatus('failed');
      this.error(
        `Failed to initialize: ${error instanceof Error ? error.message : String(error)}`
      );
      this.updateStatusBar('Failed to initialize');
      throw error;
    }
  }

  /**
   * Start backend-specific initialization (non-blocking)
   */
  protected abstract startInitialization(): Promise<void>;

  /**
   * Check if initialization is complete
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

  abstract cleanup(): Promise<void>;
}
