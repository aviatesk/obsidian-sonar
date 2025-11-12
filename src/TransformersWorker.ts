import type { ConfigManager } from './ConfigManager';
import { WithLogging } from './WithLogging';
import { WORKER_MJS_TEXT } from './generated/transformers-worker-inline';
import type {
  RPCRequest,
  RPCResponse,
  ReadyMessage,
  InitMessage,
  UpdateLogLevelMessage,
  ProgressMessage,
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
export class TransformersWorker extends WithLogging {
  protected readonly componentName = 'TransformersWorker';
  private worker: Worker | null = null;
  private messageId = 0;
  private pendingRequests = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: any) => void }
  >();
  private initPromise: Promise<void>;
  private unsubscribeLogLevel?: () => void;
  private lastProgressTime: number = 0;
  private modelReady: boolean = false;

  constructor(
    protected configManager: ConfigManager,
    private statusCallback: (status: string) => void
  ) {
    super();
    this.initPromise = this.initialize();
    this.setupLogLevelListener();
  }

  private setupLogLevelListener(): void {
    this.unsubscribeLogLevel = this.configManager.subscribe(
      'debugMode',
      (_key, value) => {
        this.updateLogLevel(value as 'error' | 'warn' | 'log');
      }
    );
  }

  private updateLogLevel(logLevel: 'error' | 'warn' | 'log'): void {
    if (!this.worker) {
      return;
    }
    const msg: UpdateLogLevelMessage = {
      __kind: 'update-log-level',
      logLevel,
    };
    this.worker.postMessage(msg);
    this.log(`Log level updated to: ${logLevel}`);
  }

  private async initialize(): Promise<void> {
    this.log('Initializing...');

    try {
      const blob = new Blob([WORKER_MJS_TEXT], { type: 'text/javascript' });
      const workerUrl = URL.createObjectURL(blob);

      const worker = new Worker(workerUrl, {
        type: 'module',
        name: 'transformers-embed-worker',
      });

      // Set up error listener BEFORE message listener
      worker.addEventListener('error', (event: ErrorEvent) => {
        this.error(`Worker error details:`);
        this.error(`  message: ${event.message}`);
        this.error(`  filename: ${event.filename}`);
        this.error(`  lineno: ${event.lineno}`);
        this.error(`  colno: ${event.colno}`);
        this.error(`  error object: ${JSON.stringify(event.error)}`);
        this.error(`  event type: ${event.type}`);
      });

      worker.addEventListener('messageerror', (event: MessageEvent) => {
        this.error(`Worker message error: ${JSON.stringify(event.data)}`);
      });

      worker.addEventListener('message', this.handleMessage.bind(this));

      this.worker = worker;

      await this.waitForReady();

      const logLevel = this.configManager.get('debugMode');
      const initMsg: InitMessage = {
        __kind: 'init',
        logLevel,
      };
      worker.postMessage(initMsg);

      this.log('Initialized');
    } catch (error) {
      this.error(`Failed to initialize: ${error}`);
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
    const data = event.data;

    // Handle progress messages
    if ('__kind' in data && data.__kind === 'progress') {
      const progressMsg = data as ProgressMessage;
      this.lastProgressTime = Date.now();
      if (progressMsg.status === 'ready') {
        this.modelReady = true;
        this.log('Model loaded');
        this.statusCallback('Model loaded');
      } else if (progressMsg.status === 'progress' && progressMsg.file) {
        const percent = progressMsg.progress
          ? progressMsg.progress.toFixed(0)
          : '?';
        this.statusCallback(`Loading: ${percent}%`);
      }
      return;
    }

    // Handle RPC responses
    const rpcData = data as RPCResponse;
    const { id, result, error } = rpcData;
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
    timeout: number = 60000
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

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          this.error(`Worker request timeout: ${method}`);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, timeout);
    });
  }

  isReady(): boolean {
    return this.worker !== null;
  }

  isModelReady(): boolean {
    return this.modelReady;
  }

  getTimeSinceLastProgress(): number {
    if (this.lastProgressTime === 0) {
      return Infinity;
    }
    return Date.now() - this.lastProgressTime;
  }

  cleanup(): void {
    if (this.unsubscribeLogLevel) {
      this.unsubscribeLogLevel();
      this.unsubscribeLogLevel = undefined;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pendingRequests.clear();
  }
}
