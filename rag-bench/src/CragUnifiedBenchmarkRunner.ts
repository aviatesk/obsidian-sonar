/**
 * CRAG Unified Benchmark Runner for end-to-end RAG evaluation.
 *
 * Key differences from CRAG (per-question) benchmark:
 * - Unified corpus indexed once (not per-question)
 * - Compares Sonar (local) vs Cloud (OpenAI) configurations
 * - Uses same evaluation method (LLM-as-judge) as CRAG benchmark
 */

import { Notice, requestUrl, type RequestUrlResponse } from 'obsidian';
import { createReadStream, promises as fs } from 'fs';
import { join, isAbsolute } from 'path';
import { createInterface } from 'readline';
import { WithLogging } from '../../src/WithLogging';
import type { ConfigManager } from '../../src/ConfigManager';
import type { LlamaCppEmbedder } from '../../src/LlamaCppEmbedder';
import type { LlamaCppReranker } from '../../src/LlamaCppReranker';
import type { LlamaCppChat, ChatMessageExtended } from '../../src/LlamaCppChat';
import {
  MetadataStore,
  type ChunkMetadata,
  getDBName,
  DB_VERSION,
  STORE_METADATA,
  STORE_EMBEDDINGS,
  STORE_BM25_INVERTED_INDEX,
  STORE_BM25_DOC_TOKENS,
  STORE_FAILED_FILES,
  INDEX_FILE_PATH,
} from '../../src/MetadataStore';
import { EmbeddingStore } from '../../src/EmbeddingStore';
import { BM25Store } from '../../src/BM25Store';
import { EmbeddingSearch } from '../../src/EmbeddingSearch';
import { BM25Search } from '../../src/BM25Search';
import { SearchManager, type ChunkResult } from '../../src/SearchManager';
import { createChunks } from '../../src/chunker';
import { ChunkId } from '../../src/chunkId';
import { CloudRAGClient, type CloudDocument } from './CloudRAGClient';

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const EVALUATION_MODEL = 'gpt-4o-mini';

interface CorpusDoc {
  doc_id: string;
  url: string;
  title: string;
  content: string;
}

interface Query {
  id: string;
  question: string;
  answer: string;
  alt_answers: string[];
  domain: string;
  question_type: string;
}

type EvaluationResult = 'correct' | 'missing' | 'incorrect';

interface BenchmarkResult {
  question_id: string;
  question: string;
  expected: string;
  generated: string;
  evaluation: EvaluationResult;
  domain: string;
  question_type: string;
  retrieval_time_ms: number;
  generation_time_ms: number;
  total_time_ms: number;
}

interface BreakdownStats {
  total: number;
  correct: number;
  missing: number;
  incorrect: number;
  accuracy: number;
  hallucination: number;
  score: number;
}

interface BenchmarkSummary {
  config: string;
  total: number;
  correct: number;
  missing: number;
  incorrect: number;
  accuracy: number;
  hallucination: number;
  score: number;
  indexing_time_sec: number;
  avg_retrieval_time_ms: number;
  avg_generation_time_ms: number;
  total_time_sec: number;
  api_cost_usd?: number;
  by_domain: Record<string, BreakdownStats>;
  by_question_type: Record<string, BreakdownStats>;
}

export interface CragUnifiedBenchmarkConfig {
  corpusPath: string;
  queriesPath: string;
  outputDir: string;
  sampleSize?: number;
  sampleOffset?: number;
  runSonar: boolean;
  runCloud: boolean;
  openaiApiKey?: string;
}

interface Stores {
  dbName: string;
  db: IDBDatabase;
  metadataStore: MetadataStore;
  embeddingStore: EmbeddingStore;
  bm25Store: BM25Store;
  embeddingSearch: EmbeddingSearch;
  bm25Search: BM25Search;
  searchManager: SearchManager;
}

export class CragUnifiedBenchmarkRunner extends WithLogging {
  protected readonly componentName = 'CragUnifiedBenchmarkRunner';

  private stores: Stores | null = null;

  constructor(
    protected configManager: ConfigManager,
    private embedder: LlamaCppEmbedder,
    private reranker: LlamaCppReranker,
    private chatModel: LlamaCppChat,
    private vaultBasePath: string
  ) {
    super();
  }

  async runBenchmark(config: CragUnifiedBenchmarkConfig): Promise<void> {
    this.log('Starting CRAG Unified benchmark');
    new Notice('Starting CRAG Unified benchmark...');

    const startTime = Date.now();

    try {
      const outputDir = this.resolvePath(config.outputDir);
      await fs.mkdir(outputDir, { recursive: true });

      const corpus = await this.loadCorpus(config.corpusPath);
      this.log(`Loaded ${corpus.length} documents`);

      const queries = await this.loadQueries(
        config.queriesPath,
        config.sampleSize,
        config.sampleOffset
      );
      this.log(`Loaded ${queries.length} queries`);

      if (config.runSonar) {
        await this.runSonarEvaluation(corpus, queries, outputDir, config);
      }

      if (config.runCloud && config.openaiApiKey) {
        await this.runCloudEvaluation(
          corpus,
          queries,
          outputDir,
          config.openaiApiKey
        );
      }

      if (config.runSonar && config.runCloud) {
        await this.generateComparison(outputDir);
      }

      const totalTime = (Date.now() - startTime) / 1000;
      this.log(`CRAG Unified benchmark completed in ${totalTime.toFixed(1)}s`);
      new Notice(
        `CRAG Unified benchmark completed in ${totalTime.toFixed(1)}s`
      );
    } catch (error) {
      const errorMsg = `CRAG Unified benchmark failed: ${error}`;
      this.error(errorMsg);
      new Notice(errorMsg);
      throw error;
    }
  }

  private async runSonarEvaluation(
    corpus: CorpusDoc[],
    queries: Query[],
    outputDir: string,
    config: CragUnifiedBenchmarkConfig
  ): Promise<void> {
    this.log('=== Sonar Evaluation ===');
    new Notice('Running Sonar evaluation...');

    const openaiApiKey =
      config.openaiApiKey ?? this.configManager.get('cragOpenaiApiKey');
    if (!openaiApiKey) {
      throw new Error('OpenAI API key required for LLM-as-judge evaluation');
    }

    const dbNamePrefix = 'crag-unified-sonar';
    const existingRecords = await this.checkExistingDatabase(dbNamePrefix);

    let indexingTime = 0;
    if (existingRecords > 0) {
      this.log(
        `Found existing index with ${existingRecords} records, skipping indexing`
      );
      new Notice(`Using existing index (${existingRecords} records)`);
      this.stores = await this.createStores(dbNamePrefix);
    } else {
      const indexingStart = Date.now();
      this.stores = await this.createStores(dbNamePrefix);
      await this.indexCorpusSonar(corpus);
      indexingTime = (Date.now() - indexingStart) / 1000;
      this.log(`Indexed corpus in ${indexingTime.toFixed(1)}s`);
    }

    const resultsPath = join(outputDir, 'results-sonar.jsonl');
    const existingResults = await this.loadExistingResults(resultsPath);
    const processedIds = new Set(existingResults.map(r => r.question_id));

    if (existingResults.length > 0) {
      this.log(
        `Found ${existingResults.length} existing results, skipping processed queries`
      );
    }

    const results: BenchmarkResult[] = [...existingResults];
    const resultsFile = await fs.open(resultsPath, 'a');

    let processedCount = existingResults.length;
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];

      if (processedIds.has(query.id)) {
        continue;
      }

      const result = await this.processQuerySonar(query, openaiApiKey);
      results.push(result);
      await resultsFile.write(JSON.stringify(result) + '\n');
      processedCount++;

      if (processedCount % 10 === 0 || processedCount === queries.length) {
        const stats = this.calculateStats(results);
        this.log(
          `[Sonar] ${processedCount}/${queries.length} ` +
            `Acc=${(stats.accuracy * 100).toFixed(1)}%, ` +
            `Score=${(stats.score * 100).toFixed(1)}%`
        );
      }
    }

    await resultsFile.close();

    const summary = this.calculateSummary('Sonar', results, indexingTime);
    await fs.writeFile(
      join(outputDir, 'summary-sonar.json'),
      JSON.stringify(summary, null, 2)
    );

    this.logSummary(summary);

    // Keep DB for potential reuse - don't delete automatically
    if (this.stores) {
      this.stores.db.close();
      this.stores = null;
    }
  }

  private async runCloudEvaluation(
    corpus: CorpusDoc[],
    queries: Query[],
    outputDir: string,
    apiKey: string
  ): Promise<void> {
    this.log('=== Cloud Evaluation ===');
    new Notice('Running Cloud evaluation...');

    const client = new CloudRAGClient(this.configManager, apiKey);
    client.resetUsage();

    const cloudDocs: CloudDocument[] = corpus.map(d => ({
      docId: d.doc_id,
      title: d.title,
      content: d.content,
    }));

    const indexingStart = Date.now();
    const indexedCorpus = await client.indexCorpus(
      cloudDocs,
      100,
      (indexed, total) => {
        if (indexed % 500 === 0 || indexed === total) {
          this.log(`[Cloud] Indexing: ${indexed}/${total}`);
        }
      }
    );
    const indexingTime = (Date.now() - indexingStart) / 1000;
    this.log(`Indexed corpus in ${indexingTime.toFixed(1)}s`);

    const results: BenchmarkResult[] = [];
    const searchResultsCount = this.configManager.get('searchResultsCount');
    const resultsPath = join(outputDir, 'results-cloud.jsonl');
    const resultsFile = await fs.open(resultsPath, 'w');

    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      const totalStart = Date.now();

      const retrievalStart = Date.now();
      const searchResults = await client.search(
        query.question,
        indexedCorpus,
        searchResultsCount
      );
      const retrievalTime = Date.now() - retrievalStart;

      const generationStart = Date.now();
      const context = client.buildContext(searchResults);
      const generated = await client.generateAnswer(query.question, context);
      const generationTime = Date.now() - generationStart;

      const evaluation = await this.evaluate(
        query.question,
        generated,
        query.answer,
        query.alt_answers,
        apiKey
      );

      const result: BenchmarkResult = {
        question_id: query.id,
        question: query.question,
        expected: query.answer,
        generated,
        evaluation,
        domain: query.domain,
        question_type: query.question_type,
        retrieval_time_ms: retrievalTime,
        generation_time_ms: generationTime,
        total_time_ms: Date.now() - totalStart,
      };

      results.push(result);
      await resultsFile.write(JSON.stringify(result) + '\n');

      if ((i + 1) % 10 === 0 || i === queries.length - 1) {
        const stats = this.calculateStats(results);
        this.log(
          `[Cloud] ${i + 1}/${queries.length} ` +
            `Acc=${(stats.accuracy * 100).toFixed(1)}%, ` +
            `Score=${(stats.score * 100).toFixed(1)}%`
        );
      }
    }

    await resultsFile.close();

    const summary = this.calculateSummary('Cloud', results, indexingTime);
    summary.api_cost_usd = client.getUsage().estimatedCostUsd;

    await fs.writeFile(
      join(outputDir, 'summary-cloud.json'),
      JSON.stringify(summary, null, 2)
    );

    this.logSummary(summary);
  }

  private async generateComparison(outputDir: string): Promise<void> {
    const sonarSummaryPath = join(outputDir, 'summary-sonar.json');
    const cloudSummaryPath = join(outputDir, 'summary-cloud.json');

    let sonarSummary: BenchmarkSummary | null = null;
    let cloudSummary: BenchmarkSummary | null = null;

    try {
      const sonarData = await fs.readFile(sonarSummaryPath, 'utf-8');
      sonarSummary = JSON.parse(sonarData);
    } catch {
      this.warn('Could not read Sonar summary');
    }

    try {
      const cloudData = await fs.readFile(cloudSummaryPath, 'utf-8');
      cloudSummary = JSON.parse(cloudData);
    } catch {
      this.warn('Could not read Cloud summary');
    }

    if (!sonarSummary || !cloudSummary) {
      return;
    }

    const comparison = {
      sonar: sonarSummary,
      cloud: cloudSummary,
      comparison: {
        accuracy_diff: `${((sonarSummary.accuracy - cloudSummary.accuracy) * 100).toFixed(1)}%`,
        score_diff: `${((sonarSummary.score - cloudSummary.score) * 100).toFixed(1)}%`,
        hallucination_diff: `${((sonarSummary.hallucination - cloudSummary.hallucination) * 100).toFixed(1)}%`,
      },
    };

    await fs.writeFile(
      join(outputDir, 'comparison.json'),
      JSON.stringify(comparison, null, 2)
    );

    this.log('='.repeat(60));
    this.log('COMPARISON: Sonar vs Cloud');
    this.log('='.repeat(60));
    this.log(
      `Accuracy: Sonar ${(sonarSummary.accuracy * 100).toFixed(1)}% vs ` +
        `Cloud ${(cloudSummary.accuracy * 100).toFixed(1)}% ` +
        `(${comparison.comparison.accuracy_diff})`
    );
    this.log(
      `Score: Sonar ${(sonarSummary.score * 100).toFixed(1)}% vs ` +
        `Cloud ${(cloudSummary.score * 100).toFixed(1)}% ` +
        `(${comparison.comparison.score_diff})`
    );
    this.log(
      `Hallucination: Sonar ${(sonarSummary.hallucination * 100).toFixed(1)}% vs ` +
        `Cloud ${(cloudSummary.hallucination * 100).toFixed(1)}% ` +
        `(${comparison.comparison.hallucination_diff})`
    );
    this.log('='.repeat(60));
  }

  private async processQuerySonar(
    query: Query,
    openaiApiKey: string
  ): Promise<BenchmarkResult> {
    const totalStart = Date.now();

    const retrievalStart = Date.now();
    const searchResultsCount = this.configManager.get('searchResultsCount');
    const chunks = await this.stores!.searchManager.getRerankedChunksForRAG(
      query.question,
      searchResultsCount
    );
    const retrievalTime = Date.now() - retrievalStart;

    const generationStart = Date.now();
    let context = this.buildContext(chunks || []);
    const contextTokenBudget = this.configManager.get('contextTokenBudget');
    context = this.truncateToTokenBudget(context, contextTokenBudget);

    const generated = await this.generateAnswer(query.question, context);
    const generationTime = Date.now() - generationStart;

    const evaluation = await this.evaluate(
      query.question,
      generated,
      query.answer,
      query.alt_answers,
      openaiApiKey
    );

    return {
      question_id: query.id,
      question: query.question,
      expected: query.answer,
      generated,
      evaluation,
      domain: query.domain,
      question_type: query.question_type,
      retrieval_time_ms: retrievalTime,
      generation_time_ms: generationTime,
      total_time_ms: Date.now() - totalStart,
    };
  }

  private async indexCorpusSonar(corpus: CorpusDoc[]): Promise<void> {
    const maxChunkSize = this.configManager.get('maxChunkSize');
    const chunkOverlap = this.configManager.get('chunkOverlap');
    const batchSize = this.configManager.get('indexingBatchSize');

    const allMetadata: ChunkMetadata[] = [];
    const allBm25Chunks: { docId: string; content: string }[] = [];
    const now = Date.now();

    this.log(`Chunking ${corpus.length} documents...`);

    for (const doc of corpus) {
      const filePath = `${doc.doc_id}.md`;

      const chunks = await createChunks(
        doc.content,
        maxChunkSize,
        chunkOverlap,
        this.embedder
      );

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const chunkId = ChunkId.forContent(filePath, i);

        allMetadata.push({
          id: chunkId,
          filePath,
          title: doc.title,
          content: chunk.content,
          headings: chunk.headings,
          mtime: now,
          size: doc.content.length,
          indexedAt: now,
        });

        allBm25Chunks.push({ docId: chunkId, content: chunk.content });
      }

      const titleId = ChunkId.forTitle(filePath);
      allMetadata.push({
        id: titleId,
        filePath,
        title: doc.title,
        content: doc.title,
        headings: [],
        mtime: now,
        size: doc.content.length,
        indexedAt: now,
      });
      allBm25Chunks.push({ docId: titleId, content: doc.title });
    }

    this.log(`Generating embeddings for ${allMetadata.length} chunks...`);
    const allEmbeddings: { id: string; embedding: number[] }[] = [];

    for (let i = 0; i < allMetadata.length; i += batchSize) {
      const batch = allMetadata.slice(i, i + batchSize);
      const texts = batch.map(m => m.content);
      const embeddings = await this.embedder.getEmbeddings(texts);

      for (let j = 0; j < batch.length; j++) {
        allEmbeddings.push({ id: batch[j].id, embedding: embeddings[j] });
      }

      if ((i + batchSize) % (batchSize * 10) === 0) {
        this.log(
          `Embedding progress: ${Math.min(i + batchSize, allMetadata.length)}/${allMetadata.length}`
        );
      }
    }

    this.log('Storing index data...');
    await this.stores!.metadataStore.addChunks(allMetadata);
    await this.stores!.embeddingStore.addEmbeddings(allEmbeddings);
    await this.stores!.bm25Store.indexChunkBatch(allBm25Chunks);

    this.log(
      `Indexed ${allMetadata.length} chunks from ${corpus.length} documents`
    );
  }

  private resolvePath(path: string): string {
    if (isAbsolute(path)) {
      return path;
    }
    return join(this.vaultBasePath, path);
  }

  private async loadCorpus(corpusPath: string): Promise<CorpusDoc[]> {
    const resolvedPath = this.resolvePath(corpusPath);
    const corpus: CorpusDoc[] = [];

    const rl = createInterface({
      input: createReadStream(resolvedPath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (line.trim()) {
        corpus.push(JSON.parse(line) as CorpusDoc);
      }
    }

    return corpus;
  }

  private async loadQueries(
    queriesPath: string,
    sampleSize?: number,
    sampleOffset?: number
  ): Promise<Query[]> {
    const resolvedPath = this.resolvePath(queriesPath);
    const offset = sampleOffset ?? 0;
    const queries: Query[] = [];
    let lineCount = 0;

    const rl = createInterface({
      input: createReadStream(resolvedPath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (line.trim()) {
        lineCount++;
        if (lineCount <= offset) {
          continue;
        }

        queries.push(JSON.parse(line) as Query);

        if (sampleSize && queries.length >= sampleSize) {
          rl.close();
          break;
        }
      }
    }

    return queries;
  }

  private async loadExistingResults(
    resultsPath: string
  ): Promise<BenchmarkResult[]> {
    const results: BenchmarkResult[] = [];

    try {
      await fs.access(resultsPath);
    } catch {
      return results;
    }

    const rl = createInterface({
      input: createReadStream(resultsPath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (line.trim()) {
        try {
          results.push(JSON.parse(line) as BenchmarkResult);
        } catch {
          this.warn(`Failed to parse result line: ${line.slice(0, 100)}`);
        }
      }
    }

    return results;
  }

  private async createStores(dbNamePrefix: string): Promise<Stores> {
    const dbName = getDBName(dbNamePrefix, 'benchmark');
    const db = await this.openTempDatabase(dbName);

    const metadataStore = await this.createMetadataStore(db);
    const embeddingStore = new EmbeddingStore(db, this.configManager);
    const bm25Store = await BM25Store.initialize(db, this.configManager);

    const embeddingSearch = new EmbeddingSearch(
      metadataStore,
      embeddingStore,
      this.embedder,
      this.configManager
    );
    const bm25Search = new BM25Search(
      bm25Store,
      metadataStore,
      this.configManager
    );
    const searchManager = new SearchManager(
      embeddingSearch,
      bm25Search,
      this.reranker,
      this.configManager
    );

    return {
      dbName,
      db,
      metadataStore,
      embeddingStore,
      bm25Store,
      embeddingSearch,
      bm25Search,
      searchManager,
    };
  }

  private async checkExistingDatabase(dbNamePrefix: string): Promise<number> {
    const dbName = getDBName(dbNamePrefix, 'benchmark');

    return new Promise(resolve => {
      const request = window.indexedDB.open(dbName, DB_VERSION);

      request.onerror = () => resolve(0);

      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_METADATA)) {
          db.close();
          resolve(0);
          return;
        }

        const tx = db.transaction(STORE_METADATA, 'readonly');
        const store = tx.objectStore(STORE_METADATA);
        const countReq = store.count();

        countReq.onsuccess = () => {
          const count = countReq.result;
          db.close();
          resolve(count);
        };

        countReq.onerror = () => {
          db.close();
          resolve(0);
        };
      };

      request.onupgradeneeded = () => {
        // DB doesn't exist or is empty - will be created fresh
        resolve(0);
      };
    });
  }

  private async openTempDatabase(dbName: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(dbName, DB_VERSION);

      request.onerror = () => {
        reject(new Error(`Failed to open temp IndexedDB: ${dbName}`));
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains(STORE_METADATA)) {
          const store = db.createObjectStore(STORE_METADATA, { keyPath: 'id' });
          store.createIndex(INDEX_FILE_PATH, 'filePath', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_EMBEDDINGS)) {
          db.createObjectStore(STORE_EMBEDDINGS, { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains(STORE_BM25_INVERTED_INDEX)) {
          db.createObjectStore(STORE_BM25_INVERTED_INDEX, { keyPath: 'token' });
        }

        if (!db.objectStoreNames.contains(STORE_BM25_DOC_TOKENS)) {
          db.createObjectStore(STORE_BM25_DOC_TOKENS, { keyPath: 'docId' });
        }

        if (!db.objectStoreNames.contains(STORE_FAILED_FILES)) {
          db.createObjectStore(STORE_FAILED_FILES, { keyPath: 'filePath' });
        }
      };
    });
  }

  private async createMetadataStore(db: IDBDatabase): Promise<MetadataStore> {
    const dummyStore = await MetadataStore.initialize(
      'crag-unified-temp',
      'benchmark',
      this.configManager
    );
    (dummyStore as any).db.close();
    (dummyStore as any).db = db;
    return dummyStore;
  }

  private buildContext(chunks: ChunkResult[]): string {
    if (chunks.length === 0) {
      return 'No relevant information found.';
    }

    const results: string[] = [];

    for (const chunk of chunks) {
      const notePath = chunk.filePath.replace(/\.md$/, '');
      const heading =
        chunk.metadata.headings.length > 0
          ? chunk.metadata.headings[chunk.metadata.headings.length - 1]
          : null;

      const wikilink = heading
        ? `[[${notePath}#${heading.replace(/^#+\s*/, '')}]]`
        : `[[${notePath}]]`;

      results.push(`${wikilink}\n${chunk.content}`);
    }

    return (
      '[Vault Search Results]\n' +
      '(Reference notes using wikilinks: [[Note name]])\n\n' +
      results.join('\n\n')
    );
  }

  private truncateToTokenBudget(content: string, maxTokens: number): string {
    if (maxTokens <= 0) {
      return '[Content too large for context window]';
    }

    const estimatedMaxChars = maxTokens * 4;

    if (content.length <= estimatedMaxChars) {
      return content;
    }

    const truncationNotice = '\n\n[truncated due to context limit]';
    const availableChars = estimatedMaxChars - truncationNotice.length;

    if (availableChars <= 0) {
      return '[Content too large for context window]';
    }

    const truncated = content.slice(0, availableChars);
    const lastNewline = truncated.lastIndexOf('\n');

    if (lastNewline > availableChars * 0.8) {
      return truncated.slice(0, lastNewline) + truncationNotice;
    }

    return truncated + truncationNotice;
  }

  private async generateAnswer(
    question: string,
    context: string
  ): Promise<string> {
    const systemPrompt = `You are a helpful assistant that answers questions based on the provided context.
Answer the question directly and concisely. If the context doesn't contain enough information to answer the question, say "I don't know".
Do not make up information that is not in the context.`;

    const userPrompt = `Context:
${context}

Question: ${question}

Answer:`;

    const messages: ChatMessageExtended[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    let response = '';
    const result = await this.chatModel.chatStream(
      messages,
      [],
      { maxTokens: 256, enableThinking: false },
      delta => {
        if (delta.content) {
          response += delta.content;
        }
      }
    );

    if (!response && result.content) {
      response = result.content;
    }

    return response.trim();
  }

  // Evaluation methods (same as CRAG benchmark)

  private async evaluate(
    question: string,
    generated: string,
    expected: string,
    altAnswers: string[],
    openaiApiKey: string
  ): Promise<EvaluationResult> {
    const ruleBasedResult = this.evaluateRuleBased(
      generated,
      expected,
      altAnswers
    );
    if (ruleBasedResult !== null) {
      return ruleBasedResult;
    }

    return this.evaluateWithLLM(question, generated, expected, openaiApiKey);
  }

  private evaluateRuleBased(
    generated: string,
    expected: string,
    altAnswers: string[]
  ): EvaluationResult | null {
    const genLower = generated.toLowerCase().trim();

    const missingPatterns = [
      "i don't know",
      'i do not know',
      'cannot answer',
      'unable to answer',
      'no information',
      'not enough information',
      "context doesn't contain",
      'context does not contain',
    ];

    for (const pattern of missingPatterns) {
      if (genLower.includes(pattern)) {
        return 'missing';
      }
    }

    if (typeof expected === 'string') {
      const expectedLower = expected.toLowerCase().trim();
      if (genLower === expectedLower) {
        return 'correct';
      }
    }

    for (const alt of altAnswers) {
      if (typeof alt !== 'string') continue;
      const altLower = alt.toLowerCase().trim();
      if (altLower && genLower === altLower) {
        return 'correct';
      }
    }

    return null;
  }

  private async evaluateWithLLM(
    question: string,
    generated: string,
    expected: string,
    openaiApiKey: string
  ): Promise<'correct' | 'incorrect'> {
    const expectedStr =
      typeof expected === 'string' ? expected : JSON.stringify(expected);
    const prompt =
      `Question: ${question}\n` +
      `Ground truth: ${expectedStr}\n` +
      `Prediction: ${generated}\n\n` +
      `Does the prediction match the ground truth? ` +
      `Respond with JSON: {"score": 1} if correct, {"score": 0} if incorrect.`;

    const requestBody = {
      model: EVALUATION_MODEL,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 20,
      response_format: { type: 'json_object' },
    };

    let response: RequestUrlResponse;
    try {
      response = await requestUrl({
        url: OPENAI_API_URL,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openaiApiKey}`,
        },
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      this.warn(`OpenAI API request failed: ${error}`);
      return 'incorrect';
    }

    if (response.status !== 200) {
      this.warn(
        `OpenAI API returned status ${response.status}: ${response.text}`
      );
      return 'incorrect';
    }

    const result = response.json;
    const content = result.choices?.[0]?.message?.content?.trim();

    try {
      const parsed = JSON.parse(content);
      return parsed.score === 1 ? 'correct' : 'incorrect';
    } catch {
      this.warn(`Failed to parse evaluation response: "${content}"`);
      return 'incorrect';
    }
  }

  private calculateStats(results: BenchmarkResult[]): {
    accuracy: number;
    hallucination: number;
    score: number;
  } {
    const total = results.length;
    if (total === 0) {
      return { accuracy: 0, hallucination: 0, score: 0 };
    }
    const correct = results.filter(r => r.evaluation === 'correct').length;
    const incorrect = results.filter(r => r.evaluation === 'incorrect').length;
    return {
      accuracy: correct / total,
      hallucination: incorrect / total,
      score: (correct - incorrect) / total,
    };
  }

  private calculateSummary(
    config: string,
    results: BenchmarkResult[],
    indexingTimeSec: number
  ): BenchmarkSummary {
    const total = results.length;
    const correct = results.filter(r => r.evaluation === 'correct').length;
    const missing = results.filter(r => r.evaluation === 'missing').length;
    const incorrect = results.filter(r => r.evaluation === 'incorrect').length;

    const avgRetrievalTime =
      total > 0
        ? results.reduce((sum, r) => sum + r.retrieval_time_ms, 0) / total
        : 0;
    const avgGenerationTime =
      total > 0
        ? results.reduce((sum, r) => sum + r.generation_time_ms, 0) / total
        : 0;
    const totalTime =
      results.reduce((sum, r) => sum + r.total_time_ms, 0) / 1000;

    const byDomain = this.calculateBreakdown(results, r => r.domain);
    const byQuestionType = this.calculateBreakdown(
      results,
      r => r.question_type
    );

    return {
      config,
      total,
      correct,
      missing,
      incorrect,
      accuracy: total > 0 ? correct / total : 0,
      hallucination: total > 0 ? incorrect / total : 0,
      score: total > 0 ? (correct - incorrect) / total : 0,
      indexing_time_sec: indexingTimeSec,
      avg_retrieval_time_ms: avgRetrievalTime,
      avg_generation_time_ms: avgGenerationTime,
      total_time_sec: totalTime + indexingTimeSec,
      by_domain: byDomain,
      by_question_type: byQuestionType,
    };
  }

  private calculateBreakdown(
    results: BenchmarkResult[],
    keyFn: (r: BenchmarkResult) => string
  ): Record<string, BreakdownStats> {
    const groups: Record<string, BenchmarkResult[]> = {};

    for (const r of results) {
      const key = keyFn(r) || 'unknown';
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(r);
    }

    const breakdown: Record<string, BreakdownStats> = {};

    for (const [key, group] of Object.entries(groups)) {
      const total = group.length;
      const correct = group.filter(r => r.evaluation === 'correct').length;
      const missing = group.filter(r => r.evaluation === 'missing').length;
      const incorrect = group.filter(r => r.evaluation === 'incorrect').length;

      breakdown[key] = {
        total,
        correct,
        missing,
        incorrect,
        accuracy: total > 0 ? correct / total : 0,
        hallucination: total > 0 ? incorrect / total : 0,
        score: total > 0 ? (correct - incorrect) / total : 0,
      };
    }

    return breakdown;
  }

  private logSummary(summary: BenchmarkSummary): void {
    this.log('='.repeat(60));
    this.log(`${summary.config.toUpperCase()} BENCHMARK RESULTS`);
    this.log('='.repeat(60));
    this.log(`Total queries: ${summary.total}`);
    this.log(`Accuracy: ${(summary.accuracy * 100).toFixed(1)}%`);
    this.log(`Hallucination: ${(summary.hallucination * 100).toFixed(1)}%`);
    this.log(`Score: ${(summary.score * 100).toFixed(1)}%`);
    this.log(`Indexing time: ${summary.indexing_time_sec.toFixed(1)}s`);
    this.log(
      `Avg retrieval time: ${summary.avg_retrieval_time_ms.toFixed(0)}ms`
    );
    this.log(
      `Avg generation time: ${summary.avg_generation_time_ms.toFixed(0)}ms`
    );
    if (summary.api_cost_usd !== undefined) {
      this.log(`API cost: $${summary.api_cost_usd.toFixed(4)}`);
    }
    this.log('='.repeat(60));
  }
}
