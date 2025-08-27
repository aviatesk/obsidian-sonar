import { OllamaClient } from './core/ollama-client';

export class ObsidianEmbedder {
  private client: OllamaClient;

  private constructor(client: OllamaClient) {
    this.client = client;
  }

  static async initialize(ollamaUrl: string, modelName: string) {
    const client = new OllamaClient({
      ollamaUrl,
      model: modelName,
    });
    const embedder = new ObsidianEmbedder(client);
    try {
      await client.checkModel();
      console.log(`Ollama embedder initialized with model: ${modelName}`);
      return embedder;
    } catch (error) {
      console.error('Failed to initialize Ollama embedder:', error);
      throw error;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    try {
      return await this.client.getEmbeddings(texts);
    } catch (error) {
      console.error('Failed to generate embeddings:', error);
      throw error;
    }
  }

  dispose(): void {
    console.log('Ollama embedder disposed');
  }
}
