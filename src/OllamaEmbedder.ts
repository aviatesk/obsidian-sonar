import type { ConfigManager } from './ConfigManager';
import type { Embedder } from './Embedder';
import type { TransformersWorker } from './TransformersWorker';
import { WithLogging } from './WithLogging';

/**
 * Embedding generation using Ollama API
 * Uses local Ollama server for embedding generation
 * Uses Transformers.js worker for tokenization
 */
export class OllamaEmbedder extends WithLogging implements Embedder {
  protected readonly componentName = 'OllamaEmbedder';

  constructor(
    private modelId: string,
    protected configManager: ConfigManager,
    private worker: TransformersWorker,
    private tokenizerModelId: string,
    private apiUrl: string = 'http://localhost:11434'
  ) {
    super();
    this.log(
      `Initialized with ${this.modelId} (tokenizer: ${tokenizerModelId})`
    );
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    this.log(`Generating embeddings for ${texts.length} text(s)...`);

    const embeddings: number[][] = [];

    for (const text of texts) {
      try {
        const response = await fetch(`${this.apiUrl}/api/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.modelId,
            prompt: text,
          }),
        });

        if (!response.ok) {
          throw new Error(
            `Ollama API error: ${response.status} ${response.statusText}`
          );
        }

        const data = await response.json();
        if (!data.embedding || !Array.isArray(data.embedding)) {
          throw new Error('Invalid response from Ollama API');
        }

        embeddings.push(data.embedding);
      } catch (error) {
        this.error(
          `Failed to generate embedding: ${error instanceof Error ? error.message : String(error)}`
        );
        throw error;
      }
    }

    return embeddings;
  }

  async countTokens(text: string): Promise<number> {
    return this.worker.call('countTokens', {
      text,
      modelId: this.tokenizerModelId,
    });
  }

  async getTokenIds(text: string): Promise<number[]> {
    return this.worker.call('getTokenIds', {
      text,
      modelId: this.tokenizerModelId,
    });
  }

  getDevice(): 'ollama' {
    return 'ollama';
  }

  cleanup(): void {
    // Worker is shared, so we don't clean it up here
  }
}
