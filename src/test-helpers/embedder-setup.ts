import { AutoTokenizer } from '@huggingface/transformers';
import type { PreTrainedTokenizer } from '@huggingface/transformers/types/base/processing_utils';
import type { Embedder } from '../Embedder';
import {
  isModelCached,
  downloadModel,
  getModelCachePath,
  findAvailablePort,
  llamaServerTokenize,
  llamaServerHealthCheck,
} from '../llamaCppUtils';
import {
  countTokensTransformers,
  getTokenIdsTransformers,
} from '../transformers-tokenizer-utils';
import { DEFAULT_SETTINGS } from '../config';
import { spawn, type ChildProcess } from 'child_process';

export type TestEmbedder = Pick<Embedder, 'countTokens' | 'getTokenIds'>;

export interface TestEmbedderSetupInfo {
  name: string;
  embedder: TestEmbedder;
}

class LlamaServerTestEmbedder implements TestEmbedder {
  constructor(private serverUrl: string) {}

  async countTokens(text: string): Promise<number> {
    const tokens = await this.getTokenIds(text);
    return tokens.length;
  }

  async getTokenIds(text: string): Promise<number[]> {
    return llamaServerTokenize(this.serverUrl, text);
  }
}

interface TestContext {
  llamaServerProcess: ChildProcess | null;
  llamaServerPort: number | null;
}

const context: TestContext = {
  llamaServerProcess: null,
  llamaServerPort: null,
};

/**
 * Start llama-server process
 * Uses same arguments as LlamaCppEmbedder for consistency
 */
async function startLlamaServer(
  serverPath: string,
  modelPath: string,
  port: number
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    // Use fixed ubatch-size for testing (same as production default calculation)
    const ubatchSize = 512;

    const args = [
      '--model',
      modelPath,
      '--port',
      port.toString(),
      '--embedding',
      '--ubatch-size',
      ubatchSize.toString(),
      '-lv',
      '0',
    ];

    const process = spawn(serverPath, args, {
      stdio: 'pipe',
      detached: false,
    });

    process.on('error', error => {
      reject(new Error(`Failed to start llama-server: ${error.message}`));
    });

    // Wait a bit for server to start, then resolve
    setTimeout(() => resolve(process), 2000);
  });
}

/**
 * Setup llama.cpp embedder for testing
 * Throws an error if setup fails
 */
async function setupLlamaCppEmbedder(): Promise<TestEmbedderSetupInfo> {
  const serverPath = DEFAULT_SETTINGS.llamacppServerPath;
  const modelRepo = DEFAULT_SETTINGS.llamaEmbedderModelRepo;
  const modelFile = DEFAULT_SETTINGS.llamaEmbedderModelFile;
  if (!isModelCached(modelRepo, modelFile)) {
    console.log(`Downloading model: ${modelRepo}/${modelFile}...`);
    await downloadModel(modelRepo, modelFile);
    console.log('Model downloaded');
  }

  const modelPath = getModelCachePath(modelRepo, modelFile);
  const port = await findAvailablePort();

  console.log(`Starting llama-server on port ${port}...`);
  const process = await startLlamaServer(serverPath, modelPath, port);

  const maxWaitMs = 30000; // 30 seconds
  const startTime = Date.now();
  const serverUrl = `http://localhost:${port}`;
  while (Date.now() - startTime < maxWaitMs) {
    if (await llamaServerHealthCheck(serverUrl)) {
      console.log('llama-server is ready');
      context.llamaServerProcess = process;
      context.llamaServerPort = port;
      return {
        name: 'llama.cpp',
        embedder: new LlamaServerTestEmbedder(serverUrl),
      };
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  process.kill();
  throw new Error('llama-server health check timeout');
}

/**
 * Simple embedder that uses Transformers.js tokenizer
 * Bypasses full Embedder initialization for testing
 */
class TransformersTestEmbedder implements TestEmbedder {
  constructor(private tokenizer: PreTrainedTokenizer) {}

  async countTokens(text: string): Promise<number> {
    return countTokensTransformers(this.tokenizer, text);
  }

  async getTokenIds(text: string): Promise<number[]> {
    return getTokenIdsTransformers(this.tokenizer, text);
  }
}

/**
 * Setup Transformers.js embedder for testing
 * Throws an error if setup fails
 */
async function setupTransformersEmbedder(): Promise<TestEmbedderSetupInfo> {
  const modelId = DEFAULT_SETTINGS.tfjsEmbedderModel;
  const tokenizer = await AutoTokenizer.from_pretrained(modelId);
  return {
    name: 'Transformers.js',
    embedder: new TransformersTestEmbedder(tokenizer),
  };
}

export async function setupTestEmbedders(): Promise<TestEmbedderSetupInfo[]> {
  return [await setupLlamaCppEmbedder(), await setupTransformersEmbedder()];
}

export function cleanupTestEmbedders(): void {
  if (context.llamaServerProcess) {
    console.log('Stopping llama-server...');
    context.llamaServerProcess.kill();
    context.llamaServerProcess = null;
    context.llamaServerPort = null;
  }
}
