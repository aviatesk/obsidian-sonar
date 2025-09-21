import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import ora from 'ora';
import { Ollama } from 'ollama';

interface OllamaConfig {
  ollamaUrl?: string;
  embeddingModel?: string;
  parallelServers?: number;
  parallelPort?: number;
}

interface OllamaServer {
  port: number;
  url: string;
  process: ChildProcess | null;
  available: boolean;
  client?: Ollama;
}

export class OllamaUtils {
  public readonly ollamaUrl: string;
  public readonly embeddingModel: string;
  public readonly parallelServers: number;
  public readonly parallelPort: number;
  public servers: OllamaServer[];
  public readonly isParallel: boolean;
  private defaultClient: Ollama;

  constructor(config: OllamaConfig = {}) {
    this.ollamaUrl = config.ollamaUrl || 'http://localhost:11434';
    this.embeddingModel = config.embeddingModel || 'bge-m3:latest';
    this.parallelServers = config.parallelServers || 1;
    this.parallelPort = config.parallelPort || 11435;
    this.servers = [];
    this.isParallel = this.parallelServers > 1;

    // Default Ollama client
    this.defaultClient = new Ollama({
      host: this.ollamaUrl,
    });
  }

  // 初期化（並列の場合はサーバー起動）
  async initialize(): Promise<void> {
    if (this.isParallel) {
      await this.startParallelServers();
    } else {
      // 単一サーバーの場合は接続確認
      await this.checkSingleServer();
    }
  }

  // 単一サーバーの接続確認
  async checkSingleServer(): Promise<void> {
    try {
      await this.defaultClient.show({
        model: this.embeddingModel,
      });
    } catch (error: any) {
      if (error.message?.includes('not found')) {
        throw new Error(
          `Model ${this.embeddingModel} not found. Run: ollama pull ${this.embeddingModel}`
        );
      }
      throw new Error(
        `Cannot connect to Ollama at ${this.ollamaUrl}: ${error.message}`
      );
    }
  }

  // 複数のOllamaサーバーを起動
  async startParallelServers(): Promise<void> {
    const spinner = ora(
      `Starting ${this.parallelServers} Ollama servers...`
    ).start();

    for (let i = 0; i < this.parallelServers; i++) {
      const port = this.parallelPort + i;
      const server: OllamaServer = {
        port: port,
        url: `http://localhost:${port}`,
        process: null,
        available: false,
      };

      try {
        // OLLAMA_HOST環境変数でポートを指定してサーバーを起動
        server.process = spawn('ollama', ['serve'], {
          env: {
            ...process.env,
            OLLAMA_HOST: `0.0.0.0:${port}`,
            OLLAMA_MODELS:
              process.env.OLLAMA_MODELS ||
              path.join(process.env.HOME || '', '.ollama/models'),
          },
          detached: false,
          stdio: 'ignore',
        });

        // サーバーが起動するまで待機
        await this.waitForServer(server.url);

        // Create Ollama client for this server
        server.client = new Ollama({
          host: server.url,
        });

        server.available = true;
        this.servers.push(server);

        spinner.text = `Started Ollama server ${i + 1}/${this.parallelServers} on port ${port}`;
      } catch (error: any) {
        console.error(`Failed to start server on port ${port}:`, error.message);
      }
    }

    if (this.servers.length === 0) {
      spinner.fail('Failed to start any Ollama servers');
      throw new Error('No Ollama servers available');
    }

    spinner.succeed(`Started ${this.servers.length} Ollama servers`);
    await this.ensureModelOnAllServers();
  }

  async waitForServer(url: string, maxRetries: number = 30): Promise<boolean> {
    const tempClient = new Ollama({ host: url });

    for (let i = 0; i < maxRetries; i++) {
      try {
        await tempClient.list();
        return true;
      } catch {
        // Server not started yet
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`Server at ${url} failed to start`);
  }

  async ensureModelOnAllServers(): Promise<void> {
    const spinner = ora(
      `Checking model ${this.embeddingModel} on all servers...`
    ).start();

    for (const server of this.servers) {
      if (!server.client) continue;

      try {
        await server.client.show({
          model: this.embeddingModel,
        });
      } catch (error: any) {
        if (error.message?.includes('not found')) {
          // モデルがない場合はpull
          spinner.text = `Pulling ${this.embeddingModel} on server ${server.port}...`;
          await this.pullModel(server.client);
        }
      }
    }

    spinner.succeed('Model ready on all servers');
  }

  // モデルをpull
  async pullModel(client: Ollama): Promise<void> {
    try {
      const stream = await client.pull({
        model: this.embeddingModel,
        stream: true,
      });

      for await (const _ of stream) {
        // Progress is handled by the stream
        void _; // Explicitly mark as intentionally unused
      }
    } catch (error: any) {
      throw new Error(`Failed to pull model: ${error.message}`);
    }
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    if (this.isParallel) {
      // For parallel mode, this shouldn't be called directly
      throw new Error(
        'Use getEmbeddingsSingle with specific server for parallel mode'
      );
    } else {
      return await this.getEmbeddingsSingle(texts, this.ollamaUrl);
    }
  }

  async getEmbeddingsSingle(
    texts: string[],
    serverUrl: string
  ): Promise<number[][]> {
    // Find the client for this server or use default
    let client = this.defaultClient;

    if (serverUrl !== this.ollamaUrl) {
      const server = this.servers.find(s => s.url === serverUrl);
      if (server?.client) {
        client = server.client;
      } else {
        client = new Ollama({ host: serverUrl });
      }
    }

    try {
      const response = await client.embed({
        model: this.embeddingModel,
        input: texts,
      });

      if (response.embeddings) {
        return response.embeddings;
      }

      throw new Error('No embeddings in response');
    } catch (error: any) {
      throw new Error(`Batch embedding failed: ${error.message}`);
    }
  }

  // 並列処理でファイルごとの埋め込みを取得
  async getEmbeddingsParallel(_texts: string[]): Promise<number[][]> {
    // 並列処理は呼び出し側でファイル単位で管理するため、
    // ここでは単一サーバーと同じ処理
    throw new Error('Use processFilesParallel for parallel processing');
  }

  async processFilesParallel<T>(
    files: string[],
    processFileFunc: (file: string, server: OllamaServer) => Promise<T>
  ): Promise<T[]> {
    const fileQueue = [...files];
    const activeProcessing = new Map<
      string,
      Promise<{ server: OllamaServer; result: T }>
    >();
    const availableServers = this.servers.filter(s => s.available);
    const results: T[] = [];

    // 初期処理を開始（各サーバーに1ファイルずつ）
    for (const server of availableServers) {
      if (fileQueue.length > 0) {
        const file = fileQueue.shift()!;
        activeProcessing.set(
          server.url,
          processFileFunc(file, server).then(result => ({
            server,
            result,
          }))
        );
      }
    }

    // 処理が完了したサーバーに新しいファイルを割り当て
    while (activeProcessing.size > 0) {
      const completed = await Promise.race(activeProcessing.values());
      results.push(completed.result);

      // 完了したサーバーのPromiseを削除
      activeProcessing.delete(completed.server.url);

      // 次のファイルがあれば同じサーバーに割り当て
      if (fileQueue.length > 0) {
        const nextFile = fileQueue.shift()!;
        activeProcessing.set(
          completed.server.url,
          processFileFunc(nextFile, completed.server).then(result => ({
            server: completed.server,
            result,
          }))
        );
      }
    }

    return results;
  }

  // クリーンアップ
  async cleanup(): Promise<void> {
    if (this.isParallel) {
      await this.stopServers();
    }
  }

  // すべてのサーバーを停止
  async stopServers(): Promise<void> {
    const spinner = ora('Stopping Ollama servers...').start();

    for (const server of this.servers) {
      if (server.process) {
        try {
          server.process.kill('SIGTERM');
          await new Promise(resolve => setTimeout(resolve, 1000));
          if (!server.process.killed) {
            server.process.kill('SIGKILL');
          }
        } catch (error: any) {
          console.error(
            `Failed to stop server on port ${server.port}:`,
            error.message
          );
        }
      }
    }

    this.servers = [];
    spinner.succeed('All Ollama servers stopped');
  }
}
