import type { Logger } from './Logger';
import { STORE_EMBEDDINGS } from './MetadataStore';

/**
 * Embedding data for a document chunk or title
 */
export interface EmbeddingData {
  id: string; // Format: filePath#chunkIndex or filePath#title
  embedding: number[];
}

export class EmbeddingStore {
  private embeddingsCache: EmbeddingData[] | null = null;

  constructor(
    private db: IDBDatabase,
    private logger: Logger
  ) {}

  async addEmbedding(id: string, embedding: number[]): Promise<void> {
    const embeddingData: EmbeddingData = {
      id,
      embedding,
    };

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_EMBEDDINGS], 'readwrite');
      const store = transaction.objectStore(STORE_EMBEDDINGS);
      const request = store.put(embeddingData);

      request.onsuccess = () => {
        this.invalidateCache();
        resolve();
      };
      request.onerror = () => reject(new Error('Failed to add embedding'));
    });
  }

  async addEmbeddings(
    embeddings: Array<{
      id: string;
      embedding: number[];
    }>
  ): Promise<void> {
    if (embeddings.length === 0) return;

    this.logger.log(
      `EmbeddingStore: Batch indexing ${embeddings.length} embeddings`
    );

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_EMBEDDINGS], 'readwrite');
      const store = transaction.objectStore(STORE_EMBEDDINGS);

      embeddings.forEach(emb => {
        const embeddingData: EmbeddingData = {
          id: emb.id,
          embedding: emb.embedding,
        };
        store.put(embeddingData);
      });

      transaction.oncomplete = () => {
        this.invalidateCache();
        this.logger.log('EmbeddingStore: Batch indexing complete');
        resolve();
      };
      transaction.onerror = () => reject(new Error('Failed to add embeddings'));
    });
  }

  async deleteEmbeddings(documentIds: string[]): Promise<void> {
    if (documentIds.length === 0) {
      return;
    }

    this.logger.log(
      `EmbeddingStore: Deleting ${documentIds.length} embeddings`
    );

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_EMBEDDINGS], 'readwrite');
      const store = transaction.objectStore(STORE_EMBEDDINGS);
      documentIds.forEach(id => {
        store.delete(id);
      });
      transaction.oncomplete = () => {
        this.invalidateCache();
        this.logger.log('EmbeddingStore: Deletion complete');
        resolve();
      };
      transaction.onerror = () =>
        reject(new Error('Failed to delete embeddings'));
    });
  }

  async clearAll(): Promise<void> {
    this.logger.log('EmbeddingStore: Clearing all data...');

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_EMBEDDINGS], 'readwrite');
      const store = transaction.objectStore(STORE_EMBEDDINGS);
      const request = store.clear();
      request.onsuccess = () => {
        this.invalidateCache();
        this.logger.log('EmbeddingStore: All data cleared');
        resolve();
      };
      request.onerror = () => reject(new Error('Failed to clear store'));
    });
  }

  private invalidateCache(): void {
    this.embeddingsCache = null;
  }

  async getAllEmbeddings(): Promise<EmbeddingData[]> {
    if (this.embeddingsCache) {
      return this.embeddingsCache;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_EMBEDDINGS], 'readonly');
      const store = transaction.objectStore(STORE_EMBEDDINGS);
      const request = store.getAll();
      request.onsuccess = () => {
        const embeddings = request.result as EmbeddingData[];
        this.embeddingsCache = embeddings;
        resolve(embeddings);
      };
      request.onerror = () => reject(request.error);
    });
  }
}
