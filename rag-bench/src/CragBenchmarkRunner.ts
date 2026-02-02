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

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const EVALUATION_MODEL = 'gpt-4o-mini';

interface CragPage {
  page_id: number;
  title: string;
  content: string;
  url: string;
}

interface CragSample {
  question_id: string;
  question: string;
  answer: string;
  alt_answers: string[];
  domain: string;
  question_type: string;
  pages: CragPage[];
}

type EvaluationResult = 'correct' | 'missing' | 'incorrect';

interface CragResult {
  question_id: string;
  question: string;
  expected: string;
  generated: string;
  evaluation: EvaluationResult;
  indexing_time_ms: number;
  retrieval_time_ms: number;
  generation_time_ms: number;
  total_time_ms: number;
  chunk_count: number;
}

interface CragSummary {
  total: number;
  correct: number;
  missing: number;
  incorrect: number;
  accuracy: number;
  hallucination: number;
  score: number;
  avg_indexing_time_ms: number;
  avg_retrieval_time_ms: number;
  avg_generation_time_ms: number;
  total_time_sec: number;
}

export interface CragBenchmarkConfig {
  dataPath: string;
  outputDir: string;
  sampleSize?: number;
}

/**
 * Temporary stores for CRAG benchmark.
 * Uses IndexedDB with a unique DB name per question.
 */
interface TempStores {
  dbName: string;
  db: IDBDatabase;
  metadataStore: MetadataStore;
  embeddingStore: EmbeddingStore;
  bm25Store: BM25Store;
  embeddingSearch: EmbeddingSearch;
  bm25Search: BM25Search;
  searchManager: SearchManager;
}

/**
 * CRAG Benchmark Runner for end-to-end RAG evaluation.
 *
 * Uses the full Sonar pipeline with IndexedDB for each question:
 * 1. Creates temporary IndexedDB
 * 2. Indexes 50 pages (chunking, embedding, BM25)
 * 3. Hybrid search + reranking
 * 4. LLM answer generation
 * 5. Evaluation against ground truth
 * 6. Cleanup (delete IndexedDB)
 */
export class CragBenchmarkRunner extends WithLogging {
  protected readonly componentName = 'CragBenchmarkRunner';

  constructor(
    protected configManager: ConfigManager,
    private embedder: LlamaCppEmbedder,
    private reranker: LlamaCppReranker,
    private chatModel: LlamaCppChat,
    private vaultBasePath: string
  ) {
    super();
  }

  async runBenchmark(config: CragBenchmarkConfig): Promise<void> {
    this.log('Starting CRAG benchmark');
    new Notice('Starting CRAG benchmark...');

    // Get OpenAI API key from settings (required for LLM-as-judge evaluation)
    const openaiApiKey = this.configManager.get('cragOpenaiApiKey');
    if (!openaiApiKey) {
      const errorMsg =
        'cragOpenaiApiKey is required in settings for LLM-as-judge evaluation.';
      this.error(errorMsg);
      new Notice(errorMsg);
      throw new Error(errorMsg);
    }
    this.log('OpenAI API key configured for LLM-as-judge evaluation');

    const startTime = Date.now();

    try {
      const sampleOffset = this.configManager.get('cragSampleOffset');
      const samples = await this.loadSamples(
        config.dataPath,
        config.sampleSize,
        sampleOffset
      );
      this.log(
        `Loaded ${samples.length} samples` +
          (sampleOffset > 0 ? ` (offset: ${sampleOffset})` : '')
      );
      new Notice(`Loaded ${samples.length} CRAG samples`);

      // Ensure output directory exists
      const outputDir = this.resolvePath(config.outputDir);
      await fs.mkdir(outputDir, { recursive: true });

      // Use append mode when resuming (offset > 0), otherwise overwrite
      const resultsPath = join(outputDir, 'results.jsonl');
      const fileMode = sampleOffset > 0 ? 'a' : 'w';
      const resultsFile = await fs.open(resultsPath, fileMode);

      const results: CragResult[] = [];

      for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        const progress = `[${i + 1}/${samples.length}]`;

        this.log(`${progress} Processing: ${sample.question_id}`);
        new Notice(`${progress} Processing CRAG sample...`, 3000);

        const result = await this.processSample(sample, openaiApiKey);
        results.push(result);

        // Write result immediately (streaming output)
        await resultsFile.write(JSON.stringify(result) + '\n');

        this.log(
          `${progress} Result: ${result.evaluation} ` +
            `(index: ${result.indexing_time_ms}ms, ` +
            `retrieval: ${result.retrieval_time_ms}ms, ` +
            `gen: ${result.generation_time_ms}ms)`
        );
      }

      await resultsFile.close();

      // Calculate summary from on-disk results (includes previous runs if resumed)
      const allResults = await this.loadResults(resultsPath);
      const summary = this.calculateSummary(allResults, Date.now() - startTime);
      const summaryPath = join(outputDir, 'summary.json');
      await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));

      this.log('='.repeat(60));
      this.log('CRAG BENCHMARK RESULTS');
      this.log('='.repeat(60));
      this.log(`Total samples: ${summary.total}`);
      this.log(
        `Correct: ${summary.correct} (${(summary.accuracy * 100).toFixed(1)}%)`
      );
      this.log(`Missing: ${summary.missing}`);
      this.log(
        `Incorrect: ${summary.incorrect} (${(summary.hallucination * 100).toFixed(1)}%)`
      );
      this.log(`Score: ${(summary.score * 100).toFixed(1)}%`);
      this.log(
        `Avg indexing time: ${summary.avg_indexing_time_ms.toFixed(0)}ms`
      );
      this.log(
        `Avg retrieval time: ${summary.avg_retrieval_time_ms.toFixed(0)}ms`
      );
      this.log(
        `Avg generation time: ${summary.avg_generation_time_ms.toFixed(0)}ms`
      );
      this.log(`Total time: ${summary.total_time_sec.toFixed(1)}s`);
      this.log('='.repeat(60));

      new Notice(
        `CRAG benchmark complete!\n` +
          `Accuracy: ${(summary.accuracy * 100).toFixed(1)}%\n` +
          `Score: ${(summary.score * 100).toFixed(1)}%`,
        0
      );

      this.log(`Results saved to ${resultsPath}`);
      this.log(`Summary saved to ${summaryPath}`);
    } catch (error) {
      const errorMsg = `CRAG benchmark failed: ${error}`;
      this.error(errorMsg);
      new Notice(errorMsg);
      throw error;
    }
  }

  private resolvePath(path: string): string {
    if (isAbsolute(path)) {
      return path;
    }
    return join(this.vaultBasePath, path);
  }

  private async loadSamples(
    dataPath: string,
    sampleSize?: number,
    sampleOffset?: number
  ): Promise<CragSample[]> {
    const resolvedPath = this.resolvePath(dataPath);
    const offset = sampleOffset ?? 0;

    // Stream file line by line to avoid memory issues with large files
    const samples: CragSample[] = [];
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

        samples.push(JSON.parse(line) as CragSample);

        // Stop early if we have enough samples
        if (sampleSize && samples.length >= sampleSize) {
          rl.close();
          break;
        }
      }
    }

    return samples;
  }

  /**
   * Load results from on-disk results.jsonl for summary calculation
   */
  private async loadResults(resultsPath: string): Promise<CragResult[]> {
    const results: CragResult[] = [];

    const rl = createInterface({
      input: createReadStream(resultsPath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (line.trim()) {
        results.push(JSON.parse(line) as CragResult);
      }
    }

    return results;
  }

  /**
   * Create temporary IndexedDB and stores for a single question
   */
  private async createTempStores(questionId: string): Promise<TempStores> {
    const dbName = getDBName(`crag-${questionId}`, 'benchmark');

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
    // Use reflection to create MetadataStore with existing db
    // MetadataStore has a private constructor, so we create it via initialize
    // and then swap the db. This is a workaround for testing purposes.
    const dummyStore = await MetadataStore.initialize(
      'crag-temp',
      'benchmark',
      this.configManager
    );
    // Close the dummy db and replace with our temp db
    (dummyStore as any).db.close();
    (dummyStore as any).db = db;
    return dummyStore;
  }

  /**
   * Delete temporary IndexedDB
   */
  private async deleteTempDatabase(
    db: IDBDatabase,
    dbName: string
  ): Promise<void> {
    db.close();

    return new Promise((resolve, reject) => {
      const request = window.indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve();
      request.onerror = () =>
        reject(new Error(`Failed to delete temp IndexedDB: ${dbName}`));
    });
  }

  private async processSample(
    sample: CragSample,
    openaiApiKey: string
  ): Promise<CragResult> {
    const totalStart = Date.now();

    // Create temporary stores
    const stores = await this.createTempStores(sample.question_id);

    try {
      // Step 1: Index pages
      const indexingStart = Date.now();
      const chunkCount = await this.indexPages(sample.pages, stores);
      const indexingTimeMs = Date.now() - indexingStart;

      // Step 2: Search using full pipeline (same as search_vault tool)
      const retrievalStart = Date.now();
      const searchResultsCount = this.configManager.get('searchResultsCount');
      const chunks = await stores.searchManager.getRerankedChunksForRAG(
        sample.question,
        searchResultsCount
      );
      const retrievalTimeMs = Date.now() - retrievalStart;

      // Step 3: Generate answer
      const generationStart = Date.now();
      let context = this.buildContext(chunks || []);

      // Apply token budget truncation (same as ChatManager)
      const contextTokenBudget = this.configManager.get('contextTokenBudget');
      context = this.truncateToTokenBudget(context, contextTokenBudget);

      const generated = await this.generateAnswer(sample.question, context);
      const generationTimeMs = Date.now() - generationStart;

      // Step 4: Evaluate (rule-based first, then LLM-as-judge if needed)
      const evaluation = await this.evaluate(
        sample.question,
        generated,
        sample.answer,
        sample.alt_answers,
        openaiApiKey
      );

      return {
        question_id: sample.question_id,
        question: sample.question,
        expected: sample.answer,
        generated,
        evaluation,
        indexing_time_ms: indexingTimeMs,
        retrieval_time_ms: retrievalTimeMs,
        generation_time_ms: generationTimeMs,
        total_time_ms: Date.now() - totalStart,
        chunk_count: chunkCount,
      };
    } finally {
      // Cleanup: delete temporary IndexedDB
      await this.deleteTempDatabase(stores.db, stores.dbName);
    }
  }

  /**
   * Index pages using the full Sonar pipeline
   */
  private async indexPages(
    pages: CragPage[],
    stores: TempStores
  ): Promise<number> {
    const maxChunkSize = this.configManager.get('maxChunkSize');
    const chunkOverlap = this.configManager.get('chunkOverlap');
    const batchSize = this.configManager.get('indexingBatchSize');

    const allMetadata: ChunkMetadata[] = [];
    const allEmbeddings: { id: string; embedding: number[] }[] = [];
    const allBm25Chunks: { docId: string; content: string }[] = [];

    const now = Date.now();

    for (const page of pages) {
      if (!page.content) continue;

      // Use page_id as filePath for consistency
      const filePath = `page_${page.page_id}.md`;

      // Chunk the page content
      const chunks = await createChunks(
        page.content,
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
          title: page.title,
          content: chunk.content,
          headings: chunk.headings,
          mtime: now,
          size: page.content.length,
          indexedAt: now,
        });

        allBm25Chunks.push({
          docId: chunkId,
          content: chunk.content,
        });
      }

      // Also index title
      const titleId = ChunkId.forTitle(filePath);
      allMetadata.push({
        id: titleId,
        filePath,
        title: page.title,
        content: page.title,
        headings: [],
        mtime: now,
        size: page.content.length,
        indexedAt: now,
      });

      allBm25Chunks.push({
        docId: titleId,
        content: page.title,
      });
    }

    // Generate embeddings in batches
    for (let i = 0; i < allMetadata.length; i += batchSize) {
      const batch = allMetadata.slice(i, i + batchSize);
      const texts = batch.map(m => m.content);
      const embeddings = await this.embedder.getEmbeddings(texts);

      for (let j = 0; j < batch.length; j++) {
        allEmbeddings.push({
          id: batch[j].id,
          embedding: embeddings[j],
        });
      }
    }

    // Store all data
    await stores.metadataStore.addChunks(allMetadata);
    await stores.embeddingStore.addEmbeddings(allEmbeddings);
    await stores.bm25Store.indexChunkBatch(allBm25Chunks);

    return allMetadata.length;
  }

  /**
   * Build context from chunks in the same format as search_vault tool
   */
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

  /**
   * Truncate context to fit within token budget (same as ChatManager)
   */
  private truncateToTokenBudget(content: string, maxTokens: number): string {
    if (maxTokens <= 0) {
      return '[Content too large for context window]';
    }

    // Estimate: 4 characters per token (conservative for mixed content)
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
      [], // No tools
      { maxTokens: 256, enableThinking: false },
      delta => {
        if (delta.content) {
          response += delta.content;
        }
      }
    );

    // Use result.content as fallback if delta accumulation is empty
    if (!response && result.content) {
      response = result.content;
    }

    if (!response) {
      this.warn(`Empty response for: "${question.slice(0, 50)}..."`);
    }

    return response.trim();
  }

  /**
   * Evaluate generated answer against ground truth.
   * Following CRAG's evaluation approach:
   * 1. Rule-based: Check for "i don't know" patterns → missing
   * 2. Rule-based: Exact match with expected/alt answers → correct
   * 3. LLM-as-judge: Binary evaluation (correct/incorrect) for remaining cases
   */
  private async evaluate(
    question: string,
    generated: string,
    expected: string,
    altAnswers: string[],
    openaiApiKey: string
  ): Promise<EvaluationResult> {
    // Step 1: Rule-based exact match
    const ruleBasedResult = this.evaluateRuleBased(
      generated,
      expected,
      altAnswers
    );
    if (ruleBasedResult !== null) {
      return ruleBasedResult;
    }

    // Step 2: LLM-as-judge (only if rule-based match fails)
    return this.evaluateWithLLM(question, generated, expected, openaiApiKey);
  }

  /**
   * Rule-based evaluation (Step 1 of CRAG evaluation).
   * Returns null if no definitive match found (needs LLM evaluation).
   */
  private evaluateRuleBased(
    generated: string,
    expected: string,
    altAnswers: string[]
  ): EvaluationResult | null {
    const genLower = generated.toLowerCase().trim();

    // Check for "I don't know" response → missing
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

    // Exact match with expected answer → correct
    if (typeof expected === 'string') {
      const expectedLower = expected.toLowerCase().trim();
      if (genLower === expectedLower) {
        return 'correct';
      }
    }

    // Exact match with alternative answers → correct
    for (const alt of altAnswers) {
      if (typeof alt !== 'string') continue;
      const altLower = alt.toLowerCase().trim();
      if (altLower && genLower === altLower) {
        return 'correct';
      }
    }

    // No definitive match, needs LLM evaluation
    return null;
  }

  /**
   * LLM-as-judge evaluation (Step 2 of CRAG evaluation).
   * Uses OpenAI API with gpt-4o-mini for binary (correct/incorrect) evaluation.
   *
   * Note: Missing detection is handled by rule-based evaluation before this.
   * This method only evaluates whether the prediction matches the ground truth.
   * CRAG paper uses gpt-3.5-turbo + llama-3-70B average.
   */
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

  private calculateSummary(
    results: CragResult[],
    totalTimeMs: number
  ): CragSummary {
    const total = results.length;
    const correct = results.filter(r => r.evaluation === 'correct').length;
    const missing = results.filter(r => r.evaluation === 'missing').length;
    const incorrect = results.filter(r => r.evaluation === 'incorrect').length;

    const avgIndexingTime =
      total > 0
        ? results.reduce((sum, r) => sum + r.indexing_time_ms, 0) / total
        : 0;
    const avgRetrievalTime =
      total > 0
        ? results.reduce((sum, r) => sum + r.retrieval_time_ms, 0) / total
        : 0;
    const avgGenerationTime =
      total > 0
        ? results.reduce((sum, r) => sum + r.generation_time_ms, 0) / total
        : 0;

    return {
      total,
      correct,
      missing,
      incorrect,
      accuracy: total > 0 ? correct / total : 0,
      hallucination: total > 0 ? incorrect / total : 0,
      score: total > 0 ? (correct - incorrect) / total : 0,
      avg_indexing_time_ms: avgIndexingTime,
      avg_retrieval_time_ms: avgRetrievalTime,
      avg_generation_time_ms: avgGenerationTime,
      total_time_sec: totalTimeMs / 1000,
    };
  }
}
