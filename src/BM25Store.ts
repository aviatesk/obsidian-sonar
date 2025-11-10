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

    this.log(`Index metadata refreshed (${allDocs.length} documents)`);
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
   * Indexes multiple documents in a single transaction (much faster than individual indexing)
   */
  async indexDocumentBatch(
    documents: Array<{ docId: string; content: string }>
  ): Promise<void> {
    if (documents.length === 0) return;

    this.log(`Indexing ${documents.length} documents...`);

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

      for (const token of termFreq.keys()) {
        allTokensToFetch.add(token);
      }
    }

    // Phase 2: Read existing data and build inverted index
    const existingDocs = await Promise.all(
      documents.map(doc => this.getDocumentTokenInfo(doc.docId))
    );

    for (const existingDoc of existingDocs) {
      if (existingDoc) {
        existingDoc.tokens.forEach(t => allTokensToFetch.add(t));
      }
    }

    const invertedEntries =
      await this.bulkGetInvertedIndexEntries(allTokensToFetch);

    // Phase 3: Build final inverted index in memory
    const modifiedTokens = new Set<string>();

    for (let i = 0; i < documents.length; i++) {
      const docInfo = docsTokenInfo[i];
      const existingDoc = existingDocs[i];
      const termFreq = this.calculateTermFrequency(docInfo.tokens);

      if (existingDoc) {
        const uniqueTokens = new Set(existingDoc.tokens);
        for (const token of uniqueTokens) {
          const entry = invertedEntries.get(token);
          if (entry) {
            entry.postings = entry.postings.filter(
              p => p.docId !== docInfo.docId
            );
            entry.documentFrequency = entry.postings.length;
            modifiedTokens.add(token);
          }
        }
      }

      for (const [token, freq] of termFreq.entries()) {
        const existing = invertedEntries.get(token);
        const newPosting: PostingEntry = {
          docId: docInfo.docId,
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

    // Write document token info
    for (const docInfo of docsTokenInfo) {
      docTokensStore.put(docInfo);
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
        this.log(`Indexed ${documents.length} documents`);
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    });
  }

  /**
   * Deletes documents by their IDs
   * IDs come from MetadataStore as the source of truth
   */
  async deleteDocuments(docIds: string[]): Promise<void> {
    if (docIds.length === 0) {
      return;
    }

    this.log(`Deleting ${docIds.length} documents...`);

    // Phase 1: Read all data we need
    const docsToRemove = await Promise.all(
      docIds.map(id => this.getDocumentTokenInfo(id))
    );
    const validDocs = docsToRemove.filter(
      (doc): doc is DocumentTokenInfo => doc !== undefined
    );

    if (validDocs.length === 0) {
      this.warn('No documents found to remove');
      return;
    }

    this.log(`Found ${validDocs.length} documents to remove`);

    // Collect all tokens from documents to remove
    const allTokens = new Set<string>();
    for (const doc of validDocs) {
      doc.tokens.forEach(t => allTokens.add(t));
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

    // Process each document to remove
    for (const doc of validDocs) {
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
        this.log(`Deleted ${validDocs.length} documents`);
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

  private async getDocumentTokenInfo(
    docId: string
  ): Promise<DocumentTokenInfo | undefined> {
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

  private async getAllDocumentTokenInfos(): Promise<DocumentTokenInfo[]> {
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
      // Get token IDs using Embedder API (special tokens already filtered)
      const tokenIds = await this.embedder.getTokenIds(line);

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
