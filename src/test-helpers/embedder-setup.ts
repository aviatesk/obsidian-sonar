import type { Embedder } from '../Embedder';
import { LlamaCppEmbedder } from '../LlamaCppEmbedder';
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
    () => {}, // statusCallback - not needed for tests
    () => {} // onStatusChange - not needed for tests
  );

  await embedder.initialize();
  console.log('llama-server is ready');
  context.llamaCppEmbedder = embedder;

  return {
    name: 'llama.cpp',
    embedder,
  };
}

export async function setupTestEmbedders(): Promise<TestEmbedderSetupInfo[]> {
  console.log(`Starting llama-server on port...`);
  return [await setupLlamaCppEmbedder()];
}

export async function cleanupTestEmbedders(): Promise<void> {
  if (context.llamaCppEmbedder) {
    console.log('Stopping llama-server...');
    await context.llamaCppEmbedder.cleanup();
    context.llamaCppEmbedder = null;
  }
}
