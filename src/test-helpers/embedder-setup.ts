import { AutoTokenizer, pipeline } from '@huggingface/transformers';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import type { PreTrainedTokenizer } from '@huggingface/transformers/types/base/processing_utils';
import type { Embedder } from '../Embedder';
import { LlamaCppEmbedder } from '../LlamaCppEmbedder';
import {
  countTokensTransformers,
  getTokenIdsTransformers,
} from '../transformers-tokenizer-utils';
import { DEFAULT_SETTINGS } from '../config';
import { createMockConfigManager } from './mock-config-manager';

export type TestEmbedder = Pick<
  Embedder,
  'countTokens' | 'getTokenIds' | 'decodeTokenIds' | 'getEmbeddings'
>;

export interface TestEmbedderSetupInfo {
  name: string;
  embedder: TestEmbedder;
}

interface TestContext {
  llamaCppEmbedder: LlamaCppEmbedder | null;
}

const context: TestContext = {
  llamaCppEmbedder: null,
};

async function setupLlamaCppEmbedder(): Promise<TestEmbedderSetupInfo> {
  const serverPath = DEFAULT_SETTINGS.llamacppServerPath;
  const modelRepo = DEFAULT_SETTINGS.llamaEmbedderModelRepo;
  const modelFile = DEFAULT_SETTINGS.llamaEmbedderModelFile;
  const configManager = createMockConfigManager();

  const embedder = new LlamaCppEmbedder(
    serverPath,
    modelRepo,
    modelFile,
    configManager,
    () => {} // statusCallback - not needed for tests
  );

  await embedder.initialize();
  console.log('llama-server is ready');
  context.llamaCppEmbedder = embedder;

  return {
    name: 'llama.cpp',
    embedder,
  };
}

/**
 * Simple embedder that uses Transformers.js tokenizer and pipeline
 * Bypasses full Embedder initialization for testing
 */
class TransformersTestEmbedder implements TestEmbedder {
  constructor(
    private tokenizer: PreTrainedTokenizer,
    private featureExtractor: FeatureExtractionPipeline
  ) {}

  async countTokens(text: string): Promise<number> {
    return countTokensTransformers(this.tokenizer, text);
  }

  async getTokenIds(text: string): Promise<number[]> {
    return getTokenIdsTransformers(this.tokenizer, text);
  }

  async decodeTokenIds(tokenIds: number[]): Promise<string[]> {
    return tokenIds.map(id => this.tokenizer.decode([id]));
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    const out = await this.featureExtractor(texts, {
      pooling: 'mean',
      normalize: true,
    });
    return out.tolist();
  }
}

async function setupTransformersEmbedder(): Promise<TestEmbedderSetupInfo> {
  const modelId = DEFAULT_SETTINGS.tfjsEmbedderModel;
  const tokenizer = await AutoTokenizer.from_pretrained(modelId);
  // Use 'cpu' device in Node.js test environment (wasm is not supported)
  const featureExtractor = await pipeline('feature-extraction', modelId, {
    device: 'cpu',
    dtype: 'fp32',
  });
  return {
    name: 'Transformers.js',
    embedder: new TransformersTestEmbedder(tokenizer, featureExtractor),
  };
}

export async function setupTestEmbedders(): Promise<TestEmbedderSetupInfo[]> {
  console.log(`Starting llama-server on port...`);
  return [await setupLlamaCppEmbedder(), await setupTransformersEmbedder()];
}

export async function cleanupTestEmbedders(): Promise<void> {
  if (context.llamaCppEmbedder) {
    console.log('Stopping llama-server...');
    await context.llamaCppEmbedder.cleanup();
    context.llamaCppEmbedder = null;
  }
}
