export class LlamaCppClient {
  public readonly serverUrl: string;

  constructor(port: number) {
    this.serverUrl = `http://localhost:${port}`;
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    try {
      const response = await fetch(`${this.serverUrl}/v1/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: texts,
        }),
      });

      if (!response.ok) {
        throw new Error(
          `llama.cpp API error: ${response.status} ${response.statusText}`
        );
      }

      const data = await response.json();
      if (!data.data || !Array.isArray(data.data)) {
        throw new Error('Invalid response from llama.cpp API');
      }

      return data.data.map((item: { embedding: number[] }) => item.embedding);
    } catch (error) {
      throw new Error(
        `Batch embedding failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async tokenize(text: string): Promise<number[]> {
    try {
      const response = await fetch(`${this.serverUrl}/tokenize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: text,
        }),
      });

      if (!response.ok) {
        throw new Error(
          `llama.cpp tokenize API error: ${response.status} ${response.statusText}`
        );
      }

      const data = await response.json();
      if (!data.tokens || !Array.isArray(data.tokens)) {
        throw new Error('Invalid tokenize response from llama.cpp API');
      }

      return data.tokens;
    } catch (error) {
      throw new Error(
        `Tokenization failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.serverUrl}/health`, {
        method: 'GET',
      });
      if (!response.ok) {
        return false;
      }
      const data = await response.json();
      // Server is ready only when status is "ok"
      // Other states: "loading model", "error"
      return data.status === 'ok';
    } catch {
      return false;
    }
  }
}
