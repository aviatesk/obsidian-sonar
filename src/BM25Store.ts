import type { Logger } from './Logger';
import { BM25Tokenizer } from './BM25Tokenizer';

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
 * Document metadata for BM25
 */
interface DocumentTokenInfo {
  docId: string;
  tokens: string[];
  length: number; // Total number of tokens in document
}

/**
 * Global statistics for BM25 scoring
 */
interface BM25Stats {
  totalDocuments: number;
  averageDocLength: number;
  version: number; // Incremented on each update for cache invalidation
}

const DB_NAME = 'sonar-bm25-index';
const DB_VERSION = 1;
const INVERTED_INDEX_STORE = 'inverted-index';
const DOC_TOKENS_STORE = 'doc-tokens';
const STATS_STORE = 'stats';
const STATS_KEY = 'global-stats';

// BM25 parameters
const K1 = 1.2;
const B = 0.75;

export class BM25Store {
  private db!: IDBDatabase;
  private logger: Logger;
  private tokenizer: BM25Tokenizer;
  private statsCache: BM25Stats | null = null;

  private constructor(db: IDBDatabase, logger: Logger) {
    this.db = db;
    this.logger = logger;
    this.tokenizer = new BM25Tokenizer();
  }

  static async initialize(logger: Logger): Promise<BM25Store> {
    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        reject(new Error('Failed to open BM25 IndexedDB'));
      };

      request.onsuccess = () => {
        const store = new BM25Store(request.result, logger);
        store.logger.log('BM25 store initialized');
        resolve(store);
      };

      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        const db = (event.target as any).result as IDBDatabase;

        // Create inverted index store
        if (!db.objectStoreNames.contains(INVERTED_INDEX_STORE)) {
          db.createObjectStore(INVERTED_INDEX_STORE, { keyPath: 'token' });
        }

        // Create document tokens store
        if (!db.objectStoreNames.contains(DOC_TOKENS_STORE)) {
          db.createObjectStore(DOC_TOKENS_STORE, { keyPath: 'docId' });
        }

        // Create stats store
        if (!db.objectStoreNames.contains(STATS_STORE)) {
          db.createObjectStore(STATS_STORE);
        }

        logger.log('BM25 store schema created');
      };
    });
  }

  /**
   * Indexes a document for BM25 search
   */
  async indexDocument(docId: string, content: string): Promise<void> {
    const tokens = this.tokenizer.tokenize(content);
    const termFreq = this.tokenizer.calculateTermFrequency(tokens);

    const docTokenInfo: DocumentTokenInfo = {
      docId,
      tokens,
      length: tokens.length,
    };

    // Phase 1: Read all data we need
    const existingDoc = await this.getDocumentTokenInfo(docId);
    const stats = await this.getStats();

    // Collect all tokens we need to fetch
    const tokensToFetch = new Set([...termFreq.keys()]);
    if (existingDoc) {
      existingDoc.tokens.forEach(t => tokensToFetch.add(t));
    }

    // Fetch all inverted index entries
    const invertedEntries = new Map<string, InvertedIndexEntry | undefined>();
    for (const token of tokensToFetch) {
      const entry = await this.getInvertedIndexEntry(token);
      invertedEntries.set(token, entry);
    }

    // Compute new stats
    let newStats: BM25Stats;
    if (existingDoc) {
      // Replacing existing document
      const newTotalDocs = stats.totalDocuments;
      const newAvgDocLength =
        (stats.averageDocLength * stats.totalDocuments -
          existingDoc.length +
          tokens.length) /
        newTotalDocs;
      newStats = {
        totalDocuments: newTotalDocs,
        averageDocLength: newAvgDocLength,
        version: stats.version + 1,
      };
    } else {
      // Adding new document
      const newTotalDocs = stats.totalDocuments + 1;
      const newAvgDocLength =
        (stats.averageDocLength * stats.totalDocuments + tokens.length) /
        newTotalDocs;
      newStats = {
        totalDocuments: newTotalDocs,
        averageDocLength: newAvgDocLength,
        version: stats.version + 1,
      };
    }

    // Phase 2: Write transaction - all synchronous
    const transaction = this.db.transaction(
      [INVERTED_INDEX_STORE, DOC_TOKENS_STORE, STATS_STORE],
      'readwrite'
    );

    const docTokensStore = transaction.objectStore(DOC_TOKENS_STORE);
    const invertedIndexStore = transaction.objectStore(INVERTED_INDEX_STORE);
    const statsStore = transaction.objectStore(STATS_STORE);

    // Remove old document if exists
    if (existingDoc) {
      const uniqueTokens = new Set(existingDoc.tokens);
      for (const token of uniqueTokens) {
        const entry = invertedEntries.get(token);
        if (entry) {
          entry.postings = entry.postings.filter(p => p.docId !== docId);
          if (entry.postings.length === 0) {
            invertedIndexStore.delete(token);
          } else {
            entry.documentFrequency = entry.postings.length;
            invertedIndexStore.put(entry);
          }
        }
      }
      docTokensStore.delete(docId);
    }

    // Add new document
    docTokensStore.put(docTokenInfo);

    // Update inverted index
    for (const [token, freq] of termFreq.entries()) {
      const existing = invertedEntries.get(token);
      const newPosting: PostingEntry = { docId, frequency: freq };

      if (existing) {
        existing.postings.push(newPosting);
        existing.documentFrequency = existing.postings.length;
        invertedIndexStore.put(existing);
      } else {
        const newEntry: InvertedIndexEntry = {
          token,
          postings: [newPosting],
          documentFrequency: 1,
        };
        invertedIndexStore.put(newEntry);
      }
    }

    // Update stats
    statsStore.put(newStats, STATS_KEY);

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => {
        this.invalidateStatsCache();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    });
  }

  /**
   * Removes a document from the index
   */
  async removeDocument(docId: string): Promise<void> {
    // Phase 1: Read all data we need
    const existingDoc = await this.getDocumentTokenInfo(docId);
    if (!existingDoc) {
      return;
    }

    const stats = await this.getStats();

    // Fetch all inverted index entries for this document's tokens
    const uniqueTokens = new Set(existingDoc.tokens);
    const invertedEntries = new Map<string, InvertedIndexEntry | undefined>();
    for (const token of uniqueTokens) {
      const entry = await this.getInvertedIndexEntry(token);
      invertedEntries.set(token, entry);
    }

    // Compute new stats
    const newTotalDocs = Math.max(0, stats.totalDocuments - 1);
    const newAvgDocLength =
      newTotalDocs === 0
        ? 0
        : (stats.averageDocLength * stats.totalDocuments - existingDoc.length) /
          newTotalDocs;
    const newStats: BM25Stats = {
      totalDocuments: newTotalDocs,
      averageDocLength: newAvgDocLength,
      version: stats.version + 1,
    };

    // Phase 2: Write transaction - all synchronous
    const transaction = this.db.transaction(
      [INVERTED_INDEX_STORE, DOC_TOKENS_STORE, STATS_STORE],
      'readwrite'
    );

    const docTokensStore = transaction.objectStore(DOC_TOKENS_STORE);
    const invertedIndexStore = transaction.objectStore(INVERTED_INDEX_STORE);
    const statsStore = transaction.objectStore(STATS_STORE);

    // Remove from inverted index
    for (const token of uniqueTokens) {
      const entry = invertedEntries.get(token);
      if (entry) {
        entry.postings = entry.postings.filter(p => p.docId !== docId);
        if (entry.postings.length === 0) {
          invertedIndexStore.delete(token);
        } else {
          entry.documentFrequency = entry.postings.length;
          invertedIndexStore.put(entry);
        }
      }
    }

    // Remove document tokens
    docTokensStore.delete(docId);

    // Update stats
    statsStore.put(newStats, STATS_KEY);

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => {
        this.invalidateStatsCache();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    });
  }

  /**
   * Removes all chunks for a given file path
   * DocId format: filePath#chunkIndex
   */
  async removeDocumentsByFilePath(filePath: string): Promise<void> {
    // Phase 1: Read all data we need
    const allDocs = await this.getAllDocumentTokenInfos();
    const docsToRemove = allDocs.filter(doc =>
      doc.docId.startsWith(filePath + '#')
    );

    if (docsToRemove.length === 0) {
      return;
    }

    const stats = await this.getStats();

    // Collect all tokens from documents to remove
    const allTokens = new Set<string>();
    for (const doc of docsToRemove) {
      doc.tokens.forEach(t => allTokens.add(t));
    }

    // Fetch all inverted index entries
    const invertedEntries = new Map<string, InvertedIndexEntry | undefined>();
    for (const token of allTokens) {
      const entry = await this.getInvertedIndexEntry(token);
      invertedEntries.set(token, entry);
    }

    // Compute new stats
    const totalLengthRemoved = docsToRemove.reduce(
      (sum, doc) => sum + doc.length,
      0
    );
    const newTotalDocs = Math.max(
      0,
      stats.totalDocuments - docsToRemove.length
    );
    const newAvgDocLength =
      newTotalDocs === 0
        ? 0
        : (stats.averageDocLength * stats.totalDocuments - totalLengthRemoved) /
          newTotalDocs;
    const newStats: BM25Stats = {
      totalDocuments: newTotalDocs,
      averageDocLength: newAvgDocLength,
      version: stats.version + 1,
    };

    // Phase 2: Write transaction - all synchronous
    const transaction = this.db.transaction(
      [INVERTED_INDEX_STORE, DOC_TOKENS_STORE, STATS_STORE],
      'readwrite'
    );

    const docTokensStore = transaction.objectStore(DOC_TOKENS_STORE);
    const invertedIndexStore = transaction.objectStore(INVERTED_INDEX_STORE);
    const statsStore = transaction.objectStore(STATS_STORE);

    // Process each document to remove
    for (const doc of docsToRemove) {
      const uniqueTokens = new Set(doc.tokens);
      for (const token of uniqueTokens) {
        const entry = invertedEntries.get(token);
        if (entry) {
          entry.postings = entry.postings.filter(p => p.docId !== doc.docId);
          if (entry.postings.length === 0) {
            invertedIndexStore.delete(token);
          } else {
            entry.documentFrequency = entry.postings.length;
            invertedIndexStore.put(entry);
          }
        }
      }
      docTokensStore.delete(doc.docId);
    }

    // Update stats
    statsStore.put(newStats, STATS_KEY);

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => {
        this.invalidateStatsCache();
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
    const queryTokens = this.tokenizer.tokenize(query);
    const stats = await this.getStats();

    if (stats.totalDocuments === 0) {
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
          stats.totalDocuments
        );

        return { token, idf, postings: entry.postings };
      })
    );

    // Aggregate scores by document
    const docScores = new Map<string, number>();

    for (const data of tokenData) {
      if (!data) continue;

      for (const posting of data.postings) {
        const docLength = await this.getDocumentLength(posting.docId);
        const score = this.calculateBM25Score(
          data.idf,
          posting.frequency,
          docLength,
          stats.averageDocLength
        );

        docScores.set(
          posting.docId,
          (docScores.get(posting.docId) || 0) + score
        );
      }
    }

    // Sort by score and return top K
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
    // BM25 IDF formula
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
        .transaction([INVERTED_INDEX_STORE], 'readonly')
        .objectStore(INVERTED_INDEX_STORE);

    return new Promise((resolve, reject) => {
      const req = indexStore.get(token);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async getDocumentTokenInfo(
    docId: string
  ): Promise<DocumentTokenInfo | undefined> {
    const transaction = this.db.transaction([DOC_TOKENS_STORE], 'readonly');
    const store = transaction.objectStore(DOC_TOKENS_STORE);

    return new Promise((resolve, reject) => {
      const req = store.get(docId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async getAllDocumentTokenInfos(): Promise<DocumentTokenInfo[]> {
    const transaction = this.db.transaction([DOC_TOKENS_STORE], 'readonly');
    const store = transaction.objectStore(DOC_TOKENS_STORE);

    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async getDocumentLength(docId: string): Promise<number> {
    const doc = await this.getDocumentTokenInfo(docId);
    return doc?.length || 0;
  }

  private async getStats(): Promise<BM25Stats> {
    if (this.statsCache) {
      return this.statsCache;
    }

    const transaction = this.db.transaction([STATS_STORE], 'readonly');
    const store = transaction.objectStore(STATS_STORE);

    return new Promise((resolve, reject) => {
      const req = store.get(STATS_KEY);
      req.onsuccess = () => {
        const stats =
          req.result ||
          ({ totalDocuments: 0, averageDocLength: 0, version: 0 } as BM25Stats);
        this.statsCache = stats;
        resolve(stats);
      };
      req.onerror = () => reject(req.error);
    });
  }

  private invalidateStatsCache(): void {
    this.statsCache = null;
  }

  async clearAll(): Promise<void> {
    const transaction = this.db.transaction(
      [INVERTED_INDEX_STORE, DOC_TOKENS_STORE, STATS_STORE],
      'readwrite'
    );

    transaction.objectStore(INVERTED_INDEX_STORE).clear();
    transaction.objectStore(DOC_TOKENS_STORE).clear();
    transaction.objectStore(STATS_STORE).clear();

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => {
        this.invalidateStatsCache();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
