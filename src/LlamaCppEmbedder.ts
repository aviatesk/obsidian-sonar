import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { createServer } from 'net';
import type { ConfigManager } from './ConfigManager';
import type { Embedder } from './Embedder';
import { LlamaCppClient } from './LlamaCppClient';
import { WithLogging } from './WithLogging';

/**
 * Embedding generation using llama.cpp
 * Manages llama.cpp server process and uses its API for embeddings and tokenization
 */
export class LlamaCppEmbedder extends WithLogging implements Embedder {
  protected readonly componentName = 'LlamaCppEmbedder';

  private client: LlamaCppClient | null = null;
  private serverProcess: ChildProcess | null = null;
  private port: number | null = null;
  private exitHandlerBound: (() => void) | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor(
    private serverPath: string,
    private modelRepo: string,
    private modelFile: string,
    protected configManager: ConfigManager
  ) {
    super();
  }

  async initialize(): Promise<void> {
    this.log(`Initializing with model: ${this.modelRepo}/${this.modelFile}`);

    this.port = await this.findAvailablePort();
    this.log(`Selected port: ${this.port}`);

    await this.startServer();

    this.client = new LlamaCppClient(this.port);
    await this.waitForServer();

    this.log(`Initialized on port ${this.port}`);
  }

  private async findAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, () => {
        const address = server.address();
        if (address && typeof address !== 'string') {
          const { port } = address;
          server.close(() => resolve(port));
        } else {
          reject(new Error('Failed to get port'));
        }
      });
    });
  }

  private async startServer(): Promise<void> {
    if (!this.port) {
      throw new Error('Port not selected');
    }

    this.log(`Starting llama.cpp server...`);

    const args = [
      '--hf-repo',
      this.modelRepo,
      '--hf-file',
      this.modelFile,
      '--port',
      this.port.toString(),
      '--embedding',
      '--log-disable',
    ];

    this.serverProcess = spawn(this.serverPath, args, {
      stdio: 'pipe',
      detached: false, // Ensure child dies when parent dies
    });

    this.serverProcess.on('error', error => {
      this.error(`Failed to start server: ${error.message}`);
    });

    this.serverProcess.on('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        this.warn(`Server exited with code ${code}`);
      } else if (signal) {
        this.warn(`Server killed with signal ${signal}`);
      }
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
      }
    });

    this.serverProcess.stderr?.on('data', data => {
      const message = data.toString().trim();
      if (message) {
        this.log(`Server: ${message}`);
      }
    });

    this.exitHandlerBound = this.handleParentExit.bind(this);
    process.on('exit', this.exitHandlerBound);
    process.on('SIGINT', this.exitHandlerBound);
    process.on('SIGTERM', this.exitHandlerBound);
  }

  private handleParentExit(): void {
    if (this.serverProcess && !this.serverProcess.killed) {
      this.serverProcess.kill('SIGTERM');
    }
  }

  private async waitForServer(maxAttempts = 180, delayMs = 2000): Promise<void> {
    if (!this.client) {
      throw new Error('Client not initialized');
    }

    this.log(`Waiting for server to be ready...`);

    for (let i = 0; i < maxAttempts; i++) {
      const isHealthy = await this.client.healthCheck();
      if (isHealthy) {
        this.log(`Server ready`);
        // Start periodic health check after successful initialization
        this.startHealthCheck();
        return;
      }

      // Log progress hint for first-time model download
      if (i === 10) {
        this.log(
          `Still waiting... (Model download may take several minutes on first run)`
        );
      }

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    throw new Error(
      `Server failed to start after ${(maxAttempts * delayMs) / 1000}s`
    );
  }

  private startHealthCheck(): void {
    // Check server health every 60 seconds
    this.healthCheckInterval = setInterval(async () => {
      if (!this.client) {
        return;
      }
      const isHealthy = await this.client.healthCheck();
      if (!isHealthy) {
        this.warn(`llama.cpp server on port ${this.port} became unresponsive`);
        // Don't auto-restart for now, just log the issue
        // In the future, could implement auto-restart logic here
      }
    }, 60000); // 60 seconds
  }

  async getEmbeddings(
    texts: string[],
    _type?: 'query' | 'passage'
  ): Promise<number[][]> {
    if (!this.client) {
      throw new Error('Embedder not initialized. Call initialize() first.');
    }

    try {
      return await this.client.getEmbeddings(texts);
    } catch (error) {
      this.error(
        `Failed to generate embeddings: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  async countTokens(text: string): Promise<number> {
    if (!this.client) {
      throw new Error('Embedder not initialized. Call initialize() first.');
    }

    try {
      const tokens = await this.client.tokenize(text);
      return tokens.length;
    } catch (error) {
      this.error(
        `Failed to count tokens: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  async getTokenIds(text: string): Promise<number[]> {
    if (!this.client) {
      throw new Error('Embedder not initialized. Call initialize() first.');
    }

    try {
      return await this.client.tokenize(text);
    } catch (error) {
      this.error(
        `Failed to get token IDs: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  getDevice(): 'llamacpp' {
    return 'llamacpp';
  }

  cleanup(): void {
    this.log(`Cleaning up...`);

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.exitHandlerBound) {
      process.off('exit', this.exitHandlerBound);
      process.off('SIGINT', this.exitHandlerBound);
      process.off('SIGTERM', this.exitHandlerBound);
      this.exitHandlerBound = null;
    }

    if (this.serverProcess) {
      this.log(`Stopping server on port ${this.port}`);
      this.serverProcess.kill();
      this.serverProcess = null;
    }

    this.client = null;
    this.port = null;

    this.log(`Completed cleanup`);
  }
}
