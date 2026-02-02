import { Notice } from 'obsidian';
import type SonarPlugin from '../../main';
import { RetrievalBenchmarkRunner } from './RetrievalBenchmarkRunner';

export { RetrievalBenchmarkRunner as BenchmarkRunner } from './RetrievalBenchmarkRunner';
export { createRetrievalBenchmarkSettings } from './settings';

export function registerRetrievalBenchmarkCommands(plugin: SonarPlugin): void {
  plugin.addCommand({
    id: 'run-retrieval-benchmark',
    name: 'Run retrieval benchmark (BM25, Vector, Hybrid)',
    callback: async () => {
      if (!plugin.searchManager || !plugin.indexManager) {
        new Notice('Sonar is not initialized yet');
        return;
      }
      const retrievalBenchmarkRunner = new RetrievalBenchmarkRunner(
        plugin.app,
        plugin.configManager,
        plugin.searchManager,
        plugin.indexManager
      );
      try {
        await retrievalBenchmarkRunner.runBenchmark(false);
      } catch (error) {
        plugin.configManager
          .getLogger()
          .error(`[Sonar.Plugin] Benchmark failed: ${error}`);
      }
    },
  });

  plugin.addCommand({
    id: 'run-retrieval-benchmark-with-reranking',
    name: 'Run retrieval benchmark with reranking (BM25, Vector, Hybrid, Hybrid+Rerank)',
    callback: async () => {
      if (!plugin.searchManager || !plugin.indexManager) {
        new Notice('Sonar is not initialized yet');
        return;
      }
      const retrievalBenchmarkRunner = new RetrievalBenchmarkRunner(
        plugin.app,
        plugin.configManager,
        plugin.searchManager,
        plugin.indexManager
      );
      try {
        await retrievalBenchmarkRunner.runBenchmark(true);
      } catch (error) {
        plugin.configManager
          .getLogger()
          .error(`[Sonar.Plugin] Benchmark failed: ${error}`);
      }
    },
  });
}
