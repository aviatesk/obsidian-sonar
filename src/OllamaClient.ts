import { Ollama } from 'ollama';

export interface OllamaConfig {
  ollamaUrl?: string;
  model?: string;
}

export class OllamaClient {
  private ollama: Ollama;
  public readonly model: string;
  public readonly ollamaUrl: string;

  constructor(config: OllamaConfig = {}) {
    this.ollamaUrl = config.ollamaUrl || 'http://localhost:11434';
    this.model = config.model || 'bge-m3:latest';
    this.ollama = new Ollama({
      host: this.ollamaUrl,
    });
  }

  // Check if model is available
  async checkModel(): Promise<boolean> {
    try {
      await this.ollama.show({
        model: this.model,
      });
      return true;
    } catch (error: any) {
      if (error.message?.includes('not found')) {
        throw new Error(
          `Model ${this.model} not found. Run: ollama pull ${this.model}`
        );
      }
      throw new Error(
        `Cannot connect to Ollama at ${this.ollamaUrl}: ${error.message}`
      );
    }
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    try {
      // Ollama's embed API accepts single or multiple inputs
      const response = await this.ollama.embed({
        model: this.model,
        input: texts,
      });
      // The response always contains embeddings array for batch input
      if (response.embeddings) {
        return response.embeddings;
      }
      throw new Error('No embeddings in response');
    } catch (error: any) {
      throw new Error(`Batch embedding failed: ${error.message}`);
    }
  }

  async generate(prompt: string, system?: string): Promise<string> {
    try {
      const response = await this.ollama.generate({
        model: this.model,
        prompt,
        system,
        stream: false,
      });

      return response.response;
    } catch (error: any) {
      throw new Error(`Failed to generate response: ${error.message}`);
    }
  }
}
