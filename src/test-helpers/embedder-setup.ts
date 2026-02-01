import { LlamaCppEmbedder } from '../LlamaCppEmbedder';
import { DEFAULT_SETTINGS } from '../config';
import { createMockConfigManager } from './mock-config-manager';

let embedder: LlamaCppEmbedder | null = null;

export async function setupTestEmbedder(): Promise<LlamaCppEmbedder> {
  console.log(`Starting llama-server on port...`);

  const serverPath = DEFAULT_SETTINGS.llamacppServerPath;
  const modelRepo = DEFAULT_SETTINGS.llamaEmbedderModelRepo;
  const modelFile = DEFAULT_SETTINGS.llamaEmbedderModelFile;
  const configManager = createMockConfigManager();

  embedder = new LlamaCppEmbedder(
    serverPath,
    modelRepo,
    modelFile,
    configManager,
    () => {}
  );

  await embedder.initialize();
  console.log('llama-server is ready');

  return embedder;
}

export async function cleanupTestEmbedder(): Promise<void> {
  if (embedder) {
    console.log('Stopping llama-server...');
    await embedder.cleanup();
    embedder = null;
  }
}
