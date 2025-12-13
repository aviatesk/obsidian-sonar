// TODO: File-level metadata (mtime, size, indexedAt) is currently duplicated
// across all chunks of the same file. Consider separating into:
// - FileMetadata store: filePath, mtime, size, indexedAt
// - ChunkMetadata store: chunk-specific data only (id, filePath, content, headings)

/**
 * Metadata for a chunk
 */
export interface ChunkMetadata {
  id: string; // Format: filePath#chunkIndex
  filePath: string;
  title: string;
  content: string;
  headings: string[];
  mtime: number;
  size: number;
  indexedAt: number;
  pageNumber?: number; // PDF page number (1-indexed)
}

/**
 * Metadata for files that failed to index
 */
export interface FailedFileMetadata {
  filePath: string;
  mtime: number;
  size: number;
  failedAt: number;
}

import type { EmbedderBackend } from './config';
import type { ConfigManager } from './ConfigManager';
import { WithLogging } from './WithLogging';

export function getDBName(
  vaultName: string,
  embedderBackend: EmbedderBackend,
  modelIdentifier: string
): string {
  // Sanitize vault name and model name for use in DB name
  const sanitize = (str: string) =>
    str.replace(/[^a-zA-Z0-9-_]/g, '_').toLowerCase();

  const sanitizedVault = sanitize(vaultName);
  const sanitizedModel = sanitize(modelIdentifier);

  return `sonar/${sanitizedVault}/${embedderBackend}/${sanitizedModel}`;
}
export const DB_VERSION = 1;

// Store names
export const STORE_METADATA = 'metadata';
export const STORE_EMBEDDINGS = 'embeddings';
export const STORE_BM25_INVERTED_INDEX = 'bm25-inverted-index';
export const STORE_BM25_DOC_TOKENS = 'bm25-doc-tokens';
export const STORE_FAILED_FILES = 'failed-files';

// Index names
export const INDEX_FILE_PATH = 'file-path';

export class MetadataStore extends WithLogging {
  protected readonly componentName = 'MetadataStore';
  private metadataCache: Map<string, ChunkMetadata> | null = null;

  private constructor(
    private db: IDBDatabase,
    protected configManager: ConfigManager
  ) {
    super();
  }

  static async initialize(
    vaultName: string,
    embedderBackend: EmbedderBackend,
    embeddingModel: string,
    configManager: ConfigManager
  ): Promise<MetadataStore> {
    const dbName = getDBName(vaultName, embedderBackend, embeddingModel);
    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(dbName, DB_VERSION);

      request.onerror = () => {
        reject(new Error('Failed to open IndexedDB'));
      };

      request.onsuccess = () => {
        const store = new MetadataStore(request.result, configManager);
        store.log(`Initialized with database ${dbName}`);
        resolve(store);
      };

      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        const db = (event.target as any).result as IDBDatabase;

        if (!db.objectStoreNames.contains(STORE_METADATA)) {
          const store = db.createObjectStore(STORE_METADATA, {
            keyPath: 'id',
          });
          store.createIndex(INDEX_FILE_PATH, 'filePath', {
            unique: false,
          });
        }

        if (!db.objectStoreNames.contains(STORE_EMBEDDINGS)) {
          db.createObjectStore(STORE_EMBEDDINGS, {
            keyPath: 'id',
          });
        }

        if (!db.objectStoreNames.contains(STORE_BM25_INVERTED_INDEX)) {
          db.createObjectStore(STORE_BM25_INVERTED_INDEX, { keyPath: 'token' });
        }
        if (!db.objectStoreNames.contains(STORE_BM25_DOC_TOKENS)) {
          // TODO: Rename keyPath from 'docId' to 'chunkId' (requires DB rebuild)
          db.createObjectStore(STORE_BM25_DOC_TOKENS, { keyPath: 'docId' });
        }

        if (!db.objectStoreNames.contains(STORE_FAILED_FILES)) {
          db.createObjectStore(STORE_FAILED_FILES, { keyPath: 'filePath' });
        }
      };
    });
  }

  getDB(): IDBDatabase {
    return this.db;
  }

  async addChunk(metadata: ChunkMetadata): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_METADATA], 'readwrite');
      const store = transaction.objectStore(STORE_METADATA);
      store.put(metadata);

      transaction.oncomplete = () => {
        this.invalidateCache();
        resolve();
      };
      transaction.onerror = () => reject(new Error('Failed to add chunk'));
    });
  }

  async addChunks(chunks: ChunkMetadata[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_METADATA], 'readwrite');
      const store = transaction.objectStore(STORE_METADATA);

      chunks.forEach(chunk => {
        store.put(chunk);
      });

      transaction.oncomplete = () => {
        this.invalidateCache();
        resolve();
      };
      transaction.onerror = () => reject(new Error('Failed to add chunks'));
    });
  }

  async getChunksByFile(filePath: string): Promise<ChunkMetadata[]> {
    if (this.metadataCache) {
      return Array.from(this.metadataCache.values()).filter(
        chunk => chunk.filePath === filePath
      );
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_METADATA], 'readonly');
      const store = transaction.objectStore(STORE_METADATA);
      const index = store.index(INDEX_FILE_PATH);
      const request = index.getAll(filePath);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Failed to get chunks'));
    });
  }

  async deleteChunks(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_METADATA], 'readwrite');
      const store = transaction.objectStore(STORE_METADATA);
      ids.forEach(id => {
        store.delete(id);
      });
      transaction.oncomplete = () => {
        this.invalidateCache();
        resolve();
      };
      transaction.onerror = () => reject(new Error('Failed to delete chunks'));
    });
  }

  async clearAll(): Promise<void> {
    this.log('Clearing all data...');
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_METADATA], 'readwrite');
      const store = transaction.objectStore(STORE_METADATA);
      store.clear();

      transaction.oncomplete = () => {
        this.invalidateCache();
        this.log('All data cleared');
        resolve();
      };
      transaction.onerror = () => reject(new Error('Failed to clear store'));
    });
  }

  async addFailedFile(failedFile: FailedFileMetadata): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(
        [STORE_FAILED_FILES],
        'readwrite'
      );
      const store = transaction.objectStore(STORE_FAILED_FILES);
      store.put(failedFile);

      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(new Error('Failed to add failed file'));
    });
  }

  async getFailedFile(filePath: string): Promise<FailedFileMetadata | null> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_FAILED_FILES], 'readonly');
      const store = transaction.objectStore(STORE_FAILED_FILES);
      const request = store.get(filePath);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(new Error('Failed to get failed file'));
    });
  }

  async getAllFailedFiles(): Promise<FailedFileMetadata[]> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_FAILED_FILES], 'readonly');
      const store = transaction.objectStore(STORE_FAILED_FILES);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Failed to get failed files'));
    });
  }

  async deleteFailedFile(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(
        [STORE_FAILED_FILES],
        'readwrite'
      );
      const store = transaction.objectStore(STORE_FAILED_FILES);
      store.delete(filePath);

      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(new Error('Failed to delete failed file'));
    });
  }

  async deleteFailedFiles(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) {
      return;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(
        [STORE_FAILED_FILES],
        'readwrite'
      );
      const store = transaction.objectStore(STORE_FAILED_FILES);

      filePaths.forEach(filePath => {
        store.delete(filePath);
      });

      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(new Error('Failed to delete failed files'));
    });
  }

  async clearFailedFiles(): Promise<void> {
    this.log('Clearing failed files data...');
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(
        [STORE_FAILED_FILES],
        'readwrite'
      );
      const store = transaction.objectStore(STORE_FAILED_FILES);
      store.clear();

      transaction.oncomplete = () => {
        this.log('Failed files data cleared');
        resolve();
      };
      transaction.onerror = () =>
        reject(new Error('Failed to clear failed files'));
    });
  }

  async getStats(): Promise<{ totalChunks: number; totalFiles: number }> {
    const chunks = await this.getAllChunks();
    const uniqueFiles = new Set(chunks.map(c => c.filePath));
    return {
      totalChunks: chunks.length,
      totalFiles: uniqueFiles.size,
    };
  }

  async getAllChunks(): Promise<ChunkMetadata[]> {
    if (this.metadataCache) {
      return Array.from(this.metadataCache.values());
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_METADATA], 'readonly');
      const store = transaction.objectStore(STORE_METADATA);
      const request = store.getAll();
      request.onsuccess = () => {
        const chunks = request.result as ChunkMetadata[];
        this.metadataCache = new Map(chunks.map(c => [c.id, c]));
        resolve(chunks);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getFileMetadataMap(): Promise<Map<string, ChunkMetadata>> {
    const allChunks = await this.getAllChunks();
    const metadata = new Map<string, ChunkMetadata>();
    allChunks.forEach(chunk => {
      const filePath = chunk.filePath;
      if (!metadata.has(filePath)) {
        metadata.set(filePath, chunk);
      }
    });
    return metadata;
  }

  async hasFile(filePath: string): Promise<boolean> {
    const chunks = await this.getChunksByFile(filePath);
    return chunks.length > 0;
  }

  async getFileMetadata(filePath: string): Promise<ChunkMetadata | undefined> {
    const chunks = await this.getChunksByFile(filePath);
    return chunks[0];
  }

  private invalidateCache(): void {
    this.metadataCache = null;
  }

  async close() {
    this.db.close();
  }

  /**
   * List all Sonar databases for the given vault
   */
  static async listDatabasesForVault(vaultName: string): Promise<string[]> {
    const sanitize = (str: string) =>
      str.replace(/[^a-zA-Z0-9-_]/g, '_').toLowerCase();
    const sanitizedVault = sanitize(vaultName);
    const prefix = `sonar/${sanitizedVault}/`;

    const databases = await window.indexedDB.databases();
    return databases
      .map(db => db.name)
      .filter(
        (name): name is string => name !== undefined && name.startsWith(prefix)
      );
  }

  /**
   * Delete a specific database by name
   */
  static async deleteDatabase(dbName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = window.indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve();
      request.onerror = () =>
        reject(new Error(`Failed to delete database: ${dbName}`));
      request.onblocked = () => {
        reject(
          new Error(
            `Database deletion blocked: ${dbName} (database is still open)`
          )
        );
      };
    });
  }
}
