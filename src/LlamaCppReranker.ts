import type { ChildProcess } from 'child_process';
import type { ConfigManager } from './ConfigManager';
import { WithLogging } from './WithLogging';
import {
  isModelCached,
  downloadModel,
  getModelCachePath,
  findAvailablePort,
  killServerProcess,
  startLlamaServer,
  waitForServerReady,
} from './llamaCppUtils';
import type { Reranker, RerankResult } from './Reranker';

/**
 * Cross-encoder reranking using llama.cpp server
 * Manages a separate llama.cpp server process for reranking
 */
export class LlamaCppReranker extends WithLogging implements Reranker {
  protected readonly componentName = 'LlamaCppReranker';

  private serverProcess: ChildProcess | null = null;
  private port: number | null = null;
  private exitHandlerBound: (() => void) | null = null;
  private ready = false;

  constructor(
    private serverPath: string,
    private modelRepo: string,
    private modelFile: string,
    protected configManager: ConfigManager,
    private showNotice?: (msg: string, duration?: number) => void
  ) {
    super();
  }

  async initialize(): Promise<void> {
    this.log(`Initializing with model: ${this.modelRepo}/${this.modelFile}`);

    if (!isModelCached(this.modelRepo, this.modelFile)) {
      this.log(`Model not found in cache, downloading...`);
      await downloadModel(this.modelRepo, this.modelFile, progress => {
        if (progress.status === 'progress') {
          const percent = progress.percent.toFixed(0);
          this.log(`Downloading: ${percent}%`);
        }
      });
      this.log(`Model downloaded`);
    } else {
      this.log(`Using cached model`);
    }

    this.port = await findAvailablePort();
    this.log(`Selected port: ${this.port}`);

    await this.startServer();
    await this.waitForReady();
    this.log(`Initialized on port ${this.port}`);
  }

  private get serverUrl(): string {
    if (!this.port) {
      throw new Error('Server port not initialized');
    }
    return `http://localhost:${this.port}`;
  }

  private async startServer(): Promise<void> {
    if (!this.port) {
      throw new Error('Port not selected');
    }

    const modelPath = getModelCachePath(this.modelRepo, this.modelFile);

    this.log(`Starting llama.cpp reranker server (port: ${this.port})...`);

    const args = [
      '--model',
      modelPath,
      '--port',
      this.port.toString(),
      '--reranking',
      '--pooling',
      'rank',
      // --parallel 1: Process one request at a time (matches SearchManager queue)
      // -kvu: Disable auto n_parallel=4 detection, use explicit --parallel value
      '--parallel',
      '1',
      '-kvu',
      '--ubatch-size',
      '8192',
      '--batch-size',
      '8192',
      '-lv',
      '0',
    ];

    const result = await startLlamaServer({
      serverPath: this.serverPath,
      args,
      logger: this.configManager.getLogger(),
      showNotice: this.showNotice,
      onExit: () => {
        this.ready = false;
      },
      serverType: 'llama.cpp reranker server',
    });

    this.serverProcess = result.process;
    this.exitHandlerBound = result.exitHandler;
  }

  private async waitForReady(): Promise<void> {
    await waitForServerReady(this.serverUrl, this.configManager.getLogger());
    this.ready = true;
  }

  /**
   * Rerank documents against a query
   * @param query The query string
   * @param documents Array of document strings to rerank
   * @param topN Number of top results to return (optional, returns all if not specified)
   * @returns Array of RerankResult sorted by relevance score (descending)
   */
  async rerank(
    query: string,
    documents: string[],
    topN?: number
  ): Promise<RerankResult[]> {
    if (!this.ready || !this.port) {
      throw new Error('Reranker not initialized. Call initialize() first.');
    }

    const response = await fetch(`${this.serverUrl}/v1/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        documents,
        top_n: topN ?? documents.length,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Rerank request failed: ${response.status} ${response.statusText}. Body: ${errorText}`
      );
    }

    const data = (await response.json()) as {
      results: Array<{ index: number; relevance_score: number }>;
    };

    if (!data.results || !Array.isArray(data.results)) {
      throw new Error('Invalid rerank response from llama.cpp API');
    }

    return data.results.map(r => ({
      index: r.index,
      relevanceScore: r.relevance_score,
    }));
  }

  isReady(): boolean {
    return this.ready;
  }

  async cleanup(): Promise<void> {
    this.log(`Cleaning up...`);

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
    this.ready = false;

    this.log(`Completed cleanup`);
  }
}
