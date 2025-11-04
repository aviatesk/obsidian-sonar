import type { ConfigManager } from './ConfigManager';
import { STORE_EMBEDDINGS } from './MetadataStore';
import { WithLogging } from './WithLogging';

/**
 * Embedding data for a document chunk or title
 */
export interface EmbeddingData {
  id: string; // Format: filePath#chunkIndex or filePath#title
  embedding: number[];
}

export class EmbeddingStore extends WithLogging {
  protected readonly componentName = 'EmbeddingStore';
  private embeddingsCache: EmbeddingData[] | null = null;

  constructor(
    private db: IDBDatabase,
    protected configManager: ConfigManager
  ) {
    super();
  }

  async addEmbedding(id: string, embedding: number[]): Promise<void> {
    const embeddingData: EmbeddingData = {
      id,
      embedding,
    };

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_EMBEDDINGS], 'readwrite');
      const store = transaction.objectStore(STORE_EMBEDDINGS);
      store.put(embeddingData);

      transaction.oncomplete = () => {
        this.invalidateCache();
        resolve();
      };
      transaction.onerror = () => reject(new Error('Failed to add embedding'));
    });
  }

  async addEmbeddings(
    embeddings: Array<{
      id: string;
      embedding: number[];
    }>
  ): Promise<void> {
    if (embeddings.length === 0) return;

    this.log(`Indexing ${embeddings.length} embeddings...`);

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
        this.log(`Indexed ${embeddings.length} embeddings`);
        resolve();
      };
      transaction.onerror = () => reject(new Error('Failed to add embeddings'));
    });
  }

  async deleteEmbeddings(documentIds: string[]): Promise<void> {
    if (documentIds.length === 0) {
      return;
    }

    this.log(`Deleting ${documentIds.length} embeddings...`);

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_EMBEDDINGS], 'readwrite');
      const store = transaction.objectStore(STORE_EMBEDDINGS);
      documentIds.forEach(id => {
        store.delete(id);
      });
      transaction.oncomplete = () => {
        this.invalidateCache();
        this.log(`Deleted ${documentIds.length} embeddings`);
        resolve();
      };
      transaction.onerror = () =>
        reject(new Error('Failed to delete embeddings'));
    });
  }

  async clearAll(): Promise<void> {
    this.log('Clearing all data...');

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_EMBEDDINGS], 'readwrite');
      const store = transaction.objectStore(STORE_EMBEDDINGS);
      store.clear();

      transaction.oncomplete = () => {
        this.invalidateCache();
        this.log('All data cleared');
        resolve();
      };
      transaction.onerror = () => reject(new Error('Failed to clear store'));
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
