import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ChildProcess, spawn } from 'child_process';
import { createServer } from 'net';
import type { Logger } from './WithLogging';
import { progressiveWait } from './utils';

/**
 * Get the cache directory path for llama.cpp models
 * Respects XDG_CACHE_HOME on Linux
 */
export function getModelCacheDir(): string {
  if (process.platform === 'darwin') {
    // macOS: hardcoded location
    return path.join(os.homedir(), 'Library/Caches/llama.cpp');
  } else if (process.platform === 'linux') {
    // Linux: respect XDG_CACHE_HOME
    const xdgCache = process.env.XDG_CACHE_HOME;
    if (xdgCache) {
      return path.join(xdgCache, 'llama.cpp');
    }
    return path.join(os.homedir(), '.cache/llama.cpp');
  } else if (process.platform === 'win32') {
    // Windows: use LOCALAPPDATA
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local');
    return path.join(localAppData, 'llama.cpp');
  }
  // Fallback
  return path.join(os.homedir(), '.cache/llama.cpp');
}

/**
 * Get the full path to a cached model file
 *
 * @param repo - HuggingFace repository (e.g., "ggml-org/bge-m3-Q8_0-GGUF")
 * @param file - Model filename (e.g., "bge-m3-q8_0.gguf")
 * @returns Full path to the cached model file
 */
export function getModelCachePath(repo: string, file: string): string {
  const cacheDir = getModelCacheDir();

  // Convert repo format: "ggml-org/bge-m3-Q8_0-GGUF" -> "ggml-org_bge-m3-Q8_0-GGUF"
  const repoName = repo.replace('/', '_');
  const fileName = `${repoName}_${file}`;

  return path.join(cacheDir, fileName);
}

/**
 * Check if a model is already cached locally
 *
 * @param repo - HuggingFace repository
 * @param file - Model filename
 * @returns true if model is cached, false otherwise
 */
export function isModelCached(repo: string, file: string): boolean {
  const modelPath = getModelCachePath(repo, file);
  return fs.existsSync(modelPath);
}

/**
 * Progress information for model download
 */
export interface DownloadProgress {
  percent: number;
  file: string;
  status: 'progress' | 'done';
}

/**
 * Download a model from HuggingFace to the llama.cpp cache
 *
 * @param repo - HuggingFace repository (e.g., "ggml-org/bge-m3-Q8_0-GGUF")
 * @param file - Model filename (e.g., "bge-m3-q8_0.gguf")
 * @param onProgress - Optional callback for progress updates
 * @returns Promise that resolves to the cached model path
 */
export async function downloadModel(
  repo: string,
  file: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<string> {
  const modelPath = getModelCachePath(repo, file);
  const cacheDir = getModelCacheDir();

  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  const url = `https://huggingface.co/${repo}/resolve/main/${file}`;

  return new Promise((resolve, reject) => {
    const curl = spawn('curl', [
      '-L', // Follow redirects
      '--progress-bar',
      '-o',
      modelPath,
      url,
    ]);

    let progressBuffer = '';

    curl.stderr?.on('data', data => {
      const chunk = data.toString();
      progressBuffer += chunk;

      if (onProgress) {
        // Parse progress bar: "###...### 100.0%"
        // Each '#' represents ~1.4% progress (72 total)
        // NOTE: If curl changes its output format, parsing will fail gracefully
        // (no progress updates), but download will continue and succeed
        const hashMatches = progressBuffer.match(/#/g);
        if (hashMatches) {
          const percent = Math.min(
            Math.floor((hashMatches.length / 72) * 100),
            100
          );

          // Check for percentage in the output
          const percentMatch = chunk.match(/(\d+\.\d+)%/);
          const displayPercent = percentMatch
            ? parseFloat(percentMatch[1])
            : percent;

          onProgress({
            percent: displayPercent,
            file,
            status: 'progress',
          });
        }
      }
    });

    curl.on('error', error => {
      reject(new Error(`Failed to start download: ${error.message}`));
    });

    curl.on('exit', (code, signal) => {
      if (code === 0) {
        // Download success is determined by file existence and size,
        // regardless of whether progress parsing succeeded
        if (fs.existsSync(modelPath)) {
          const stats = fs.statSync(modelPath);
          if (stats.size > 0) {
            resolve(modelPath);
          } else {
            reject(new Error('Downloaded file is empty'));
          }
        } else {
          reject(new Error('Download completed but file not found'));
        }
      } else if (signal) {
        reject(new Error(`Download killed with signal ${signal}`));
      } else {
        reject(new Error(`Download failed with exit code ${code}`));
      }
    });
  });
}

/**
 * Find an available port for llama-server
 *
 * @returns Promise that resolves to an available port number
 */
export async function findAvailablePort(): Promise<number> {
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

/**
 * Tokenize text using llama-server API
 *
 * @param serverUrl - Base URL of llama-server (e.g., "http://localhost:8080")
 * @param text - Text to tokenize
 * @returns Promise that resolves to array of token IDs
 */
export async function llamaServerTokenize(
  serverUrl: string,
  text: string
): Promise<number[]> {
  const response = await fetch(`${serverUrl}/tokenize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text }),
  });

  if (!response.ok) {
    throw new Error(
      `Tokenize request failed: ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as { tokens: number[] };
  if (!data.tokens || !Array.isArray(data.tokens)) {
    throw new Error('Invalid tokenize response from llama.cpp API');
  }

  return data.tokens;
}

/**
 * Detokenize token IDs to text using llama-server API
 *
 * @param serverUrl - Base URL of llama-server (e.g., "http://localhost:8080")
 * @param tokenIds - Array of token IDs to detokenize
 * @returns Promise that resolves to the decoded text
 */
export async function llamaServerDetokenize(
  serverUrl: string,
  tokenIds: number[]
): Promise<string> {
  const response = await fetch(`${serverUrl}/detokenize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokens: tokenIds }),
  });

  if (!response.ok) {
    throw new Error(
      `Detokenize request failed: ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as { content: string };
  if (typeof data.content !== 'string') {
    throw new Error('Invalid detokenize response from llama.cpp API');
  }

  return data.content;
}

/**
 * Get embeddings using llama-server API
 *
 * @param serverUrl - Base URL of llama-server (e.g., "http://localhost:8080")
 * @param texts - Array of texts to embed
 * @returns Promise that resolves to array of embedding vectors
 */
export async function llamaServerGetEmbeddings(
  serverUrl: string,
  texts: string[]
): Promise<number[][]> {
  const response = await fetch(`${serverUrl}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: texts }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Embedding request failed: ${response.status} ${response.statusText}. Body: ${errorText}`
    );
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };

  if (!data.data || !Array.isArray(data.data)) {
    throw new Error('Invalid embedding response from llama.cpp API');
  }

  return data.data.map(item => item.embedding);
}

/**
 * Check llama-server health status
 *
 * @param serverUrl - Base URL of llama-server (e.g., "http://localhost:8080")
 * @returns Promise that resolves to true if server is ready, false otherwise
 */
export async function llamaServerHealthCheck(
  serverUrl: string
): Promise<boolean> {
  try {
    const response = await fetch(`${serverUrl}/health`, {
      method: 'GET',
    });

    if (!response.ok) {
      return false;
    }

    const data = (await response.json()) as { status: string };
    // Server is ready only when status is "ok"
    // Other states: "loading model", "error"
    return data.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * Resolve a server path to an absolute path
 * If the path is relative (e.g., "llama-server"), resolves it via login shell
 *
 * @param serverPath - Path to resolve (absolute or command name)
 * @param logger - Optional logger for debug messages
 * @returns Promise that resolves to the full path
 */
export async function resolveServerPath(
  serverPath: string,
  logger?: Logger
): Promise<string> {
  if (path.isAbsolute(serverPath)) {
    return serverPath;
  }

  return new Promise(resolve => {
    const shell = process.env.SHELL || '/bin/zsh';
    const which = spawn(shell, ['-l', '-i', '-c', `command -v ${serverPath}`]);
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
        const resolved = output.trim();
        logger?.log(
          `Resolved '${serverPath}' to '${resolved}' via login shell`
        );
        resolve(resolved);
      } else {
        if (errorOutput) {
          logger?.log(`Failed to resolve '${serverPath}': ${errorOutput}`);
        }
        logger?.log(
          `Could not resolve '${serverPath}' via shell, using as-is (exit code: ${code})`
        );
        resolve(serverPath);
      }
    });

    which.on('error', err => {
      logger?.warn(`Failed to spawn shell for path resolution: ${err.message}`);
      resolve(serverPath);
    });
  });
}

export interface StartLlamaServerOptions {
  serverPath: string;
  args: string[];
  logger?: Logger;
  showNotice?: (msg: string, duration?: number) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  serverType?: string;
}

export interface StartLlamaServerResult {
  process: ChildProcess;
  exitHandler: () => void;
}

/**
 * Start a llama.cpp server process
 *
 * @param options - Server startup options
 * @returns Promise that resolves with the process and exit handler
 */
export async function startLlamaServer(
  options: StartLlamaServerOptions
): Promise<StartLlamaServerResult> {
  const {
    serverPath,
    args,
    logger,
    showNotice,
    onExit,
    serverType = 'llama.cpp server',
  } = options;

  const resolvedPath = await resolveServerPath(serverPath, logger);

  return new Promise((resolve, reject) => {
    const serverProcess = spawn(resolvedPath, args, {
      stdio: 'pipe',
      detached: false, // Ensure child dies when parent dies
    });

    let errorHandled = false;

    serverProcess.on('error', error => {
      errorHandled = true;
      logger?.error(`Failed to start server: ${error.message}`);
      if ('code' in error && error.code === 'ENOENT') {
        showNotice?.(
          `llama-server not found at path: ${serverPath}\n\n` +
            `Resolved path: ${resolvedPath}\n\n` +
            `Please install llama.cpp first.\n` +
            `See README for installation instructions.`,
          0
        );
        reject(
          new Error(`llama-server executable not found at: ${resolvedPath}`)
        );
      } else {
        showNotice?.(
          `Failed to start ${serverType}: ${error.message}\n` +
            `Check console for details.`
        );
        reject(error);
      }
    });

    serverProcess.on('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        logger?.warn(`Server exited with code ${code}`);
      } else if (signal) {
        logger?.warn(`Server killed with signal ${signal}`);
      }
      onExit?.(code, signal);
    });

    serverProcess.stdout?.on('data', data => {
      throw new Error(`Unexpected data on stdout: ${data}`);
    });

    // XXX llama-server seems to output ALL logs to stderr (not just errors)
    // This is abnormal behavior. stderr typically should only be used for
    // error-related messages, and stdout should be used for regular logs.
    // However, this issue seems to still be unresolved, which fundamentally
    // makes it difficult to utilize llama-server's logs:
    // https://github.com/ggml-org/llama.cpp/discussions/6786)
    // Therefore here we filter stderr to show error messages with `logger.error`,
    // relatively important message with `logger.log`, and use `logger.verbose` otherwise.
    serverProcess.stderr?.on('data', data => {
      const message = data.toString().trim();
      if (!message) return;
      const lower = message.toLowerCase();
      if (
        lower.includes('exception') ||
        lower.includes('error') ||
        lower.includes('fail')
      ) {
        logger?.error(`Server: ${message}`);
        return;
      }
      if (
        lower.includes('listening') ||
        lower.includes('model loaded') ||
        message.startsWith('main:')
      ) {
        logger?.log(`Server: ${message}`);
        return;
      }
      logger?.verbose(`Server: ${message}`);
    });

    const exitHandler = () => {
      if (serverProcess && !serverProcess.killed) {
        serverProcess.kill('SIGTERM');
      }
    };

    process.on('exit', exitHandler);
    process.on('SIGINT', exitHandler);
    process.on('SIGTERM', exitHandler);

    // Resolve immediately after spawn (not waiting for server to be ready)
    // Server readiness is checked by health checks in checkReady()
    // Small delay to ensure error event fires before we resolve if there's an immediate error
    setTimeout(() => {
      if (!errorHandled) {
        resolve({ process: serverProcess, exitHandler });
      }
    }, 100);
  });
}

/**
 * Wait for llama server to become ready with progressive delays
 *
 * @param serverUrl - Base URL of the server
 * @param logger - Optional logger
 * @returns Promise that resolves when server is ready
 */
export async function waitForServerReady(
  serverUrl: string,
  logger?: Logger
): Promise<void> {
  await progressiveWait({
    checkReady: () => llamaServerHealthCheck(serverUrl),
    onStillWaiting: () => {
      logger?.log(
        `Still waiting... (Model download may take several minutes on first run)`
      );
    },
  });
}

export async function killServerProcess(
  process: ChildProcess,
  logger?: Logger
): Promise<void> {
  if (process.killed) {
    return;
  }

  return new Promise<void>(resolve => {
    const timeout = setTimeout(() => {
      if (!process.killed) {
        const msg = 'llama-server did not exit after SIGTERM, sending SIGKILL';
        if (logger) {
          logger.warn(msg);
        } else {
          console.warn(msg);
        }
        process.kill('SIGKILL');
      }
    }, 5000);

    process.once('exit', () => {
      clearTimeout(timeout);
      const msg = 'llama-server process exited';
      if (logger) {
        logger.log(msg);
      } else {
        console.log(msg);
      }
      resolve();
    });

    process.kill('SIGTERM');
  });
}
