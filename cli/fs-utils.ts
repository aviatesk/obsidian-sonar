import fs from 'fs/promises';
import path from 'path';

// ファイル一覧を取得（.mdファイルのみ）
export async function getMarkdownFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    try {
      const entries = await fs.readdir(currentDir, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          await walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      // Skip directories we can't read
    }
  }

  await walk(dir);
  return files;
}

export interface IndexData {
  documents: any[];
  metadata?: {
    totalFiles: number;
    totalChunks: number;
    indexedAt: string;
    embeddingModel: string;
    indexPath: string;
  };
}

export async function loadIndex(dbPath: string): Promise<IndexData> {
  try {
    const data = await fs.readFile(dbPath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    return { documents: [] };
  }
}

export async function saveIndex(
  index: IndexData,
  dbPath: string
): Promise<void> {
  const dir = path.dirname(dbPath);
  try {
    await fs.access(dir);
  } catch {
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.writeFile(dbPath, JSON.stringify(index, null, 2));
}

export async function loadConfig<T extends Record<string, any>>(
  defaultConfig: T
): Promise<T> {
  try {
    const configFile = await fs.readFile('./.config.json', 'utf-8');
    const loadedConfig = JSON.parse(configFile);
    // model と embeddingModel のエイリアス処理
    if (loadedConfig.embeddingModel && !loadedConfig.model) {
      loadedConfig.model = loadedConfig.embeddingModel;
    }
    return { ...defaultConfig, ...loadedConfig };
  } catch {
    return defaultConfig;
  }
}

export async function saveConfig(config: Record<string, any>): Promise<void> {
  const configPath = './.config.json';
  const dir = path.dirname(configPath);
  if (dir !== '.' && dir !== '') {
    try {
      await fs.access(dir);
    } catch {
      await fs.mkdir(dir, { recursive: true });
    }
  }
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

// ファイルを読み込み
export async function readFile(filePath: string): Promise<string> {
  return await fs.readFile(filePath, 'utf-8');
}
