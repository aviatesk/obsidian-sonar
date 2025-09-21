import { createHash } from 'crypto';

/**
 * Metadata associated with a document chunk
 */
export interface DocumentMetadata {
  filePath: string;
  title: string;
  headings: string[];
  mtime: number; // File modification time in milliseconds
  size: number; // File size in bytes
  indexedAt: number; // When the file was indexed
}

/**
 * An indexed document chunk with its content and metadata
 */
export interface IndexedDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata: DocumentMetadata;
}

const STORE_NAME = 'vectors';
const DB_NAME = 'sonar-embedding-vectors';
const DB_VERSION = 1;

export class VectorStore {
  private db!: IDBDatabase;
  private documentsCache: IndexedDocument[] | null = null;

  private constructor(db: IDBDatabase) {
    this.db = db;
  }
  static async initialize(): Promise<VectorStore> {
    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => {
        reject(new Error('Failed to open IndexedDB'));
      };
      request.onsuccess = () => {
        console.log('Vector store initialized');
        resolve(new VectorStore(request.result));
      };
      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        const db = (event.target as any).result as IDBDatabase;

        // Create vector store if it doesn't exist
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const vectorStore = db.createObjectStore(STORE_NAME, {
            keyPath: 'id',
          });
          vectorStore.createIndex('filePath', 'metadata.filePath', {
            unique: false,
          });
        }
      };
    });
  }

  private generateId(content: string, metadata: any): string {
    const hash = createHash('sha256');
    hash.update(content);
    hash.update(JSON.stringify(metadata));
    return hash.digest('hex').substring(0, 16);
  }

  async addDocument(
    content: string,
    embedding: number[],
    metadata: DocumentMetadata
  ): Promise<void> {
    const id = this.generateId(content, metadata);
    const document: IndexedDocument = {
      id,
      content,
      embedding,
      metadata,
    };

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(document);

      request.onsuccess = () => {
        this.invalidateCache();
        resolve();
      };
      request.onerror = () => reject(new Error('Failed to add document'));
    });
  }

  async addDocuments(
    documents: Array<{
      content: string;
      embedding: number[];
      metadata: DocumentMetadata;
    }>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      documents.forEach(doc => {
        const id = this.generateId(doc.content, doc.metadata);
        const document: IndexedDocument = {
          id,
          content: doc.content,
          embedding: doc.embedding,
          metadata: doc.metadata,
        };
        store.put(document);
      });

      transaction.oncomplete = () => {
        this.invalidateCache();
        resolve();
      };
      transaction.onerror = () => reject(new Error('Failed to add documents'));
    });
  }

  async getDocumentsByFile(filePath: string): Promise<IndexedDocument[]> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index('filePath');
      const request = index.getAll(filePath);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Failed to get documents'));
    });
  }

  async deleteDocumentsByFile(filePath: string): Promise<void> {
    const documents = await this.getDocumentsByFile(filePath);
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      documents.forEach(doc => {
        store.delete(doc.id);
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
      const transaction = this.db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => {
        this.invalidateCache();
        resolve();
      };
      request.onerror = () => reject(new Error('Failed to clear store'));
    });
  }

  async getStats(): Promise<{ totalDocuments: number; totalFiles: number }> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const countRequest = store.count();

      countRequest.onsuccess = () => {
        const totalDocuments = countRequest.result;
        const getAllRequest = store.getAll();

        getAllRequest.onsuccess = () => {
          const documents = getAllRequest.result as IndexedDocument[];
          const uniqueFiles = new Set(documents.map(d => d.metadata.filePath));

          resolve({
            totalDocuments,
            totalFiles: uniqueFiles.size,
          });
        };

        getAllRequest.onerror = () => reject(new Error('Failed to get stats'));
      };

      countRequest.onerror = () => reject(new Error('Failed to get count'));
    });
  }

  async close() {
    this.db.close();
  }

  private invalidateCache(): void {
    this.documentsCache = null;
  }

  async getAllDocuments(): Promise<IndexedDocument[]> {
    // Return cached documents if available (perf optimization to avoid UI blocking)
    if (this.documentsCache) {
      return this.documentsCache;
    }

    // Fetch from IndexedDB and update cache
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => {
        const documents = request.result as IndexedDocument[];
        this.documentsCache = documents;
        resolve(documents);
      };
      request.onerror = () => reject(request.error);
    });
  }
}
