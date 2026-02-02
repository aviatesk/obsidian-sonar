import { Notice } from 'obsidian';
import type SonarPlugin from '../../main';
import { DEFAULT_SETTINGS } from '../../src/config';
import { LlamaCppChat } from '../../src/LlamaCppChat';
import { CragBenchmarkRunner } from './CragBenchmarkRunner';
import { CragUnifiedBenchmarkRunner } from './CragUnifiedBenchmarkRunner';

export { CragBenchmarkRunner } from './CragBenchmarkRunner';
export { CragUnifiedBenchmarkRunner } from './CragUnifiedBenchmarkRunner';
export {
  createCragBenchmarkSettings,
  createCragUnifiedBenchmarkSettings,
} from './settings';

export function registerCragBenchmarkCommands(plugin: SonarPlugin): void {
  plugin.addCommand({
    id: 'run-crag-benchmark',
    name: 'Run CRAG benchmark (end-to-end RAG)',
    callback: async () => {
      if (!plugin.embedder || !plugin.reranker) {
        new Notice('Sonar is not initialized yet');
        return;
      }

      const dataPath = plugin.configManager.get('cragDataPath');
      const outputDir = plugin.configManager.get('cragOutputDir');

      if (!dataPath || !outputDir) {
        new Notice(
          'CRAG benchmark paths not configured.\n' +
            'Set cragDataPath and cragOutputDir in settings.'
        );
        return;
      }

      // Initialize chat model for answer generation
      const serverPath = plugin.configManager.get('llamacppServerPath');
      const chatModelRepo =
        plugin.configManager.get('llamaChatModelRepo') ||
        DEFAULT_SETTINGS.llamaChatModelRepo;
      const chatModelFile =
        plugin.configManager.get('llamaChatModelFile') ||
        DEFAULT_SETTINGS.llamaChatModelFile;

      const chatModel = new LlamaCppChat(
        serverPath,
        chatModelRepo,
        chatModelFile,
        plugin.configManager,
        (msg, duration) => new Notice(msg, duration),
        (modelId: string) => plugin.confirmModelDownload('chat', modelId)
      );

      try {
        new Notice('Initializing chat model for CRAG benchmark...');
        await chatModel.initialize();

        const vaultBasePath = (plugin.app.vault.adapter as any).basePath || '';
        const benchmarkRunner = new CragBenchmarkRunner(
          plugin.configManager,
          plugin.embedder,
          plugin.reranker,
          chatModel,
          vaultBasePath
        );

        await benchmarkRunner.runBenchmark({
          dataPath,
          outputDir,
          sampleSize: plugin.configManager.get('cragSampleSize'),
        });
      } catch (error) {
        plugin.configManager
          .getLogger()
          .error(`[Sonar.Plugin] CRAG benchmark failed: ${error}`);
        new Notice(`CRAG benchmark failed: ${error}`);
      } finally {
        await chatModel.cleanup();
      }
    },
  });
}

export function registerCragUnifiedBenchmarkCommands(
  plugin: SonarPlugin
): void {
  plugin.addCommand({
    id: 'run-crag-unified-benchmark',
    name: 'Run CRAG Unified benchmark (Sonar vs Cloud)',
    callback: async () => {
      if (!plugin.embedder || !plugin.reranker) {
        new Notice('Sonar is not initialized yet');
        return;
      }

      const corpusPath = plugin.configManager.get('cragUnifiedCorpusPath');
      const queriesPath = plugin.configManager.get('cragUnifiedQueriesPath');
      const outputDir = plugin.configManager.get('cragUnifiedOutputDir');

      if (!corpusPath || !queriesPath || !outputDir) {
        new Notice(
          'CRAG Unified benchmark paths not configured.\n' +
            'Set corpus, queries, and output paths in settings.'
        );
        return;
      }

      const openaiApiKey = plugin.configManager.get('cragOpenaiApiKey');
      if (!openaiApiKey) {
        new Notice('OpenAI API key required for CRAG Unified benchmark.');
        return;
      }

      const serverPath = plugin.configManager.get('llamacppServerPath');
      const chatModelRepo =
        plugin.configManager.get('llamaChatModelRepo') ||
        DEFAULT_SETTINGS.llamaChatModelRepo;
      const chatModelFile =
        plugin.configManager.get('llamaChatModelFile') ||
        DEFAULT_SETTINGS.llamaChatModelFile;

      const chatModel = new LlamaCppChat(
        serverPath,
        chatModelRepo,
        chatModelFile,
        plugin.configManager,
        (msg, duration) => new Notice(msg, duration),
        (modelId: string) => plugin.confirmModelDownload('chat', modelId)
      );

      try {
        new Notice('Initializing chat model for CRAG Unified benchmark...');
        await chatModel.initialize();

        const vaultBasePath = (plugin.app.vault.adapter as any).basePath || '';
        const benchmarkRunner = new CragUnifiedBenchmarkRunner(
          plugin.configManager,
          plugin.embedder,
          plugin.reranker,
          chatModel,
          vaultBasePath
        );

        await benchmarkRunner.runBenchmark({
          corpusPath,
          queriesPath,
          outputDir,
          sampleSize:
            plugin.configManager.get('cragUnifiedSampleSize') || undefined,
          sampleOffset:
            plugin.configManager.get('cragUnifiedSampleOffset') || undefined,
          runSonar: true,
          runCloud: true,
          openaiApiKey,
        });
      } catch (error) {
        plugin.configManager
          .getLogger()
          .error(`[Sonar.Plugin] CRAG Unified benchmark failed: ${error}`);
        new Notice(`CRAG Unified benchmark failed: ${error}`);
      } finally {
        await chatModel.cleanup();
      }
    },
  });
}
