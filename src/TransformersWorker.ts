import type { Logger } from './Logger';
import { WORKER_MJS_TEXT } from './generated/transformers-worker-inline';
import type {
  RPCRequest,
  RPCResponse,
  ReadyMessage,
  RPCMethodReturnTypes,
} from './transformers-worker-types';

/**
 * Web Worker manager for Transformers.js
 *
 * Architecture:
 * - Creates a Module Worker from Blob URL containing inlined ESM code
 * - Worker code is pre-built by esbuild-worker.mjs and inlined via emit-worker-inline.mjs
 * - Avoids CORS/same-origin issues that occur with file-based Workers in Obsidian/Electron
 * - Uses RPC pattern with message ID tracking for async communication
 *
 * Lifecycle:
 * 1. Constructor: Starts initialization (async)
 * 2. initialize(): Creates Worker, sets up listeners, waits for ready signal
 * 3. call(): Sends RPC request to Worker, returns Promise
 * 4. cleanup(): Terminates Worker and clears pending requests
 *
 * Compatibility:
 * - Works in Obsidian/Electron environment (renderer process)
 * - Worker uses environment spoofing to prevent Transformers.js from loading onnxruntime-node
 * - Supports both WebGPU and WASM backends
 */
export class TransformersWorker {
  private worker: Worker | null = null;
  private messageId = 0;
  private pendingRequests = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: any) => void }
  >();
  private initPromise: Promise<void>;

  constructor(private logger: Logger) {
    this.initPromise = this.initialize();
  }

  private async initialize(): Promise<void> {
    this.logger.log('Initializing Transformers.js Worker');

    try {
      // Create Blob URL from inlined Worker code
      const blob = new Blob([WORKER_MJS_TEXT], { type: 'text/javascript' });
      const workerUrl = URL.createObjectURL(blob);

      // Create Module Worker from Blob URL
      const worker = new Worker(workerUrl, {
        type: 'module',
        name: 'transformers-embed-worker',
      });

      // Set up error listener BEFORE message listener
      worker.addEventListener('error', (event: ErrorEvent) => {
        this.logger.error(`Worker error details:`);
        this.logger.error(`  message: ${event.message}`);
        this.logger.error(`  filename: ${event.filename}`);
        this.logger.error(`  lineno: ${event.lineno}`);
        this.logger.error(`  colno: ${event.colno}`);
        this.logger.error(`  error object: ${JSON.stringify(event.error)}`);
        this.logger.error(`  event type: ${event.type}`);
      });

      worker.addEventListener('messageerror', (event: MessageEvent) => {
        this.logger.error(
          `Worker message error: ${JSON.stringify(event.data)}`
        );
      });

      // Set up message listener
      worker.addEventListener('message', this.handleMessage.bind(this));

      this.worker = worker;

      // Wait for ready signal from Worker
      await this.waitForReady();
      this.logger.log('Transformers.js Worker ready');
    } catch (error) {
      this.logger.error(`Failed to initialize Worker: ${error}`);
      throw error;
    }
  }

  private async waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Worker ready timeout'));
      }, 30000);

      const listener = (event: MessageEvent) => {
        const data = event.data as ReadyMessage | RPCResponse;
        if ('__kind' in data && data.__kind === 'ready') {
          clearTimeout(timeout);
          this.worker?.removeEventListener('message', listener);
          resolve();
        }
      };

      this.worker?.addEventListener('message', listener);
    });
  }

  private handleMessage(event: MessageEvent): void {
    const data = event.data as RPCResponse;
    const { id, result, error } = data;
    if (typeof id !== 'string') return;

    const pending = this.pendingRequests.get(id);
    if (!pending) return;

    this.pendingRequests.delete(id);

    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve(result);
    }
  }

  /**
   * Call a method on the Worker (type-safe with automatic return type inference)
   */
  async call<M extends RPCRequest['method']>(
    method: M,
    params: Extract<RPCRequest, { method: M }>['params'],
    timeout: number = 120000
  ): Promise<RPCMethodReturnTypes[M]> {
    await this.initPromise;

    if (!this.worker) {
      throw new Error('Worker not initialized');
    }

    return new Promise((resolve, reject) => {
      const id = `${this.messageId++}-${Date.now()}`;
      this.pendingRequests.set(id, { resolve, reject });

      const request = {
        id,
        method,
        params,
      } as RPCRequest;

      this.worker!.postMessage(request);

      // Timeout (default: 120 seconds for model loading)
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          this.logger.error(`Worker request timeout: ${method}`);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, timeout);
    });
  }

  isReady(): boolean {
    return this.worker !== null;
  }

  cleanup(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pendingRequests.clear();
  }
}
