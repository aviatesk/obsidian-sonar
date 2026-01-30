import type { ChildProcess } from 'child_process';
import type { ConfigManager } from './ConfigManager';
import type { ModelStatus } from './SonarModelState';
import { WithLogging } from './WithLogging';
import { progressiveWait } from './utils';
import {
  isModelCached,
  downloadModel,
  getModelCachePath,
  findAvailablePort,
  llamaServerTokenize,
  llamaServerDetokenize,
  llamaServerGetEmbeddings,
  llamaServerHealthCheck,
  killServerProcess,
  startLlamaServer,
} from './llamaCppUtils';

/**
 * Embedding generation using llama.cpp
 * Manages llama.cpp server process and uses its API for embeddings and tokenization
 */
export class LlamaCppEmbedder extends WithLogging {
  protected readonly componentName = 'LlamaCppEmbedder';

  private _status: ModelStatus = 'uninitialized';
  private serverProcess: ChildProcess | null = null;
  private port: number | null = null;
  private exitHandlerBound: (() => void) | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor(
    private serverPath: string,
    private modelRepo: string,
    private modelFile: string,
    protected configManager: ConfigManager,
    private statusCallback: (status: string) => void,
    private onStatusChange: (status: ModelStatus) => void,
    private showNotice?: (msg: string, duration?: number) => void,
    private confirmDownload?: (modelId: string) => Promise<boolean>
  ) {
    super();
  }

  get status(): ModelStatus {
    return this._status;
  }

  private setStatus(status: ModelStatus): void {
    this._status = status;
    this.onStatusChange(status);
  }

  private updateStatusBar(status: string): void {
    this.statusCallback(status);
  }

  async initialize(): Promise<void> {
    this.setStatus('initializing');
    try {
      this.updateStatusBar('Loading model...');
      await this.startInitialization();

      await progressiveWait({
        checkReady: async () => {
          if (await this.checkReady()) {
            this.startHealthCheck();
            this.log(`Initialized on port ${this.port}`);
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
          this.updateStatusBar('Still loading...');
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

  private async startInitialization(): Promise<void> {
    this.log(`Initializing with model: ${this.modelRepo}/${this.modelFile}`);

    if (!isModelCached(this.modelRepo, this.modelFile)) {
      const modelId = `${this.modelRepo}/${this.modelFile}`;

      if (this.confirmDownload) {
        const confirmed = await this.confirmDownload(modelId);
        if (!confirmed) {
          throw new Error(
            `Download cancelled by user. ` +
              `To use a different model, change the settings and reinitialize.`
          );
        }
      }

      this.log(`Model not found in cache, downloading...`);
      await downloadModel(this.modelRepo, this.modelFile, progress => {
        if (progress.status === 'progress') {
          const percent = progress.percent.toFixed(0);
          this.updateStatusBar(`Loading: ${percent}%`);
        }
      });
      this.log(`Model downloaded`);
    } else {
      this.log(`Using cached model`);
    }

    this.port = await findAvailablePort();
    this.log(`Selected port: ${this.port}`);

    await this.startServer();
  }

  private get serverUrl(): string {
    if (!this.port) {
      throw new Error('Server port not initialized');
    }
    return `http://localhost:${this.port}`;
  }

  private async getTokenStats(
    texts: string[]
  ): Promise<{ total: number; max: number } | null> {
    try {
      const tokenCounts = await Promise.all(
        texts.map(async text => {
          const tokens = await this.httpTokenize(text);
          return tokens.length;
        })
      );
      return {
        total: tokenCounts.reduce((sum, count) => sum + count, 0),
        max: Math.max(...tokenCounts),
      };
    } catch {
      return null;
    }
  }

  private async httpGetEmbeddings(texts: string[]): Promise<number[][]> {
    try {
      return await llamaServerGetEmbeddings(this.serverUrl, texts);
    } catch (error) {
      this.error('Embedding request error:', error);
      const tokenStats = await this.getTokenStats(texts);
      if (tokenStats) {
        this.error(
          `Request context: ${texts.length} texts, ${tokenStats.total} tokens total, ${tokenStats.max} tokens max`
        );
      } else {
        this.error(
          `Request context: ${texts.length} texts, ${texts.reduce((sum, t) => sum + t.length, 0)} chars total`
        );
      }
      throw new Error(
        `Batch embedding failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async httpTokenize(text: string): Promise<number[]> {
    try {
      return await llamaServerTokenize(this.serverUrl, text);
    } catch (error) {
      this.error('Tokenize request error:', error);
      this.error(`Text context: ${text.length} chars`);
      throw new Error(
        `Tokenization failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async httpHealthCheck(): Promise<boolean> {
    return llamaServerHealthCheck(this.serverUrl);
  }

  private async checkReady(): Promise<boolean> {
    if (!this.port) {
      return false;
    }
    return await this.httpHealthCheck();
  }

  private async startServer(): Promise<void> {
    if (!this.port) {
      throw new Error('Port not selected');
    }

    const modelPath = getModelCachePath(this.modelRepo, this.modelFile);

    const maxChunkSize = this.configManager.get('maxChunkSize');
    const chunkOverlap = this.configManager.get('chunkOverlap');
    const batchSize = this.configManager.get('indexingBatchSize');
    const ubatchSize = batchSize * (maxChunkSize + chunkOverlap);

    this.log(
      `Starting llama.cpp server (port: ${this.port}, ubatch-size: ${ubatchSize})...`
    );

    const args = [
      '--model',
      modelPath,
      '--port',
      this.port.toString(),
      '--embedding',
      // --parallel 1: Process one request at a time (client already batches texts)
      // -kvu: Disable auto n_parallel=4 detection, use explicit --parallel value
      '--parallel',
      '1',
      '-kvu',
      // --ubatch-size: Max tokens per batch (controls actual batch processing performance)
      '--ubatch-size',
      ubatchSize.toString(),
      '-lv',
      '0',
    ];

    const result = await startLlamaServer({
      serverPath: this.serverPath,
      args,
      logger: this.configManager.getLogger(),
      showNotice: this.showNotice,
      onExit: () => {
        if (this.healthCheckInterval) {
          clearInterval(this.healthCheckInterval);
          this.healthCheckInterval = null;
        }
      },
      serverType: 'llama.cpp embedder server',
    });

    this.serverProcess = result.process;
    this.exitHandlerBound = result.exitHandler;
  }

  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(async () => {
      if (!this.port) {
        return;
      }
      const isHealthy = await this.httpHealthCheck();
      if (!isHealthy) {
        this.warn(`llama.cpp server on port ${this.port} became unresponsive`);
        // Don't auto-restart for now, just log the issue
        // In the future, could implement auto-restart logic here
      }
    }, 60000);
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    if (!this.port) {
      throw new Error('Embedder not initialized. Call initialize() first.');
    }
    return await this.httpGetEmbeddings(texts);
  }

  async countTokens(text: string): Promise<number> {
    if (!this.port) {
      throw new Error('Embedder not initialized. Call initialize() first.');
    }
    const tokens = await this.httpTokenize(text);
    return tokens.length;
  }

  async getTokenIds(text: string): Promise<number[]> {
    if (!this.port) {
      throw new Error('Embedder not initialized. Call initialize() first.');
    }
    return await this.httpTokenize(text);
  }

  async decodeTokenIds(tokenIds: number[]): Promise<string[]> {
    if (!this.port) {
      throw new Error('Embedder not initialized. Call initialize() first.');
    }
    const decoded = await Promise.all(
      tokenIds.map(id => llamaServerDetokenize(this.serverUrl, [id]))
    );
    return decoded;
  }

  async cleanup(): Promise<void> {
    this.log(`Cleaning up...`);

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.exitHandlerBound) {
      process.off('exit', this.exitHandlerBound);
      process.off('SIGINT', this.exitHandlerBound);
      process.off('SIGTERM', this.exitHandlerBound);
      this.exitHandlerBound = null;
    }

    if (this.serverProcess) {
      this.log(`Stopping server on port ${this.port}`);
      await killServerProcess(this.serverProcess, this.configManager.logger);
      this.serverProcess = null;
    }

    this.port = null;

    this.log(`Completed cleanup`);
  }
}
