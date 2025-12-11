import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import * as path from 'path';
import type { ConfigManager } from './ConfigManager';
import { Embedder } from './Embedder';
import {
  isModelCached,
  downloadModel,
  getModelCachePath,
  findAvailablePort,
  llamaServerTokenize,
  llamaServerDetokenize,
  llamaServerGetEmbeddings,
  llamaServerHealthCheck,
  killServerProcess,
} from './llamaCppUtils';

/**
 * Embedding generation using llama.cpp
 * Manages llama.cpp server process and uses its API for embeddings and tokenization
 */
export class LlamaCppEmbedder extends Embedder {
  protected readonly componentName = 'LlamaCppEmbedder';

  private serverProcess: ChildProcess | null = null;
  private port: number | null = null;
  private exitHandlerBound: (() => void) | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor(
    private serverPath: string,
    private modelRepo: string,
    private modelFile: string,
    configManager: ConfigManager,
    statusCallback: (status: string) => void,
    private showNotice?: (msg: string, duration?: number) => void
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

    this.port = await findAvailablePort();
    this.log(`Selected port: ${this.port}`);

    await this.startServer();
  }

  private get serverUrl(): string {
    if (!this.port) {
      throw new Error('Server port not initialized');
    }
    return `http://localhost:${this.port}`;
  }

  private async getTokenStats(
    texts: string[]
  ): Promise<{ total: number; max: number } | null> {
    try {
      const tokenCounts = await Promise.all(
        texts.map(async text => {
          const tokens = await this.httpTokenize(text);
          return tokens.length;
        })
      );
      return {
        total: tokenCounts.reduce((sum, count) => sum + count, 0),
        max: Math.max(...tokenCounts),
      };
    } catch {
      return null;
    }
  }

  private async httpGetEmbeddings(texts: string[]): Promise<number[][]> {
    try {
      return await llamaServerGetEmbeddings(this.serverUrl, texts);
    } catch (error) {
      this.error('Embedding request error:', error);
      const tokenStats = await this.getTokenStats(texts);
      if (tokenStats) {
        this.error(
          `Request context: ${texts.length} texts, ${tokenStats.total} tokens total, ${tokenStats.max} tokens max`
        );
      } else {
        this.error(
          `Request context: ${texts.length} texts, ${texts.reduce((sum, t) => sum + t.length, 0)} chars total`
        );
      }
      throw new Error(
        `Batch embedding failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async httpTokenize(text: string): Promise<number[]> {
    try {
      return await llamaServerTokenize(this.serverUrl, text);
    } catch (error) {
      this.error('Tokenize request error:', error);
      this.error(`Text context: ${text.length} chars`);
      throw new Error(
        `Tokenization failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async httpHealthCheck(): Promise<boolean> {
    return llamaServerHealthCheck(this.serverUrl);
  }

  protected async checkReady(): Promise<boolean> {
    if (!this.port) {
      return false;
    }
    return await this.httpHealthCheck();
  }

  protected async onInitializationComplete(): Promise<void> {
    this.startHealthCheck();
    this.log(`Initialized on port ${this.port}`);
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
          this.showNotice?.(
            `llama-server not found at path: ${this.serverPath}\n\n` +
              `Resolved path: ${resolvedServerPath}\n\n` +
              `Please install llama.cpp first.\n` +
              `See README for installation instructions.`,
            0
          );
          reject(
            new Error(
              `llama-server executable not found at: ${resolvedServerPath}`
            )
          );
        } else {
          this.showNotice?.(
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
      if (!this.port) {
        return;
      }
      const isHealthy = await this.httpHealthCheck();
      if (!isHealthy) {
        this.warn(`llama.cpp server on port ${this.port} became unresponsive`);
        // Don't auto-restart for now, just log the issue
        // In the future, could implement auto-restart logic here
      }
    }, 60000); // 60 seconds
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    if (!this.port) {
      throw new Error('Embedder not initialized. Call initialize() first.');
    }
    return await this.httpGetEmbeddings(texts);
  }

  async countTokens(text: string): Promise<number> {
    if (!this.port) {
      throw new Error('Embedder not initialized. Call initialize() first.');
    }
    const tokens = await this.httpTokenize(text);
    return tokens.length;
  }

  async getTokenIds(text: string): Promise<number[]> {
    if (!this.port) {
      throw new Error('Embedder not initialized. Call initialize() first.');
    }
    return await this.httpTokenize(text);
  }

  async decodeTokenIds(tokenIds: number[]): Promise<string[]> {
    if (!this.port) {
      throw new Error('Embedder not initialized. Call initialize() first.');
    }
    // Decode each token ID individually to get individual token strings
    const decoded = await Promise.all(
      tokenIds.map(id => llamaServerDetokenize(this.serverUrl, [id]))
    );
    return decoded;
  }

  getDevice(): 'llamacpp' {
    return 'llamacpp';
  }

  async cleanup(): Promise<void> {
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
      await killServerProcess(this.serverProcess, this.configManager.logger);
      this.serverProcess = null;
    }

    this.port = null;

    this.log(`Completed cleanup`);
  }
}
