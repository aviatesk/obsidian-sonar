import { Ollama } from 'ollama';

export interface OllamaConfig {
  ollamaUrl?: string;
  model?: string;
}

// Shared Ollama client for both CLI and Obsidian plugin
export class OllamaClient {
  private ollama: Ollama;
  public readonly model: string;
  public readonly ollamaUrl: string;

  constructor(config: OllamaConfig = {}) {
    this.ollamaUrl = config.ollamaUrl || 'http://localhost:11434';
    this.model = config.model || 'bge-m3:latest';

    // Initialize Ollama client with host URL
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
      // If model doesn't exist, try to pull it
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

  // Get embeddings using Ollama package
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

  // Get single embedding (for compatibility)
  async getEmbedding(text: string): Promise<number[]> {
    try {
      const response = await this.ollama.embed({
        model: this.model,
        input: text,
      });

      // For single input, embeddings array contains one embedding
      if (response.embeddings && response.embeddings.length > 0) {
        return response.embeddings[0];
      }

      throw new Error('No embedding in response');
    } catch (error: any) {
      throw new Error(`Failed to generate embedding: ${error.message}`);
    }
  }

  // Generate text completion (useful for RAG responses)
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

  // Chat completion with context (useful for conversational RAG)
  async chat(
    messages: Array<{
      role: 'user' | 'assistant' | 'system';
      content: string;
    }>
  ): Promise<string> {
    try {
      const response = await this.ollama.chat({
        model: this.model,
        messages,
        stream: false,
      });

      return response.message.content;
    } catch (error: any) {
      throw new Error(`Failed to chat: ${error.message}`);
    }
  }

  // List available models
  async listModels(): Promise<string[]> {
    try {
      const response = await this.ollama.list();
      return response.models.map(m => m.name);
    } catch (error: any) {
      throw new Error(`Failed to list models: ${error.message}`);
    }
  }

  // Pull a model if not available
  async pullModel(modelName?: string): Promise<void> {
    const model = modelName || this.model;
    try {
      // Pull model with progress tracking
      const stream = await this.ollama.pull({
        model,
        stream: true,
      });

      for await (const progress of stream) {
        if (progress.status) {
          console.log(`Pulling ${model}: ${progress.status}`);
        }
      }
    } catch (error: any) {
      throw new Error(`Failed to pull model ${model}: ${error.message}`);
    }
  }
}
