import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { createServer } from 'net';
import { Notice } from 'obsidian';
import * as path from 'path';
import type { ConfigManager } from './ConfigManager';
import { Embedder } from './Embedder';
import { LlamaCppClient } from './LlamaCppClient';
import {
  isModelCached,
  downloadModel,
  getModelCachePath,
} from './llamaCppUtils';

/**
 * Embedding generation using llama.cpp
 * Manages llama.cpp server process and uses its API for embeddings and tokenization
 */
export class LlamaCppEmbedder extends Embedder {
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
    configManager: ConfigManager,
    statusCallback: (status: string) => void
  ) {
    super(configManager, statusCallback);
  }

  protected async startInitialization(): Promise<void> {
    this.log(`Initializing with model: ${this.modelRepo}/${this.modelFile}`);

    // Check if model is cached, download if not
    if (!isModelCached(this.modelRepo, this.modelFile)) {
      this.log(`Model not found in cache, downloading...`);
      await downloadModel(this.modelRepo, this.modelFile, progress => {
        if (progress.status === 'progress') {
          const percent = progress.percent.toFixed(0);
          this.updateStatus(`Loading: ${percent}%`);
        }
      });
      this.log(`Model downloaded`);
    } else {
      this.log(`Using cached model`);
    }

    this.port = await this.findAvailablePort();
    this.log(`Selected port: ${this.port}`);

    await this.startServer();
    this.client = new LlamaCppClient(this.port);
  }

  protected async checkReady(): Promise<boolean> {
    if (!this.client) {
      return false;
    }
    return await this.client.healthCheck();
  }

  protected async onInitializationComplete(): Promise<void> {
    this.startHealthCheck();
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

    const resolvedServerPath = await this.resolveServerPath(this.serverPath);

    const modelPath = getModelCachePath(this.modelRepo, this.modelFile);

    const maxChunkSize = this.configManager.get('maxChunkSize');
    const chunkOverlap = this.configManager.get('chunkOverlap');
    const batchSize = this.configManager.get('indexingBatchSize');
    const ubatchSize = batchSize * (maxChunkSize + chunkOverlap);

    this.log(
      `Starting llama.cpp server (port: ${this.port}, ubatch-size: ${ubatchSize})...`
    );

    const args = [
      '--model',
      modelPath,
      '--port',
      this.port.toString(),
      '--embedding',
      '--ubatch-size',
      ubatchSize.toString(),
      '-lv',
      '0',
    ];

    return new Promise((resolve, reject) => {
      this.serverProcess = spawn(resolvedServerPath, args, {
        stdio: 'pipe',
        detached: false, // Ensure child dies when parent dies
      });

      let errorHandled = false;
      this.serverProcess.on('error', error => {
        errorHandled = true;
        this.error(`Failed to start server: ${error.message}`);
        if ('code' in error && error.code === 'ENOENT') {
          const noticeMsg =
            `llama-server not found at path: ${this.serverPath}\n\n` +
            `Resolved path: ${resolvedServerPath}\n\n` +
            `Please install llama.cpp first.\n` +
            `See README for installation instructions.`;
          new Notice(noticeMsg, 0);
          reject(
            new Error(
              `llama-server executable not found at: ${resolvedServerPath}`
            )
          );
        } else {
          new Notice(
            `Failed to start llama.cpp server: ${error.message}\n` +
              `Check console for details.`
          );
          reject(error);
        }
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

      this.serverProcess.stdout?.on('data', data => {
        throw new Error(`Unexpected data on stdout: ${data}`);
      });

      // XXX llama-server seems to output ALL logs to stderr (not just errors)
      // This is abnormal behavior. stderr typically should only be used for
      // error-related messages, and stdout should be used for regular logs.
      // However, this issue seems to still be unresolved, which fundamentally
      // makes it difficult to utilize llama-server's logs:
      // https://github.com/ggml-org/llama.cpp/discussions/6786)
      // Therefore here we filter stderr to show error messages with `this.error`,
      // relatively important message with `this.log`, and use `this.verbose` otherwise.
      this.serverProcess.stderr?.on('data', data => {
        const message = data.toString().trim();
        if (!message) return;
        const lower = message.toLowerCase();
        // Log errors and exceptions
        if (
          lower.includes('exception') ||
          lower.includes('error') ||
          lower.includes('fail')
        ) {
          this.error(`Server: ${message}`);
          return;
        }
        // Log important server events
        if (
          lower.includes('listening') ||
          lower.includes('model loaded') ||
          message.startsWith('main:')
        ) {
          this.log(`Server: ${message}`);
          return;
        }
        this.verbose(`Server: ${message}`);
      });

      this.exitHandlerBound = this.handleParentExit.bind(this);
      process.on('exit', this.exitHandlerBound);
      process.on('SIGINT', this.exitHandlerBound);
      process.on('SIGTERM', this.exitHandlerBound);

      // Resolve immediately after spawn (not waiting for server to be ready)
      // Server readiness is checked by health checks in checkReady()
      // Small delay to ensure error event fires before we resolve if there's an immediate error
      setTimeout(() => {
        if (!errorHandled) {
          resolve();
        }
      }, 100);
    });
  }

  private async resolveServerPath(serverPath: string): Promise<string> {
    // If already absolute path, return as-is
    if (path.isAbsolute(serverPath)) {
      return serverPath;
    }

    // Use login+interactive shell to run 'command -v' to resolve command name to full path
    // This ensures the command runs with the user's full shell environment and PATH
    // The -l flag makes it a login shell, -i makes it interactive (sources ~/.zshrc, etc.)
    // We use 'command -v' instead of 'which' as it's more reliable and POSIX standard
    return new Promise(resolve => {
      const shell = process.env.SHELL || '/bin/zsh';
      const which = spawn(shell, [
        '-l',
        '-i',
        '-c',
        `command -v ${serverPath}`,
      ]);
      let output = '';
      let errorOutput = '';

      which.stdout?.on('data', data => {
        output += data.toString();
      });

      which.stderr?.on('data', data => {
        errorOutput += data.toString();
      });

      which.on('close', code => {
        if (code === 0 && output.trim()) {
          this.log(
            `Resolved '${serverPath}' to '${output.trim()}' via login shell`
          );
          resolve(output.trim());
        } else {
          // command -v failed, log the error and return original path
          if (errorOutput) {
            this.log(`Failed to resolve '${serverPath}': ${errorOutput}`);
          }
          this.log(
            `Could not resolve '${serverPath}' via shell, using as-is (exit code: ${code})`
          );
          resolve(serverPath);
        }
      });

      which.on('error', err => {
        // spawn itself failed
        this.warn(`Failed to spawn shell for path resolution: ${err.message}`);
        resolve(serverPath);
      });
    });
  }

  private handleParentExit(): void {
    if (this.serverProcess && !this.serverProcess.killed) {
      this.serverProcess.kill('SIGTERM');
    }
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
