import { isModelCached, downloadModel } from '../llamaCppUtils';
import { DEFAULT_SETTINGS } from '../config';

/**
 * Global setup for tests
 * Pre-downloads models to avoid concurrent download conflicts
 */
export async function setup() {
  console.log('Setting up embedding models...');

  const modelRepo = DEFAULT_SETTINGS.llamaEmbedderModelRepo;
  const modelFile = DEFAULT_SETTINGS.llamaEmbedderModelFile;
  if (!isModelCached(modelRepo, modelFile)) {
    console.log(
      `[llama.cpp] Downloading model file: ${modelRepo}/${modelFile}...`
    );
    await downloadModel(modelRepo, modelFile);
  }

  console.log('Set up embedding models');
}

export async function teardown() {}
