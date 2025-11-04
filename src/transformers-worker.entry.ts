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

// Signal startup immediately for debugging
postMessage({ __kind: 'ready', ts: Date.now() } satisfies ReadyMessage);

// Configure environment for browser/Worker context
env.allowLocalModels = false; // Browser environment doesn't support local file access
env.useBrowserCache = true; // Cache models for offline use

const MODEL_ID = 'Xenova/bge-m3';

// Lazy initialization (avoid top-level await to reduce crash points)
// Note: Using Promise<any> because pipeline() with conditional dtype parameter
// produces a union type too complex for TypeScript to represent
let featureExtractorPromise: Promise<any> | null = null;
let tokenizerPromise: Promise<PreTrainedTokenizer> | null = null;

async function getFeatureExtractor(
  device: 'webgpu' | 'wasm',
  dtype: 'q8' | 'q4' | 'fp32'
): Promise<FeatureExtractionPipeline> {
  if (!featureExtractorPromise) {
    // Embedding extractor (HuggingFace calls this 'feature-extraction')
    featureExtractorPromise = pipeline('feature-extraction', MODEL_ID, {
      device,
      // WebGPU requires fp16 for optimal performance (hardware accelerated)
      // WASM uses quantized models (q8/q4) or fp32 for CPU efficiency
      dtype: device === 'webgpu' ? 'fp16' : dtype,
    });
  }
  return featureExtractorPromise;
}

async function getTokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = AutoTokenizer.from_pretrained(MODEL_ID);
  }
  return tokenizerPromise;
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
      const extractor = await getFeatureExtractor(params.device, params.dtype);
      const out = await extractor(params.texts, {
        pooling: 'cls',
        normalize: true,
      });
      result = out.tolist();
    } else if (method === 'countTokens') {
      const tok = await getTokenizer();
      const { input_ids } = await tok(params.text, {
        add_special_tokens: true,
      });
      result = Number(input_ids.size);
    } else if (method === 'getTokenIds') {
      const tok = await getTokenizer();
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
    console.error(`[Worker] Error in ${method}:`, err);
    const errorResponse: RPCResponse = {
      id,
      error: String(err?.message || err),
    };
    self.postMessage(errorResponse);
  }
});
