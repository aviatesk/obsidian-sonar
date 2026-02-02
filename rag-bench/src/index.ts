import { Notice } from 'obsidian';
import type SonarPlugin from '../../main';
import { DEFAULT_SETTINGS } from '../../src/config';
import { LlamaCppChat } from '../../src/LlamaCppChat';
import { CragBenchmarkRunner } from './CragBenchmarkRunner';

export { CragBenchmarkRunner } from './CragBenchmarkRunner';
export { createCragBenchmarkSettings } from './settings';

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
