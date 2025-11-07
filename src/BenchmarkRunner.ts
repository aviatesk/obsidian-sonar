import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import { WithLogging } from './WithLogging';
import type { ConfigManager } from './ConfigManager';
import type { SearchManager } from './SearchManager';
import type { IndexManager } from './IndexManager';
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

/**
 * Benchmark runner for evaluating Sonar against other retrieval systems.
 * Reads queries from JSONL file, runs searches, outputs TREC format results.
 */
export class BenchmarkRunner extends WithLogging {
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
   * Run full benchmark: sync index, then run all search methods.
   */
  async runBenchmark(): Promise<void> {
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

    try {
      // Step 1: Sync index
      this.log('Step 1: Syncing index...');
      new Notice('Syncing index...');
      await this.indexManager.syncIndex();
      this.log('Index synced');

      // Step 2: Load queries
      this.log('Step 2: Loading queries...');
      const queries = await this.loadQueries(queriesPath);
      this.log(`Loaded ${queries.length} queries`);

      // Step 3: Run BM25 search
      this.log('Step 3: Running BM25 search...');
      new Notice(`Running BM25 search on ${queries.length} queries...`);
      const bm25Results = await this.runBM25Search(queries);
      await this.writeTrecResults(
        bm25Results,
        `${outputDir}/sonar.bm25.trec`,
        'sonar.bm25'
      );
      this.log(`BM25 results written to ${outputDir}/sonar.bm25.trec`);

      // Step 4: Run Vector search
      this.log('Step 4: Running Vector search...');
      new Notice(`Running Vector search on ${queries.length} queries...`);
      const vectorResults = await this.runVectorSearch(queries);
      await this.writeTrecResults(
        vectorResults,
        `${outputDir}/sonar.vector.trec`,
        'sonar.vector'
      );
      this.log(`Vector results written to ${outputDir}/sonar.vector.trec`);

      // Step 5: Run Hybrid search
      this.log('Step 5: Running Hybrid search...');
      new Notice(`Running Hybrid search on ${queries.length} queries...`);
      const hybridResults = await this.runHybridSearch(queries);
      await this.writeTrecResults(
        hybridResults,
        `${outputDir}/sonar.hybrid.trec`,
        'sonar.hybrid'
      );
      this.log(`Hybrid results written to ${outputDir}/sonar.hybrid.trec`);

      new Notice('Benchmark complete! Results written to output directory.');
      this.log('Benchmark complete');
    } catch (error) {
      const errorMsg = `Benchmark failed: ${error}`;
      this.error(errorMsg);
      new Notice(errorMsg);
      throw error;
    }
  }

  /**
   * Load queries from JSONL file.
   */
  private async loadQueries(path: string): Promise<Query[]> {
    try {
      const content = await this.app.vault.adapter.read(path);
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
   * Run BM25 search for all queries.
   */
  private async runBM25Search(queries: Query[]): Promise<TrecResult[]> {
    const topK = this.configManager.get('benchmarkTopK');
    const results: TrecResult[] = [];

    for (const query of queries) {
      const searchResults = await this.searchManager.searchBenchmark(
        query.text,
        topK,
        {
          embeddingWeight: 0,
          bm25Weight: 1,
          titleWeight: 0,
          contentWeight: 1,
        }
      );

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
   * Run Vector search for all queries.
   */
  private async runVectorSearch(queries: Query[]): Promise<TrecResult[]> {
    const topK = this.configManager.get('benchmarkTopK');
    const results: TrecResult[] = [];

    for (const query of queries) {
      const searchResults = await this.searchManager.searchBenchmark(
        query.text,
        topK,
        {
          embeddingWeight: 1,
          bm25Weight: 0,
          titleWeight: 0,
          contentWeight: 1,
        }
      );

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
   * Run Hybrid search for all queries.
   */
  private async runHybridSearch(queries: Query[]): Promise<TrecResult[]> {
    const topK = this.configManager.get('benchmarkTopK');
    const results: TrecResult[] = [];

    for (const query of queries) {
      const searchResults = await this.searchManager.searchBenchmark(
        query.text,
        topK,
        {
          embeddingWeight: 0.5,
          bm25Weight: 0.5,
          titleWeight: 0,
          contentWeight: 1,
        }
      );

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
      let resolvedPath = outputPath;
      if (!isAbsolute(outputPath)) {
        // Relative path: resolve against vault root
        const adapter = this.app.vault.adapter as any;
        const basePath = adapter.basePath || '';
        resolvedPath = join(basePath, outputPath);
      }

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
