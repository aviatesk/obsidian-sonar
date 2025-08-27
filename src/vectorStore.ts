import { createHash } from 'crypto';
import { cosineSimilarity } from './core/chunking';
import { IndexedDocument, SearchResult } from './core/document';

// Deprecated: Use IndexedDocument from './core/document' instead
export type VectorDocument = IndexedDocument;

const STORE_NAME = 'vectors';
const META_STORE_NAME = 'metadata';
const DB_NAME = 'sonar-embedding-vectors';

export class ObsidianVectorStore {
  private db: IDBDatabase;
  private constructor(db: IDBDatabase) {
    this.db = db;
  }
  static async initialize(): Promise<ObsidianVectorStore> {
    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DB_NAME, 1);
      request.onerror = () => {
        reject(new Error('Failed to open IndexedDB'));
      };
      request.onsuccess = () => {
        console.log('Vector store initialized');
        resolve(new ObsidianVectorStore(request.result));
      };
      // TODO Revisit
      request.onupgradeneeded = event => {
        const db = (event.target as any).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const vectorStore = db.createObjectStore(STORE_NAME, {
            keyPath: 'id',
          });
          vectorStore.createIndex('filePath', 'metadata.filePath', {
            unique: false,
          });
          vectorStore.createIndex('timestamp', 'metadata.timestamp', {
            unique: false,
          });
        }
        if (!db.objectStoreNames.contains(META_STORE_NAME)) {
          db.createObjectStore(META_STORE_NAME, { keyPath: 'key' });
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
    metadata: any
  ): Promise<void> {
    const id = this.generateId(content, metadata);
    const document: IndexedDocument = {
      id,
      content,
      embedding,
      metadata: {
        ...metadata,
        timestamp: Date.now(),
      },
    };

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(document);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error('Failed to add document'));
    });
  }

  async addDocuments(
    documents: Array<{
      content: string;
      embedding: number[];
      metadata: any;
    }>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      documents.forEach(doc => {
        const id = this.generateId(doc.content, doc.metadata);
        const document: IndexedDocument = {
          id,
          content: doc.content,
          embedding: doc.embedding,
          metadata: {
            ...doc.metadata,
            timestamp: Date.now(),
          },
        };
        store.put(document);
      });

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('Failed to add documents'));
    });
  }

  async search(
    queryEmbedding: number[],
    topK: number
  ): Promise<SearchResult[]> {
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => {
        const documents = request.result as IndexedDocument[];
        const results = documents.map(doc => ({
          document: doc,
          score: cosineSimilarity(queryEmbedding, doc.embedding),
        }));
        results.sort((a, b) => b.score - a.score);
        resolve(results.slice(0, topK));
      };
      request.onerror = () => reject(new Error('Failed to search documents'));
    });
  }

  async getDocumentsByFile(filePath: string): Promise<IndexedDocument[]> {
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
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
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      documents.forEach(doc => {
        store.delete(doc.id);
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(new Error('Failed to delete documents'));
    });
  }

  async clearAll(): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error('Failed to clear store'));
    });
  }

  async getStats(): Promise<{ totalDocuments: number; totalFiles: number }> {
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
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

  async getAllDocuments(): Promise<IndexedDocument[]> {
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result as IndexedDocument[]);
      request.onerror = () => reject(request.error);
    });
  }
}
