import type { ConfigManager } from './ConfigManager';
import type { Embedder } from './Embedder';
import {
  STORE_BM25_INVERTED_INDEX,
  STORE_BM25_DOC_TOKENS,
} from './MetadataStore';
import { WithLogging } from './WithLogging';

/**
 * Posting list entry for inverted index
 */
interface PostingEntry {
  docId: string;
  frequency: number;
}

/**
 * Inverted index: token -> list of documents containing it
 */
interface InvertedIndexEntry {
  token: string;
  postings: PostingEntry[];
  documentFrequency: number; // Number of documents containing this token
}

/**
 * Chunk metadata for BM25
 */
interface ChunkTokenInfo {
  docId: string;
  tokens: string[];
  length: number; // Total number of tokens in chunk
}

/**
 * In-memory index metadata for fast BM25 scoring
 * Derived from doc-tokens store, refreshed on demand
 */
interface IndexMetadata {
  totalDocuments: number;
  averageDocLength: number;
  docLengths: Map<string, number>;
}

// BM25 parameters
const K1 = 1.2;
const B = 0.75;

export class BM25Store extends WithLogging {
  protected readonly componentName = 'BM25Store';
  private metadataCache: IndexMetadata | null = null;

  private constructor(
    private db: IDBDatabase,
    protected configManager: ConfigManager,
    private embedder: Embedder
  ) {
    super();
  }

  static async initialize(
    db: IDBDatabase,
    configManager: ConfigManager,
    embedder: Embedder
  ): Promise<BM25Store> {
    const store = new BM25Store(db, configManager, embedder);
    await store.refreshMetaDataCache(); // Build initial in-memory index metadata
    return store;
  }

  /**
   * Refreshes index metadata from doc-tokens store
   * Called on initialization and after cache invalidation
   */
  private async refreshMetaDataCache(): Promise<void> {
    const allChunks = await this.getAllChunkTokenInfos();

    const docLengths = new Map<string, number>();
    let totalLength = 0;

    for (const chunk of allChunks) {
      docLengths.set(chunk.docId, chunk.length);
      totalLength += chunk.length;
    }

    this.metadataCache = {
      totalDocuments: allChunks.length,
      averageDocLength:
        allChunks.length > 0 ? totalLength / allChunks.length : 0,
      docLengths,
    };

    this.log(`Index metadata refreshed (${allChunks.length} chunks)`);
  }

  /**
   * Invalidates in-memory cache
   * Must be called after any write operation to doc-tokens store
   */
  private clearMetaDataCache(): void {
    this.metadataCache = null;
  }

  /**
   * Gets index metadata, refreshing cache if needed
   */
  private async getMetaData(): Promise<IndexMetadata> {
    if (!this.metadataCache) {
      await this.refreshMetaDataCache();
    }
    return this.metadataCache!;
  }

  /**
   * Indexes multiple chunks in a single transaction (much faster than individual indexing)
   */
  async indexChunkBatch(
    chunks: Array<{ docId: string; content: string }>,
    progressCallback?: (current: number, total: number) => void
  ): Promise<void> {
    if (chunks.length === 0) return;

    this.log(`Indexing ${chunks.length} chunks...`);

    // Phase 1: Tokenize all chunks
    const chunksTokenInfo: ChunkTokenInfo[] = [];
    const allTokensToFetch = new Set<string>();

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const tokens = await this.tokenize(chunk.content);
      const termFreq = this.calculateTermFrequency(tokens);

      chunksTokenInfo.push({
        docId: chunk.docId,
        tokens,
        length: tokens.length,
      });

      for (const token of termFreq.keys()) {
        allTokensToFetch.add(token);
      }

      if (progressCallback && (i % 10 === 0 || i === chunks.length - 1)) {
        progressCallback(i + 1, chunks.length);
      }
    }

    // Phase 2: Read existing data and build inverted index
    const existingChunks = await Promise.all(
      chunks.map(chunk => this.getChunkTokenInfo(chunk.docId))
    );

    for (const existingChunk of existingChunks) {
      if (existingChunk) {
        existingChunk.tokens.forEach(t => allTokensToFetch.add(t));
      }
    }

    const invertedEntries =
      await this.bulkGetInvertedIndexEntries(allTokensToFetch);

    // Phase 3: Build final inverted index in memory
    const modifiedTokens = new Set<string>();

    for (let i = 0; i < chunks.length; i++) {
      const chunkInfo = chunksTokenInfo[i];
      const existingChunk = existingChunks[i];
      const termFreq = this.calculateTermFrequency(chunkInfo.tokens);

      if (existingChunk) {
        const uniqueTokens = new Set(existingChunk.tokens);
        for (const token of uniqueTokens) {
          const entry = invertedEntries.get(token);
          if (entry) {
            entry.postings = entry.postings.filter(
              p => p.docId !== chunkInfo.docId
            );
            entry.documentFrequency = entry.postings.length;
            modifiedTokens.add(token);
          }
        }
      }

      for (const [token, freq] of termFreq.entries()) {
        const existing = invertedEntries.get(token);
        const newPosting: PostingEntry = {
          docId: chunkInfo.docId,
          frequency: freq,
        };

        if (existing) {
          existing.postings.push(newPosting);
          existing.documentFrequency = existing.postings.length;
        } else {
          const newEntry: InvertedIndexEntry = {
            token,
            postings: [newPosting],
            documentFrequency: 1,
          };
          invertedEntries.set(token, newEntry);
        }
        modifiedTokens.add(token);
      }
    }

    // Phase 4: Write to database - only modified tokens
    const transaction = this.db.transaction(
      [STORE_BM25_INVERTED_INDEX, STORE_BM25_DOC_TOKENS],
      'readwrite'
    );

    const docTokensStore = transaction.objectStore(STORE_BM25_DOC_TOKENS);
    const invertedIndexStore = transaction.objectStore(
      STORE_BM25_INVERTED_INDEX
    );

    // Write chunk token info
    for (const chunkInfo of chunksTokenInfo) {
      docTokensStore.put(chunkInfo);
    }

    // Write inverted index
    for (const token of modifiedTokens) {
      const entry = invertedEntries.get(token);
      if (!entry || entry.postings.length === 0) {
        invertedIndexStore.delete(token);
      } else {
        invertedIndexStore.put(entry);
      }
    }

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => {
        this.clearMetaDataCache();
        this.log(`Indexed ${chunks.length} chunks`);
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    });
  }

  /**
   * Deletes chunks by their IDs
   * IDs come from MetadataStore as the source of truth
   */
  async deleteChunks(chunkIds: string[]): Promise<void> {
    if (chunkIds.length === 0) {
      return;
    }

    this.log(`Deleting ${chunkIds.length} chunks...`);

    // Phase 1: Read all data we need
    const chunksToRemove = await Promise.all(
      chunkIds.map(id => this.getChunkTokenInfo(id))
    );
    const validChunks = chunksToRemove.filter(
      (chunk): chunk is ChunkTokenInfo => chunk !== undefined
    );

    if (validChunks.length === 0) {
      this.warn('No chunks found to remove');
      return;
    }

    this.log(`Found ${validChunks.length} chunks to remove`);

    // Collect all tokens from chunks to remove
    const allTokens = new Set<string>();
    for (const chunk of validChunks) {
      chunk.tokens.forEach(t => allTokens.add(t));
    }

    // Fetch all inverted index entries using bulk read
    const invertedEntries = await this.bulkGetInvertedIndexEntries(allTokens);

    // Phase 2: Write transaction - all synchronous
    const transaction = this.db.transaction(
      [STORE_BM25_INVERTED_INDEX, STORE_BM25_DOC_TOKENS],
      'readwrite'
    );

    const docTokensStore = transaction.objectStore(STORE_BM25_DOC_TOKENS);
    const invertedIndexStore = transaction.objectStore(
      STORE_BM25_INVERTED_INDEX
    );

    // Process each chunk to remove
    for (const chunk of validChunks) {
      const uniqueTokens = new Set(chunk.tokens);
      for (const token of uniqueTokens) {
        const entry = invertedEntries.get(token);
        if (entry) {
          entry.postings = entry.postings.filter(p => p.docId !== chunk.docId);
          if (entry.postings.length === 0) {
            invertedIndexStore.delete(token);
          } else {
            entry.documentFrequency = entry.postings.length;
            invertedIndexStore.put(entry);
          }
        }
      }
      docTokensStore.delete(chunk.docId);
    }

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => {
        this.clearMetaDataCache();
        this.log(`Deleted ${validChunks.length} chunks`);
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    });
  }

  /**
   * Searches using BM25 scoring
   */
  async search(
    query: string,
    topK: number
  ): Promise<Array<{ docId: string; score: number }>> {
    const queryTokens = await this.tokenize(query);
    const metadata = await this.getMetaData();

    if (metadata.totalDocuments === 0) {
      return [];
    }

    // Get IDF and posting lists for each query token
    const tokenData = await Promise.all(
      queryTokens.map(async token => {
        const entry = await this.getInvertedIndexEntry(token);
        if (!entry) {
          return null;
        }

        // Calculate IDF
        const idf = this.calculateIDF(
          entry.documentFrequency,
          metadata.totalDocuments
        );

        return { token, idf, postings: entry.postings };
      })
    );

    // Aggregate scores by document using cached doc lengths
    const docScores = new Map<string, number>();

    for (const data of tokenData) {
      if (!data) continue;

      for (const posting of data.postings) {
        const docLength = metadata.docLengths.get(posting.docId) || 0;
        const score = this.calculateBM25Score(
          data.idf,
          posting.frequency,
          docLength,
          metadata.averageDocLength
        );

        docScores.set(
          posting.docId,
          (docScores.get(posting.docId) || 0) + score
        );
      }
    }

    const results = Array.from(docScores.entries())
      .map(([docId, score]) => ({ docId, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return results;
  }

  private calculateIDF(
    documentFrequency: number,
    totalDocuments: number
  ): number {
    return Math.log(
      (totalDocuments - documentFrequency + 0.5) / (documentFrequency + 0.5) + 1
    );
  }

  private calculateBM25Score(
    idf: number,
    termFreq: number,
    docLength: number,
    avgDocLength: number
  ): number {
    const numerator = termFreq * (K1 + 1);
    const denominator =
      termFreq + K1 * (1 - B + B * (docLength / avgDocLength));
    return idf * (numerator / denominator);
  }

  private async getInvertedIndexEntry(
    token: string,
    store?: IDBObjectStore
  ): Promise<InvertedIndexEntry | undefined> {
    const indexStore =
      store ||
      this.db
        .transaction([STORE_BM25_INVERTED_INDEX], 'readonly')
        .objectStore(STORE_BM25_INVERTED_INDEX);

    return new Promise((resolve, reject) => {
      const req = indexStore.get(token);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Bulk fetch inverted index entries using parallel get operations
   */
  private async bulkGetInvertedIndexEntries(
    tokens: Set<string>
  ): Promise<Map<string, InvertedIndexEntry | undefined>> {
    if (tokens.size === 0) {
      return new Map();
    }

    const transaction = this.db.transaction(
      [STORE_BM25_INVERTED_INDEX],
      'readonly'
    );
    const store = transaction.objectStore(STORE_BM25_INVERTED_INDEX);

    const promises = Array.from(tokens).map(
      token =>
        new Promise<[string, InvertedIndexEntry | undefined]>(
          (resolve, reject) => {
            const request = store.get(token);
            request.onsuccess = () => resolve([token, request.result]);
            request.onerror = () => reject(request.error);
          }
        )
    );

    const entries = await Promise.all(promises);
    return new Map(entries);
  }

  private async getChunkTokenInfo(
    docId: string
  ): Promise<ChunkTokenInfo | undefined> {
    const transaction = this.db.transaction(
      [STORE_BM25_DOC_TOKENS],
      'readonly'
    );
    const store = transaction.objectStore(STORE_BM25_DOC_TOKENS);

    return new Promise((resolve, reject) => {
      const req = store.get(docId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async getAllChunkTokenInfos(): Promise<ChunkTokenInfo[]> {
    const transaction = this.db.transaction(
      [STORE_BM25_DOC_TOKENS],
      'readonly'
    );
    const store = transaction.objectStore(STORE_BM25_DOC_TOKENS);

    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async clearAll(): Promise<void> {
    this.log('Clearing all data...');

    const transaction = this.db.transaction(
      [STORE_BM25_INVERTED_INDEX, STORE_BM25_DOC_TOKENS],
      'readwrite'
    );

    transaction.objectStore(STORE_BM25_INVERTED_INDEX).clear();
    transaction.objectStore(STORE_BM25_DOC_TOKENS).clear();

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => {
        this.clearMetaDataCache();
        this.log('All data cleared');
        resolve();
      };
      transaction.onerror = () => {
        this.error(`Failed to clear data: ${transaction.error}`);
        reject(transaction.error);
      };
    });
  }

  /**
   * Tokenizes text for BM25 indexing and search
   * Uses embedder tokenizer
   * Returns token IDs as strings for efficient exact matching
   */
  private async tokenize(
    text: string,
    toLowerCase: boolean = true
  ): Promise<string[]> {
    // Normalize text
    let normalizedText = text;
    if (toLowerCase) {
      normalizedText = text.toLowerCase();
    }

    // Get token IDs using Embedder API (handles large texts internally)
    const tokenIds = await this.embedder.getTokenIds(normalizedText);

    // Convert to strings for BM25 matching
    return tokenIds.map(id => String(id));
  }

  /**
   * Calculates term frequency in a document
   */
  private calculateTermFrequency(tokens: string[]): Map<string, number> {
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }
    return tf;
  }
}
