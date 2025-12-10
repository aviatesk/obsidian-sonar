/**
 * Web Worker for Transformers.js (ESM Module Worker)
 * Entry point for file-based Worker (not Blob-based)
 * This avoids Blob+ESM compatibility issues in Obsidian/Electron
 */

//# sourceURL=transformers-worker.mjs

// Force Transformers.js to recognize this as a Web/Browser environment
// This prevents it from trying to use onnxruntime-node (which requires worker_threads)
// See: https://github.com/huggingface/transformers.js/issues/1240
delete (globalThis as any).process;

import {
  pipeline,
  AutoTokenizer,
  env,
  type PreTrainedTokenizer,
} from '@huggingface/transformers';
import type {
  RPCRequest,
  RPCResponse,
  ReadyMessage,
  InitMessage,
  UpdateLogLevelMessage,
  ProgressMessage,
} from './transformers-worker-types';
import { type LogLevel, LOG_LEVEL_ORDER } from './config';
import {
  countTokensTransformers,
  getTokenIdsTransformers,
} from './transformers-tokenizer-utils';

// Logging helpers (follows same format as main.ts)
const COMPONENT_NAME = 'transformers-worker';

// Log level state (default: 'error')
let currentLogLevel: LogLevel = 'error';

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_ORDER[level] <= LOG_LEVEL_ORDER[currentLogLevel];
}

function log(msg: string): void {
  if (shouldLog('log')) {
    console.log(`[Sonar.${COMPONENT_NAME}] ${msg}`);
  }
}

function error(msg: string): void {
  if (shouldLog('error')) {
    console.error(`[Sonar.${COMPONENT_NAME}] ${msg}`);
  }
}

// Configure environment for browser/Worker context
env.allowLocalModels = false; // Browser environment doesn't support local file access
env.useBrowserCache = true; // Cache models for offline use

// Model state (one Worker = one model configuration)
// Note: Using 'any' for featureExtractor because pipeline() with conditional dtype parameter
// produces a union type too complex for TypeScript to represent
let featureExtractor: any = null;
let tokenizer: PreTrainedTokenizer | null = null;

function createProgressCallback() {
  return (progressInfo: any) => {
    const msg: ProgressMessage = {
      __kind: 'progress',
      status: progressInfo.status,
      name: progressInfo.name,
      file: progressInfo.file,
      progress: progressInfo.progress,
      loaded: progressInfo.loaded,
      total: progressInfo.total,
    };
    self.postMessage(msg);
  };
}

async function initializeModel(
  modelId: string,
  device: 'webgpu' | 'wasm',
  dtype: 'q8' | 'q4' | 'fp16' | 'fp32'
): Promise<void> {
  log(`Initializing model: ${modelId} (device=${device}, dtype=${dtype})`);

  featureExtractor = await pipeline('feature-extraction', modelId, {
    device,
    dtype,
    progress_callback: createProgressCallback(),
  });

  tokenizer = await AutoTokenizer.from_pretrained(modelId, {
    progress_callback: createProgressCallback(),
  });

  log(`Model initialized: ${modelId}`);
}

// Message handler
self.addEventListener('message', async (e: MessageEvent) => {
  const data = e.data;

  if (data?.__kind === 'init') {
    const initMsg = data as InitMessage;
    currentLogLevel = initMsg.logLevel;
    log(`Ready (Log level set to ${currentLogLevel})`);
    return;
  }

  if (data?.__kind === 'update-log-level') {
    const updateMsg = data as UpdateLogLevelMessage;
    currentLogLevel = updateMsg.logLevel;
    log(`Log level updated to: ${currentLogLevel}`);
    return;
  }

  const rpcData = data as Partial<RPCRequest>;

  // Ignore ready acknowledgment and invalid messages
  if (!rpcData.id || !rpcData.method || !rpcData.params) return;

  const { id, method, params } = rpcData as RPCRequest;

  try {
    let result: unknown;

    if (method === 'initializeModel') {
      await initializeModel(params.modelId, params.device, params.dtype);
      result = undefined;
    } else if (method === 'embeddings') {
      if (!featureExtractor) {
        throw new Error('Model not initialized. Call initializeModel first.');
      }
      const out = await featureExtractor(params.texts, {
        pooling: 'mean',
        normalize: true,
      });
      result = out.tolist();
    } else if (method === 'countTokens') {
      if (!tokenizer) {
        throw new Error('Model not initialized. Call initializeModel first.');
      }
      result = await countTokensTransformers(tokenizer, params.text);
    } else if (method === 'getTokenIds') {
      if (!tokenizer) {
        throw new Error('Model not initialized. Call initializeModel first.');
      }
      result = getTokenIdsTransformers(tokenizer, params.text);
    } else if (method === 'decodeTokenIds') {
      if (!tokenizer) {
        throw new Error('Model not initialized. Call initializeModel first.');
      }
      // Decode each token ID individually to get individual token strings
      result = params.tokenIds.map(id => tokenizer!.decode([id]));
    } else {
      const exhaustiveCheck: never = method;
      throw new Error(`Unknown method: ${exhaustiveCheck}`);
    }
    const response: RPCResponse = { id, result };
    self.postMessage(response);
  } catch (err: any) {
    error(`Failed to ${method}: ${err?.message || err}`);
    const errorResponse: RPCResponse = {
      id,
      error: String(err?.message || err),
    };
    self.postMessage(errorResponse);
  }
});

postMessage({ __kind: 'ready', ts: Date.now() } satisfies ReadyMessage);
