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
  type FeatureExtractionPipeline,
} from '@huggingface/transformers';
import type {
  RPCRequest,
  RPCResponse,
  ReadyMessage,
} from './transformers-worker-types';

// Logging helpers (follows same format as main.ts)
const COMPONENT_NAME = 'transformers-worker';

function log(msg: string): void {
  console.log(`[Sonar.${COMPONENT_NAME}] ${msg}`);
}

function error(msg: string): void {
  console.error(`[Sonar.${COMPONENT_NAME}] ${msg}`);
}

// Configure environment for browser/Worker context
env.allowLocalModels = false; // Browser environment doesn't support local file access
env.useBrowserCache = true; // Cache models for offline use

// Lazy initialization (avoid top-level await to reduce crash points)
// Note: Using Promise<any> because pipeline() with conditional dtype parameter
// produces a union type too complex for TypeScript to represent
// Cache by modelId to support model switching
const featureExtractorCache = new Map<string, Promise<any>>();
const tokenizerCache = new Map<string, Promise<PreTrainedTokenizer>>();

async function getFeatureExtractor(
  modelId: string,
  device: 'webgpu' | 'wasm',
  dtype: 'q8' | 'q4' | 'fp32'
): Promise<FeatureExtractionPipeline> {
  const cacheKey = `${modelId}-${device}-${dtype}`;
  if (!featureExtractorCache.has(cacheKey)) {
    // Embedding extractor (HuggingFace calls this 'feature-extraction')
    const promise = pipeline('feature-extraction', modelId, {
      device,
      // WebGPU requires fp16 for optimal performance (hardware accelerated)
      // WASM uses quantized models (q8/q4) or fp32 for CPU efficiency
      dtype: device === 'webgpu' ? 'fp16' : dtype,
    });
    featureExtractorCache.set(cacheKey, promise);
    log(
      `Created feature extractor cache for ${modelId} with device=${device}, dtype=${dtype}`
    );
  }
  return featureExtractorCache.get(cacheKey)!;
}

async function getTokenizer(modelId: string) {
  if (!tokenizerCache.has(modelId)) {
    tokenizerCache.set(modelId, AutoTokenizer.from_pretrained(modelId));
    log(`Created tokenizer cache for ${modelId}`);
  }
  return tokenizerCache.get(modelId)!;
}

// Message handler
self.addEventListener('message', async (e: MessageEvent) => {
  const data = e.data as Partial<RPCRequest>;

  // Ignore ready acknowledgment and invalid messages
  if (!data.id || !data.method || !data.params) return;

  const { id, method, params } = data as RPCRequest;

  try {
    let result: unknown;

    if (method === 'embeddings') {
      const extractor = await getFeatureExtractor(
        params.modelId,
        params.device,
        params.dtype
      );
      const out = await extractor(params.texts, {
        pooling: 'cls',
        normalize: true,
      });
      result = out.tolist();
    } else if (method === 'countTokens') {
      const tok = await getTokenizer(params.modelId);
      const { input_ids } = await tok(params.text, {
        add_special_tokens: true,
      });
      result = Number(input_ids.size);
    } else if (method === 'getTokenIds') {
      const tok = await getTokenizer(params.modelId);
      const ids = tok.encode(params.text, {
        add_special_tokens: true,
      });
      result = Array.from(ids) as number[];
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

log('Ready');
