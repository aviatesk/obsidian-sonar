/**
 * Metadata associated with a document chunk
 */
export interface DocumentMetadata {
  id: string; // Format: filePath#chunkIndex
  filePath: string;
  title: string;
  content: string;
  headings: string[];
  mtime: number;
  size: number;
  indexedAt: number;
}

// Database configuration
export const DB_NAME = 'sonar-db';
export const DB_VERSION = 1;

// Store names
export const STORE_METADATA = 'metadata';
export const STORE_EMBEDDINGS = 'embeddings';
export const STORE_BM25_INVERTED_INDEX = 'bm25-inverted-index';
export const STORE_BM25_DOC_TOKENS = 'bm25-doc-tokens';

// Index names
export const INDEX_FILE_PATH = 'file-path';

export class MetadataStore {
  private metadataCache: Map<string, DocumentMetadata> | null = null;

  private constructor(private db: IDBDatabase) {}

  static async initialize(): Promise<MetadataStore> {
    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        reject(new Error('Failed to open IndexedDB'));
      };

      request.onsuccess = () => {
        resolve(new MetadataStore(request.result));
      };

      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        const db = (event.target as any).result as IDBDatabase;

        // Create metadata store
        if (!db.objectStoreNames.contains(STORE_METADATA)) {
          const store = db.createObjectStore(STORE_METADATA, {
            keyPath: 'id',
          });
          store.createIndex(INDEX_FILE_PATH, 'filePath', {
            unique: false,
          });
        }

        // Create embeddings store
        if (!db.objectStoreNames.contains(STORE_EMBEDDINGS)) {
          db.createObjectStore(STORE_EMBEDDINGS, {
            keyPath: 'id',
          });
        }

        // Create BM25 stores
        if (!db.objectStoreNames.contains(STORE_BM25_INVERTED_INDEX)) {
          db.createObjectStore(STORE_BM25_INVERTED_INDEX, { keyPath: 'token' });
        }
        if (!db.objectStoreNames.contains(STORE_BM25_DOC_TOKENS)) {
          db.createObjectStore(STORE_BM25_DOC_TOKENS, { keyPath: 'docId' });
        }
      };
    });
  }

  getDB(): IDBDatabase {
    return this.db;
  }

  async addDocument(metadata: DocumentMetadata): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_METADATA], 'readwrite');
      const store = transaction.objectStore(STORE_METADATA);
      store.put(metadata);

      transaction.oncomplete = () => {
        this.invalidateCache();
        resolve();
      };
      transaction.onerror = () => reject(new Error('Failed to add document'));
    });
  }

  async addDocuments(documents: DocumentMetadata[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_METADATA], 'readwrite');
      const store = transaction.objectStore(STORE_METADATA);

      documents.forEach(doc => {
        store.put(doc);
      });

      transaction.oncomplete = () => {
        this.invalidateCache();
        resolve();
      };
      transaction.onerror = () => reject(new Error('Failed to add documents'));
    });
  }

  async getDocumentsByFile(filePath: string): Promise<DocumentMetadata[]> {
    if (this.metadataCache) {
      return Array.from(this.metadataCache.values()).filter(
        doc => doc.filePath === filePath
      );
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_METADATA], 'readonly');
      const store = transaction.objectStore(STORE_METADATA);
      const index = store.index(INDEX_FILE_PATH);
      const request = index.getAll(filePath);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Failed to get documents'));
    });
  }

  async deleteDocuments(ids: string[]): Promise<void> {
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
      transaction.onerror = () =>
        reject(new Error('Failed to delete documents'));
    });
  }

  async clearAll(): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_METADATA], 'readwrite');
      const store = transaction.objectStore(STORE_METADATA);
      store.clear();

      transaction.oncomplete = () => {
        this.invalidateCache();
        resolve();
      };
      transaction.onerror = () => reject(new Error('Failed to clear store'));
    });
  }

  async getStats(): Promise<{ totalDocuments: number; totalFiles: number }> {
    const documents = await this.getAllDocuments();
    const uniqueFiles = new Set(documents.map(d => d.filePath));
    return {
      totalDocuments: documents.length,
      totalFiles: uniqueFiles.size,
    };
  }

  async getAllDocuments(): Promise<DocumentMetadata[]> {
    if (this.metadataCache) {
      return Array.from(this.metadataCache.values());
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_METADATA], 'readonly');
      const store = transaction.objectStore(STORE_METADATA);
      const request = store.getAll();
      request.onsuccess = () => {
        const documents = request.result as DocumentMetadata[];
        this.metadataCache = new Map(documents.map(d => [d.id, d]));
        resolve(documents);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getFileMetadataMap(): Promise<Map<string, DocumentMetadata>> {
    const allDocs = await this.getAllDocuments();
    const metadata = new Map<string, DocumentMetadata>();
    allDocs.forEach(doc => {
      const filePath = doc.filePath;
      if (!metadata.has(filePath)) {
        metadata.set(filePath, doc);
      }
    });
    return metadata;
  }

  async hasFile(filePath: string): Promise<boolean> {
    const docs = await this.getDocumentsByFile(filePath);
    return docs.length > 0;
  }

  private invalidateCache(): void {
    this.metadataCache = null;
  }

  async close() {
    this.db.close();
  }
}
