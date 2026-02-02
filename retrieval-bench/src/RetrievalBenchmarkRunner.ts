import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import { WithLogging } from '../../src/WithLogging';
import type { ConfigManager } from '../../src/ConfigManager';
import type { SearchManager, SearchOptions } from '../../src/SearchManager';
import type { IndexManager } from '../../src/IndexManager';
import { join, dirname, isAbsolute } from 'path';
import { promises as fs } from 'fs';

interface Query {
  _id: string;
  text: string;
}

interface TrecResult {
  queryId: string;
  docId: string;
  rank: number;
  score: number;
}

interface Qrel {
  queryId: string;
  docId: string;
  relevance: number;
}

interface EvaluationMetrics {
  'nDCG@10': number;
  'Recall@10': number;
  'Recall@100': number;
  'MRR@10': number;
  MAP: number;
}

interface RunEvaluation {
  runName: string;
  metrics: EvaluationMetrics;
}

/**
 * Benchmark runner for evaluating Sonar against other retrieval systems.
 * Reads queries from JSONL file, runs searches, outputs TREC format results.
 */
export class RetrievalBenchmarkRunner extends WithLogging {
  protected readonly componentName = 'BenchmarkRunner';

  constructor(
    private app: App,
    protected configManager: ConfigManager,
    private searchManager: SearchManager,
    private indexManager: IndexManager
  ) {
    super();
  }

  /**
   * Run full benchmark: sync index, run all search methods, and evaluate.
   * @param reranking - If true, include Hybrid+Rerank method (slower)
   */
  async runBenchmark(reranking: boolean = false): Promise<void> {
    const queriesPath = this.configManager.get('benchmarkQueriesPath');
    const outputDir = this.configManager.get('benchmarkOutputDir');

    if (!queriesPath || !outputDir) {
      new Notice(
        'Benchmark paths not configured. Check benchmarkQueriesPath and benchmarkOutputDir in settings.'
      );
      this.error('Benchmark paths not configured');
      return;
    }

    this.log('Starting benchmark');
    new Notice('Starting Sonar benchmark...');

    const startTime = Date.now();

    try {
      // Step 1: Sync index
      this.log('Step 1: Syncing index...');
      new Notice('Syncing index...');
      await this.indexManager.syncIndex(true);
      this.log('Index synced');

      // Step 2: Load queries
      this.log('Step 2: Loading queries...');
      const queries = await this.loadQueries(queriesPath);
      this.log(`Loaded ${queries.length} queries`);

      // Step 3: Run all search methods
      const searchMethods: {
        name: string;
        runId: string;
        weights: SearchOptions;
        rerank?: boolean;
      }[] = [
        {
          name: 'BM25',
          runId: 'sonar.bm25',
          weights: {
            embeddingWeight: 0,
            bm25Weight: 1,
            titleWeight: 0,
            contentWeight: 1,
          },
        },
        {
          name: 'Vector',
          runId: 'sonar.vector',
          weights: {
            embeddingWeight: 1,
            bm25Weight: 0,
            titleWeight: 0,
            contentWeight: 1,
          },
        },
        {
          name: 'Hybrid',
          runId: 'sonar.hybrid',
          weights: {
            embeddingWeight: 0.5,
            bm25Weight: 0.5,
            titleWeight: 0,
            contentWeight: 1,
          },
        },
        ...(reranking
          ? [
              {
                name: 'Hybrid+Rerank',
                runId: 'sonar.hybrid_rerank',
                weights: {
                  embeddingWeight: 0.5,
                  bm25Weight: 0.5,
                  titleWeight: 0,
                  contentWeight: 1,
                },
                rerank: true,
              },
            ]
          : []),
      ];

      for (let i = 0; i < searchMethods.length; i++) {
        const method = searchMethods[i];
        const stepNum = i + 3;

        this.log(`Step ${stepNum}: Running ${method.name} search...`);
        new Notice(
          `Running ${method.name} search on ${queries.length} queries...`
        );

        const methodStartTime = Date.now();
        let results: TrecResult[];
        if (method.rerank) {
          results = await this.runSearchWithRerank(queries, method.weights);
        } else {
          results = await this.runSearch(queries, method.weights);
        }
        const methodTime = Date.now() - methodStartTime;
        const outputPath = `${outputDir}/${method.runId}.trec`;

        await this.writeTrecResults(results, outputPath, method.runId);
        this.log(
          `${method.name} benchmark completed in ${(methodTime / 1000).toFixed(1)}s (${queries.length} queries, avg ${(methodTime / queries.length).toFixed(0)}ms/query)`
        );
        this.log(`${method.name} benchmark results written to ${outputPath}`);
      }

      const elapsedMs = Date.now() - startTime;
      const elapsedSec = (elapsedMs / 1000).toFixed(1);
      this.log(`Benchmark search completed in ${elapsedSec}s`);

      // Step 4: Evaluate results
      const qrelsPath = this.configManager.get('benchmarkQrelsPath');
      if (qrelsPath) {
        this.log('Step 4: Evaluating results...');
        new Notice('Evaluating benchmark results...');

        const runFiles = searchMethods.map(
          method => `${outputDir}/${method.runId}.trec`
        );
        await this.evaluateRuns(runFiles, qrelsPath);
      } else {
        this.log('Skipping evaluation (benchmarkQrelsPath not configured)');
      }

      const totalElapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      new Notice(`Benchmark completed in ${totalElapsedSec}s`, 0);
      this.log(`Total benchmark time: ${totalElapsedSec}s`);
    } catch (error) {
      const errorMsg = `Benchmark failed: ${error}`;
      this.error(errorMsg);
      new Notice(errorMsg);
      throw error;
    }
  }

  /**
   * Resolve path: support both absolute and vault-relative paths.
   */
  private resolvePath(path: string): string {
    if (isAbsolute(path)) {
      return path;
    }
    // Relative path: resolve against vault root
    const adapter = this.app.vault.adapter as any;
    const basePath = adapter.basePath || '';
    return join(basePath, path);
  }

  /**
   * Load queries from JSONL file.
   * Supports both absolute paths and vault-relative paths.
   */
  private async loadQueries(path: string): Promise<Query[]> {
    try {
      const resolvedPath = this.resolvePath(path);
      const content = await fs.readFile(resolvedPath, 'utf-8');
      const lines = content.trim().split('\n');
      const queries: Query[] = [];

      for (const line of lines) {
        if (line.trim()) {
          const query = JSON.parse(line) as Query;
          queries.push(query);
        }
      }

      return queries;
    } catch (error) {
      this.error(`Failed to load queries from ${path}: ${error}`);
      throw error;
    }
  }

  /**
   * Remove .md extension from filePath to match qrels format
   */
  private normalizeDocId(filePath: string): string {
    return filePath.replace(/\.md$/, '');
  }

  /**
   * Run search for all queries with given weights.
   */
  private async runSearch(
    queries: Query[],
    weights: SearchOptions
  ): Promise<TrecResult[]> {
    const topK = this.configManager.get('benchmarkTopK');
    const results: TrecResult[] = [];

    for (const query of queries) {
      const searchResults = await this.searchManager.search(
        'BenchmarkRunner',
        query.text,
        {
          topK,
          ...weights,
        }
      );

      // Benchmark runs sequentially, so null (superseded) shouldn't occur
      if (searchResults === null) {
        continue;
      }

      for (let i = 0; i < searchResults.length; i++) {
        const result = searchResults[i];
        results.push({
          queryId: query._id,
          docId: this.normalizeDocId(result.filePath),
          rank: i + 1,
          score: result.score,
        });
      }
    }

    return results;
  }

  /**
   * Run search with chunk-based reranking for all queries.
   * Uses searchWithChunkRerank which merges chunks from BM25/Embedding before reranking.
   */
  private async runSearchWithRerank(
    queries: Query[],
    weights: SearchOptions
  ): Promise<TrecResult[]> {
    // Use smaller topK for chunk reranking to limit reranker input size
    // TODO: Add dedicated config for chunk reranking limit
    const topK = (this.configManager.get('benchmarkTopK')) / 10;
    const results: TrecResult[] = [];

    for (const query of queries) {
      const rerankResult = await this.searchManager.searchWithChunkRerank(
        query.text,
        {
          topK,
          ...weights,
          prependTitleToChunks: false, // Benchmark titles are random strings
        }
      );

      if (rerankResult === null) {
        continue;
      }

      for (let i = 0; i < rerankResult.results.length; i++) {
        const result = rerankResult.results[i];
        results.push({
          queryId: query._id,
          docId: this.normalizeDocId(result.filePath),
          rank: i + 1,
          score: result.score,
        });
      }
    }

    return results;
  }

  /**
   * Load qrels from TSV file.
   * Format: query-id\tcorpus-id\tscore
   */
  private async loadQrels(path: string): Promise<Qrel[]> {
    try {
      const resolvedPath = this.resolvePath(path);
      const content = await fs.readFile(resolvedPath, 'utf-8');
      const lines = content.trim().split('\n');
      const qrels: Qrel[] = [];

      for (let i = 1; i < lines.length; i++) {
        // Skip header
        const line = lines[i].trim();
        if (!line) continue;

        const parts = line.split('\t');
        if (parts.length >= 3) {
          qrels.push({
            queryId: parts[0],
            docId: parts[1],
            relevance: parseInt(parts[2]),
          });
        }
      }

      return qrels;
    } catch (error) {
      this.error(`Failed to load qrels from ${path}: ${error}`);
      throw error;
    }
  }

  /**
   * Load TREC run file.
   * Format: query_id Q0 doc_id rank score run_id
   */
  private async loadTrecRun(path: string): Promise<TrecResult[]> {
    try {
      const resolvedPath = this.resolvePath(path);
      const content = await fs.readFile(resolvedPath, 'utf-8');
      const lines = content.trim().split('\n');
      const results: TrecResult[] = [];

      for (const line of lines) {
        if (!line.trim()) continue;

        const parts = line.split(/\s+/);
        if (parts.length >= 6) {
          results.push({
            queryId: parts[0],
            docId: parts[2],
            rank: parseInt(parts[3]),
            score: parseFloat(parts[4]),
          });
        }
      }

      return results;
    } catch (error) {
      this.error(`Failed to load TREC run from ${path}: ${error}`);
      throw error;
    }
  }

  /**
   * Calculate DCG (Discounted Cumulative Gain) at k.
   */
  private calculateDCG(relevances: number[], k: number): number {
    let dcg = 0;
    for (let i = 0; i < Math.min(k, relevances.length); i++) {
      const rel = relevances[i];
      const discount = Math.log2(i + 2); // i+2 because rank starts at 1
      dcg += rel / discount;
    }
    return dcg;
  }

  /**
   * Calculate nDCG (Normalized DCG) at k for a single query.
   */
  private calculateQueryNDCG(
    retrievedDocs: string[],
    relevantDocs: Map<string, number>,
    k: number
  ): number {
    // Get relevances for retrieved docs
    const relevances = retrievedDocs
      .slice(0, k)
      .map(docId => relevantDocs.get(docId) || 0);

    // Calculate DCG
    const dcg = this.calculateDCG(relevances, k);

    // Calculate ideal DCG (sort relevances in descending order)
    const idealRelevances = Array.from(relevantDocs.values()).sort(
      (a, b) => b - a
    );
    const idcg = this.calculateDCG(idealRelevances, k);

    // Return normalized DCG
    return idcg > 0 ? dcg / idcg : 0;
  }

  /**
   * Calculate Recall at k for a single query.
   */
  private calculateQueryRecall(
    retrievedDocs: string[],
    relevantDocs: Set<string>,
    k: number
  ): number {
    if (relevantDocs.size === 0) return 0;

    const retrievedAtK = new Set(retrievedDocs.slice(0, k));
    let foundRelevant = 0;

    for (const docId of relevantDocs) {
      if (retrievedAtK.has(docId)) {
        foundRelevant++;
      }
    }

    return foundRelevant / relevantDocs.size;
  }

  /**
   * Calculate Reciprocal Rank for a single query.
   */
  private calculateQueryRR(
    retrievedDocs: string[],
    relevantDocs: Set<string>,
    k: number
  ): number {
    for (let i = 0; i < Math.min(k, retrievedDocs.length); i++) {
      if (relevantDocs.has(retrievedDocs[i])) {
        return 1 / (i + 1);
      }
    }
    return 0;
  }

  /**
   * Calculate Average Precision for a single query.
   */
  private calculateQueryAP(
    retrievedDocs: string[],
    relevantDocs: Set<string>
  ): number {
    if (relevantDocs.size === 0) return 0;

    let sumPrecision = 0;
    let numRelevantFound = 0;

    for (let i = 0; i < retrievedDocs.length; i++) {
      if (relevantDocs.has(retrievedDocs[i])) {
        numRelevantFound++;
        const precision = numRelevantFound / (i + 1);
        sumPrecision += precision;
      }
    }

    return sumPrecision / relevantDocs.size;
  }

  /**
   * Calculate evaluation metrics for a run.
   */
  private calculateMetrics(
    run: TrecResult[],
    qrels: Qrel[]
  ): EvaluationMetrics {
    // Group run results by query
    const runByQuery = new Map<string, TrecResult[]>();
    for (const result of run) {
      if (!runByQuery.has(result.queryId)) {
        runByQuery.set(result.queryId, []);
      }
      runByQuery.get(result.queryId)!.push(result);
    }

    // Group qrels by query
    const qrelsByQuery = new Map<string, Qrel[]>();
    for (const qrel of qrels) {
      if (qrel.relevance > 0) {
        // Only consider relevant docs
        if (!qrelsByQuery.has(qrel.queryId)) {
          qrelsByQuery.set(qrel.queryId, []);
        }
        qrelsByQuery.get(qrel.queryId)!.push(qrel);
      }
    }

    // Calculate metrics for each query
    const queries = Array.from(
      new Set([...runByQuery.keys(), ...qrelsByQuery.keys()])
    );

    let sumNDCG10 = 0;
    let sumRecall10 = 0;
    let sumRecall100 = 0;
    let sumRR10 = 0;
    let sumAP = 0;
    let numQueries = 0;

    for (const queryId of queries) {
      const retrievedDocs =
        runByQuery
          .get(queryId)
          ?.sort((a, b) => a.rank - b.rank)
          .map(r => r.docId) || [];
      const relevantQrels = qrelsByQuery.get(queryId) || [];

      if (relevantQrels.length === 0) continue; // Skip queries with no relevant docs

      numQueries++;

      // Prepare relevant docs structures
      const relevantDocsMap = new Map<string, number>();
      const relevantDocsSet = new Set<string>();
      for (const qrel of relevantQrels) {
        relevantDocsMap.set(qrel.docId, qrel.relevance);
        relevantDocsSet.add(qrel.docId);
      }

      // Calculate metrics
      sumNDCG10 += this.calculateQueryNDCG(retrievedDocs, relevantDocsMap, 10);
      sumRecall10 += this.calculateQueryRecall(
        retrievedDocs,
        relevantDocsSet,
        10
      );
      sumRecall100 += this.calculateQueryRecall(
        retrievedDocs,
        relevantDocsSet,
        100
      );
      sumRR10 += this.calculateQueryRR(retrievedDocs, relevantDocsSet, 10);
      sumAP += this.calculateQueryAP(retrievedDocs, relevantDocsSet);
    }

    // Return average metrics
    return {
      'nDCG@10': numQueries > 0 ? sumNDCG10 / numQueries : 0,
      'Recall@10': numQueries > 0 ? sumRecall10 / numQueries : 0,
      'Recall@100': numQueries > 0 ? sumRecall100 / numQueries : 0,
      'MRR@10': numQueries > 0 ? sumRR10 / numQueries : 0,
      MAP: numQueries > 0 ? sumAP / numQueries : 0,
    };
  }

  /**
   * Evaluate multiple run files and display results.
   */
  private async evaluateRuns(
    runFiles: string[],
    qrelsPath: string
  ): Promise<void> {
    try {
      // Load qrels
      this.log(`Loading qrels from ${qrelsPath}...`);
      const qrels = await this.loadQrels(qrelsPath);
      const numQueries = new Set(qrels.map(q => q.queryId)).size;
      this.log(`Loaded ${numQueries} queries from qrels`);

      // Evaluate each run
      const evaluations: RunEvaluation[] = [];

      for (const runFile of runFiles) {
        const runName =
          runFile.split('/').pop()?.replace('.trec', '') || runFile;
        this.log(`Evaluating ${runName}...`);

        const run = await this.loadTrecRun(runFile);
        const metrics = this.calculateMetrics(run, qrels);

        evaluations.push({ runName, metrics });

        // Log detailed results
        this.log(
          `  ${runName}: nDCG@10=${metrics['nDCG@10'].toFixed(4)}, ` +
            `Recall@10=${metrics['Recall@10'].toFixed(4)}, ` +
            `Recall@100=${metrics['Recall@100'].toFixed(4)}, ` +
            `MRR@10=${metrics['MRR@10'].toFixed(4)}, ` +
            `MAP=${metrics.MAP.toFixed(4)}`
        );
      }

      // Display comparison table in logs
      this.log('');
      this.log('='.repeat(80));
      this.log('COMPARISON TABLE');
      this.log('='.repeat(80));
      this.log(
        'Run                   nDCG@10      Recall@10    Recall@100   MRR@10       MAP    '
      );
      this.log('-'.repeat(80));
      for (const evaluation of evaluations) {
        const m = evaluation.metrics;
        this.log(
          `${evaluation.runName.padEnd(20)} ` +
            `${m['nDCG@10'].toFixed(4).padEnd(12)} ` +
            `${m['Recall@10'].toFixed(4).padEnd(12)} ` +
            `${m['Recall@100'].toFixed(4).padEnd(12)} ` +
            `${m['MRR@10'].toFixed(4).padEnd(12)} ` +
            `${m.MAP.toFixed(4).padEnd(12)}`
        );
      }
      this.log('='.repeat(80));

      // Show simple summary in notification
      const summaryLines = evaluations.map(e => {
        return `${e.runName}: nDCG@10=${e.metrics['nDCG@10'].toFixed(4)}`;
      });
      new Notice(`Evaluation complete:\n${summaryLines.join('\n')}`, 0);
    } catch (error) {
      this.error(`Evaluation failed: ${error}`);
      throw error;
    }
  }

  /**
   * Write results in TREC run format.
   * Format: query_id Q0 doc_id rank score run_id
   */
  private async writeTrecResults(
    results: TrecResult[],
    outputPath: string,
    runId: string
  ): Promise<void> {
    try {
      const lines: string[] = [];

      for (const result of results) {
        lines.push(
          `${result.queryId} Q0 ${result.docId} ${result.rank} ${result.score} ${runId}`
        );
      }

      const content = lines.join('\n') + '\n';

      // Resolve path: support both absolute and vault-relative paths
      const resolvedPath = this.resolvePath(outputPath);

      // Ensure directory exists
      const dir = dirname(resolvedPath);
      await fs.mkdir(dir, { recursive: true });

      // Write file
      await fs.writeFile(resolvedPath, content, 'utf-8');
    } catch (error) {
      this.error(`Failed to write TREC results to ${outputPath}: ${error}`);
      throw error;
    }
  }
}
