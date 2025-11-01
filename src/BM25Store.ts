import type { Logger } from './Logger';
import type { Tokenizer } from './Tokenizer';

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
 * In-memory index metadata for fast BM25 scoring
 * Derived from doc-tokens store, refreshed on demand
 */
interface IndexMetadata {
  totalDocuments: number;
  averageDocLength: number;
  docLengths: Map<string, number>;
}

const DB_NAME = 'sonar-bm25-index';
const DB_VERSION = 1;
const INVERTED_INDEX_STORE = 'inverted-index';
const DOC_TOKENS_STORE = 'doc-tokens';

// BM25 parameters
const K1 = 1.2;
const B = 0.75;

export class BM25Store {
  private db!: IDBDatabase;
  private logger: Logger;
  private tokenizer: Tokenizer;
  private metadataCache: IndexMetadata | null = null;

  private constructor(db: IDBDatabase, logger: Logger, tokenizer: Tokenizer) {
    this.db = db;
    this.logger = logger;
    this.tokenizer = tokenizer;
  }

  static async initialize(
    logger: Logger,
    tokenizer: Tokenizer
  ): Promise<BM25Store> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        reject(new Error('Failed to open BM25 IndexedDB'));
      };

      request.onsuccess = () => {
        resolve(request.result);
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

        logger.log('BM25 store schema created');
      };
    });

    const store = new BM25Store(db, logger, tokenizer);

    // Build initial in-memory index metadata
    await store.refreshMetaDataCache();

    logger.log('BM25 store initialized');

    return store;
  }

  /**
   * Refreshes index metadata from doc-tokens store
   * Called on initialization and after cache invalidation
   */
  private async refreshMetaDataCache(): Promise<void> {
    const allDocs = await this.getAllDocumentTokenInfos();

    const docLengths = new Map<string, number>();
    let totalLength = 0;

    for (const doc of allDocs) {
      docLengths.set(doc.docId, doc.length);
      totalLength += doc.length;
    }

    this.metadataCache = {
      totalDocuments: allDocs.length,
      averageDocLength: allDocs.length > 0 ? totalLength / allDocs.length : 0,
      docLengths,
    };

    this.logger.log(
      `BM25Store: Index metadata refreshed (${allDocs.length} documents)`
    );
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
   * Indexes a document for BM25 search
   */
  async indexDocument(docId: string, content: string): Promise<void> {
    const tokens = await this.tokenize(content);
    const termFreq = this.calculateTermFrequency(tokens);

    const docTokenInfo: DocumentTokenInfo = {
      docId,
      tokens,
      length: tokens.length,
    };

    // Phase 1: Read all data we need
    const existingDoc = await this.getDocumentTokenInfo(docId);

    // Collect all tokens we need to fetch
    const tokensToFetch = new Set([...termFreq.keys()]);
    if (existingDoc) {
      existingDoc.tokens.forEach(t => tokensToFetch.add(t));
    }

    // Fetch all inverted index entries using bulk read
    const invertedEntries =
      await this.bulkGetInvertedIndexEntries(tokensToFetch);

    // Phase 2: Write transaction - all synchronous
    const transaction = this.db.transaction(
      [INVERTED_INDEX_STORE, DOC_TOKENS_STORE],
      'readwrite'
    );

    const docTokensStore = transaction.objectStore(DOC_TOKENS_STORE);
    const invertedIndexStore = transaction.objectStore(INVERTED_INDEX_STORE);

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

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => {
        this.clearMetaDataCache();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    });
  }

  /**
   * Indexes multiple documents in a single transaction (much faster than individual indexing)
   */
  async indexDocumentBatch(
    documents: Array<{ docId: string; content: string }>
  ): Promise<void> {
    if (documents.length === 0) return;

    this.logger.log(`BM25Store: Batch indexing ${documents.length} documents`);

    // Phase 1: Tokenize all documents
    const docsTokenInfo: DocumentTokenInfo[] = [];
    const allTokensToFetch = new Set<string>();

    for (const doc of documents) {
      const tokens = await this.tokenize(doc.content);
      const termFreq = this.calculateTermFrequency(tokens);

      docsTokenInfo.push({
        docId: doc.docId,
        tokens,
        length: tokens.length,
      });

      // Collect all unique tokens
      for (const token of termFreq.keys()) {
        allTokensToFetch.add(token);
      }
    }

    // Phase 2: Read all existing data
    const existingDocs = await Promise.all(
      documents.map(doc => this.getDocumentTokenInfo(doc.docId))
    );

    // Collect tokens from existing docs
    for (const existingDoc of existingDocs) {
      if (existingDoc) {
        existingDoc.tokens.forEach(t => allTokensToFetch.add(t));
      }
    }

    const invertedEntries =
      await this.bulkGetInvertedIndexEntries(allTokensToFetch);

    // Phase 3: Write transaction - all synchronous
    const transaction = this.db.transaction(
      [INVERTED_INDEX_STORE, DOC_TOKENS_STORE],
      'readwrite'
    );

    const docTokensStore = transaction.objectStore(DOC_TOKENS_STORE);
    const invertedIndexStore = transaction.objectStore(INVERTED_INDEX_STORE);

    // Process each document
    for (let i = 0; i < documents.length; i++) {
      const docInfo = docsTokenInfo[i];
      const existingDoc = existingDocs[i];
      const termFreq = this.calculateTermFrequency(docInfo.tokens);

      // Remove old document if exists
      if (existingDoc) {
        const uniqueTokens = new Set(existingDoc.tokens);
        for (const token of uniqueTokens) {
          const entry = invertedEntries.get(token);
          if (entry) {
            entry.postings = entry.postings.filter(
              p => p.docId !== docInfo.docId
            );
            if (entry.postings.length === 0) {
              invertedIndexStore.delete(token);
            } else {
              entry.documentFrequency = entry.postings.length;
              invertedIndexStore.put(entry);
            }
          }
        }
      }

      // Add new document
      docTokensStore.put(docInfo);

      // Update inverted index
      for (const [token, freq] of termFreq.entries()) {
        const existing = invertedEntries.get(token);
        const newPosting: PostingEntry = {
          docId: docInfo.docId,
          frequency: freq,
        };

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
          invertedEntries.set(token, newEntry);
        }
      }
    }

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => {
        this.clearMetaDataCache();
        this.logger.log(`BM25Store: Batch indexing complete`);
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

    // Fetch all inverted index entries for this document's tokens using bulk read
    const uniqueTokens = new Set(existingDoc.tokens);
    const invertedEntries =
      await this.bulkGetInvertedIndexEntries(uniqueTokens);

    // Phase 2: Write transaction - all synchronous
    const transaction = this.db.transaction(
      [INVERTED_INDEX_STORE, DOC_TOKENS_STORE],
      'readwrite'
    );

    const docTokensStore = transaction.objectStore(DOC_TOKENS_STORE);
    const invertedIndexStore = transaction.objectStore(INVERTED_INDEX_STORE);

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

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => {
        this.clearMetaDataCache();
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
    return this.removeDocumentsByFilePathBatch([filePath]);
  }

  /**
   * Removes all chunks for multiple file paths in a single pass
   * This is much more efficient than calling removeDocumentsByFilePath
   * repeatedly, as it only reads getAllDocumentTokenInfos once
   */
  async removeDocumentsByFilePathBatch(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) {
      return;
    }

    this.logger.log(
      `BM25Store: Batch removing ${filePaths.length} files from index`
    );

    // Phase 1: Read all data we need
    const allDocs = await this.getAllDocumentTokenInfos();
    this.logger.log(
      `BM25Store: Read ${allDocs.length} total documents from index`
    );

    const filePathSet = new Set(filePaths);
    const docsToRemove = allDocs.filter(doc => {
      // Extract filePath from docId (format: filePath#chunkIndex)
      const hashIndex = doc.docId.lastIndexOf('#');
      if (hashIndex === -1) return false;
      const docFilePath = doc.docId.substring(0, hashIndex);
      return filePathSet.has(docFilePath);
    });

    if (docsToRemove.length === 0) {
      this.logger.log('BM25Store: No documents to remove');
      return;
    }

    this.logger.log(
      `BM25Store: Found ${docsToRemove.length} documents to remove`
    );

    // Collect all tokens from documents to remove
    const allTokens = new Set<string>();
    for (const doc of docsToRemove) {
      doc.tokens.forEach(t => allTokens.add(t));
    }

    // Fetch all inverted index entries using bulk read
    const invertedEntries = await this.bulkGetInvertedIndexEntries(allTokens);

    // Phase 2: Write transaction - all synchronous
    const transaction = this.db.transaction(
      [INVERTED_INDEX_STORE, DOC_TOKENS_STORE],
      'readwrite'
    );

    const docTokensStore = transaction.objectStore(DOC_TOKENS_STORE);
    const invertedIndexStore = transaction.objectStore(INVERTED_INDEX_STORE);

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

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => {
        this.clearMetaDataCache();
        this.logger.log(
          `BM25Store: Batch removal complete. Removed ${docsToRemove.length} documents`
        );
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

  /**
   * Bulk fetch inverted index entries using parallel get operations
   */
  private async bulkGetInvertedIndexEntries(
    tokens: Set<string>
  ): Promise<Map<string, InvertedIndexEntry | undefined>> {
    if (tokens.size === 0) {
      return new Map();
    }

    const transaction = this.db.transaction([INVERTED_INDEX_STORE], 'readonly');
    const store = transaction.objectStore(INVERTED_INDEX_STORE);

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

  async clearAll(): Promise<void> {
    this.logger.log('BM25Store: Clearing all data...');

    const transaction = this.db.transaction(
      [INVERTED_INDEX_STORE, DOC_TOKENS_STORE],
      'readwrite'
    );

    transaction.objectStore(INVERTED_INDEX_STORE).clear();
    transaction.objectStore(DOC_TOKENS_STORE).clear();

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => {
        this.clearMetaDataCache();
        this.logger.log('BM25Store: All data cleared');
        resolve();
      };
      transaction.onerror = () => {
        this.logger.error(
          `BM25Store: Failed to clear data: ${transaction.error}`
        );
        reject(transaction.error);
      };
    });
  }

  async close(): Promise<void> {
    this.db.close();
  }

  /**
   * Tokenizes text for BM25 indexing and search
   * Uses transformers.js tokenizer (e.g., BGE-M3)
   * Processes line by line to avoid hanging on large files
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

    // Split by lines and tokenize line by line to avoid hanging on large files
    const lines = normalizedText.split('\n');
    const allTokens: string[] = [];

    for (const line of lines) {
      // Get token IDs using Tokenizer API (special tokens already filtered)
      const tokenIds = await this.tokenizer.getTokenIds(line);

      // Convert to strings for BM25 matching
      for (const tokenId of tokenIds) {
        allTokens.push(String(tokenId));
      }
    }

    return allTokens;
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
