import type { ConfigManager } from './ConfigManager';
import { TransformersWorker } from './TransformersWorker';
import { WithLogging } from './WithLogging';

/**
 * Embedding generation using Transformers.js in Web Worker
 * Web Worker runs in pure browser environment, avoiding worker_threads issues
 */
export class Embedder extends WithLogging {
  protected readonly componentName = 'Embedder';
  private worker: TransformersWorker;

  constructor(
    private modelId: string,
    protected configManager: ConfigManager,
    private device: 'webgpu' | 'wasm' = 'wasm',
    private dtype: 'q8' | 'q4' | 'fp32' = 'q8'
  ) {
    super();
    // Check WebGPU availability
    const hasWebGPU = navigator.gpu !== undefined;
    if (this.device === 'webgpu' && !hasWebGPU) {
      this.warn('WebGPU not available, falling back to WASM');
      this.device = 'wasm';
    }

    this.worker = new TransformersWorker(configManager.getLogger());
    this.log(
      `Initialized with ${this.modelId} (${this.device}, ${this.dtype})`
    );
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    // WebGPU has memory limitations for large batches
    // Process in smaller batches to avoid buffer allocation errors
    const MAX_BATCH_SIZE = this.device === 'webgpu' ? 1 : 32;

    if (texts.length <= MAX_BATCH_SIZE) {
      return this.worker.call('embeddings', {
        texts,
        modelId: this.modelId,
        device: this.device,
        dtype: this.dtype,
      });
    }

    this.log(
      `Generating embeddings for ${texts.length} texts (batches of ${MAX_BATCH_SIZE})...`
    );
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + MAX_BATCH_SIZE);
      const batchResults = await this.worker.call('embeddings', {
        texts: batch,
        modelId: this.modelId,
        device: this.device,
        dtype: this.dtype,
      });
      results.push(...batchResults);
    }
    return results;
  }

  async countTokens(text: string): Promise<number> {
    return this.worker.call('countTokens', {
      text,
      modelId: this.modelId,
    });
  }

  async getTokenIds(text: string): Promise<number[]> {
    return this.worker.call('getTokenIds', {
      text,
      modelId: this.modelId,
    });
  }

  getDevice(): 'webgpu' | 'wasm' {
    return this.device;
  }

  cleanup(): void {
    this.worker.cleanup();
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
