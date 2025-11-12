import type { ConfigManager } from './ConfigManager';
import { Embedder } from './Embedder';
import { TransformersWorker } from './TransformersWorker';

/**
 * Embedding generation using Transformers.js in Web Worker
 * Web Worker runs in pure browser environment, avoiding worker_threads issues
 */
export class TransformersEmbedder extends Embedder {
  protected readonly componentName = 'Embedder';
  private worker: TransformersWorker;
  private initPromise: Promise<void> | null = null;

  constructor(
    private modelId: string,
    private device: 'webgpu' | 'wasm' = 'wasm',
    private dtype: 'q8' | 'q4' | 'fp16' | 'fp32' = 'q8',
    configManager: ConfigManager,
    statusCallback: (status: string) => void
  ) {
    super(configManager, statusCallback);
    this.worker = new TransformersWorker(configManager, statusCallback);
  }

  protected async startInitialization(): Promise<void> {
    this.log(
      `Initializing with ${this.modelId} (${this.device}, ${this.dtype})`
    );

    // Start model initialization (non-blocking, sends progress messages)
    this.initPromise = this.worker.call(
      'initializeModel',
      {
        modelId: this.modelId,
        device: this.device,
        dtype: this.dtype,
      },
      600000 // 10 minutes timeout
    );
  }

  protected async checkReady(): Promise<boolean> {
    return this.worker.isModelReady();
  }

  protected async onInitializationComplete(): Promise<void> {
    // Ensure RPC promise completes
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
    this.log(`Initialized with ${this.modelId}`);
  }

  protected shouldUpdateStatusDuringWait(): boolean {
    // TransformersWorker provides detailed progress, don't override
    return false;
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    return this.worker.call('embeddings', { texts });
  }

  async countTokens(text: string): Promise<number> {
    return this.worker.call('countTokens', { text });
  }

  async getTokenIds(text: string): Promise<number[]> {
    return this.worker.call('getTokenIds', { text });
  }

  getDevice(): 'webgpu' | 'wasm' {
    return this.device;
  }

  cleanup(): void {
    this.worker.cleanup();
  }
}
