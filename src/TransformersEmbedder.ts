import type { ConfigManager } from './ConfigManager';
import type { Embedder } from './Embedder';
import { TransformersWorker } from './TransformersWorker';
import { WithLogging } from './WithLogging';

/**
 * Embedding generation using Transformers.js in Web Worker
 * Web Worker runs in pure browser environment, avoiding worker_threads issues
 */
export class TransformersEmbedder extends WithLogging implements Embedder {
  protected readonly componentName = 'Embedder';
  private worker: TransformersWorker;

  constructor(
    private modelId: string,
    protected configManager: ConfigManager,
    private device: 'webgpu' | 'wasm' = 'wasm',
    private dtype: 'q8' | 'q4' | 'fp16' | 'fp32' = 'q8'
  ) {
    super();
    const hasWebGPU = navigator.gpu !== undefined;
    if (this.device === 'webgpu' && !hasWebGPU) {
      this.warn('WebGPU not available, falling back to WASM');
      this.device = 'wasm';
    }
    this.worker = new TransformersWorker(configManager);
    this.log(
      `Initialized with ${this.modelId} (${this.device}, ${this.dtype})`
    );
  }

  async getEmbeddings(
    texts: string[],
    type?: 'query' | 'passage'
  ): Promise<number[][]> {
    // Add model-specific prefixes for better retrieval performance
    const prefixedTexts = this.addModelPrefixes(texts, type);

    return this.worker.call('embeddings', {
      texts: prefixedTexts,
      modelId: this.modelId,
      device: this.device,
      dtype: this.dtype,
    });
  }

  private addModelPrefixes(
    texts: string[],
    type?: 'query' | 'passage'
  ): string[] {
    if (this.modelId.includes('e5')) {
      const prefix = type === 'query' ? 'query: ' : 'passage: ';
      return texts.map(text => prefix + text);
    }
    return texts;
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
}
