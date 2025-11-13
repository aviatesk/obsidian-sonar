import { AutoTokenizer, pipeline } from '@huggingface/transformers';
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
    console.log(`[llama.cpp] Downloading model file: ${modelRepo}/${modelFile}...`);
    await downloadModel(modelRepo, modelFile);
  }

  const tfjsModelId = DEFAULT_SETTINGS.tfjsEmbedderModel;

  const downloadedFiles = new Set<string>();
  const createProgressCallback = () => {
    return (progressInfo: any) => {
      if (progressInfo.status === 'progress' && progressInfo.file) {
        if (!downloadedFiles.has(progressInfo.file)) {
          console.log(
            `[Transformers.js] Loading model file: ${progressInfo.file}...`
          );
          downloadedFiles.add(progressInfo.file);
        }
      }
    };
  };

  await AutoTokenizer.from_pretrained(tfjsModelId, {
    progress_callback: createProgressCallback(),
  });

  const featureExtractor = await pipeline('feature-extraction', tfjsModelId, {
    device: 'cpu',
    dtype: 'fp32',
    progress_callback: createProgressCallback(),
  });
  await featureExtractor.dispose();

  console.log('Set up embedding models');
}

export async function teardown() {}
