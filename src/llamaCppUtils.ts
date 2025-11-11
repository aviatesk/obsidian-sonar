import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

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
