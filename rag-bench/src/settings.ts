import { App, MarkdownRenderer, Setting } from 'obsidian';
import type { ConfigManager } from '../../src/ConfigManager';
import type SonarPlugin from '../../main';

function renderMarkdownDesc(
  app: App,
  plugin: SonarPlugin,
  el: HTMLElement,
  markdown: string
): void {
  el.empty();
  el.addClass('sonar-markdown-desc');
  MarkdownRenderer.render(app, markdown, el, '', plugin);
}

export function createCragBenchmarkSettings(
  app: App,
  plugin: SonarPlugin,
  containerEl: HTMLElement,
  configManager: ConfigManager
): void {
  const cragDetails = containerEl.createEl('details', {
    cls: 'sonar-settings-section',
  });
  cragDetails.createEl('summary', { text: 'CRAG benchmark (end-to-end RAG)' });
  const cragContainer = cragDetails.createDiv();

  const dataPathSetting = new Setting(cragContainer).setName('CRAG data path');
  renderMarkdownDesc(
    app,
    plugin,
    dataPathSetting.descEl,
    'Path to `data.jsonl` file for CRAG benchmark. Can be absolute or relative to vault root.'
  );
  dataPathSetting.addText(text =>
    text
      .setPlaceholder('rag-bench/data.jsonl or /absolute/path/to/data.jsonl')
      .setValue(configManager.get('cragDataPath'))
      .onChange(async value => await configManager.set('cragDataPath', value))
  );

  const outputDirSetting = new Setting(cragContainer).setName(
    'CRAG output directory'
  );
  renderMarkdownDesc(
    app,
    plugin,
    outputDirSetting.descEl,
    'Path to directory for CRAG benchmark output. Can be absolute or relative to vault root.'
  );
  outputDirSetting.addText(text =>
    text
      .setPlaceholder('rag-bench/output or /absolute/path/to/output')
      .setValue(configManager.get('cragOutputDir'))
      .onChange(async value => await configManager.set('cragOutputDir', value))
  );

  const sampleSizeSetting = new Setting(cragContainer).setName(
    'CRAG sample size'
  );
  renderMarkdownDesc(
    app,
    plugin,
    sampleSizeSetting.descEl,
    'Number of samples to process (`0` = all samples).'
  );
  sampleSizeSetting.addText(text =>
    text
      .setPlaceholder('0')
      .setValue(String(configManager.get('cragSampleSize')))
      .onChange(async value => {
        const num = parseInt(value, 10);
        if (!isNaN(num) && num >= 0) {
          await configManager.set('cragSampleSize', num);
        }
      })
  );

  const apiKeySetting = new Setting(cragContainer).setName('OpenAI API key');
  renderMarkdownDesc(
    app,
    plugin,
    apiKeySetting.descEl,
    'API key for OpenAI (used for LLM-as-judge evaluation).'
  );
  apiKeySetting.addText(text =>
    text
      .setPlaceholder('sk-...')
      .setValue(configManager.get('cragOpenaiApiKey'))
      .onChange(
        async value => await configManager.set('cragOpenaiApiKey', value)
      )
  );
  // Make API key input a password field
  const inputEl = apiKeySetting.controlEl.querySelector('input');
  if (inputEl) {
    inputEl.type = 'password';
  }
}

export function createCragUnifiedBenchmarkSettings(
  app: App,
  plugin: SonarPlugin,
  containerEl: HTMLElement,
  configManager: ConfigManager
): void {
  const details = containerEl.createEl('details', {
    cls: 'sonar-settings-section',
  });
  details.createEl('summary', {
    text: 'CRAG Unified benchmark (Sonar vs Cloud)',
  });
  const container = details.createDiv();

  const corpusPathSetting = new Setting(container).setName('Corpus path');
  renderMarkdownDesc(
    app,
    plugin,
    corpusPathSetting.descEl,
    'Path to `corpus.jsonl` file for CRAG Unified benchmark.'
  );
  corpusPathSetting.addText(text =>
    text
      .setPlaceholder('rag-bench/datasets/crag-unified/corpus.jsonl')
      .setValue(configManager.get('cragUnifiedCorpusPath'))
      .onChange(
        async value => await configManager.set('cragUnifiedCorpusPath', value)
      )
  );

  const queriesPathSetting = new Setting(container).setName('Queries path');
  renderMarkdownDesc(
    app,
    plugin,
    queriesPathSetting.descEl,
    'Path to `queries.jsonl` file for CRAG Unified benchmark.'
  );
  queriesPathSetting.addText(text =>
    text
      .setPlaceholder('rag-bench/datasets/crag-unified/queries.jsonl')
      .setValue(configManager.get('cragUnifiedQueriesPath'))
      .onChange(
        async value => await configManager.set('cragUnifiedQueriesPath', value)
      )
  );

  const outputDirSetting = new Setting(container).setName('Output directory');
  renderMarkdownDesc(
    app,
    plugin,
    outputDirSetting.descEl,
    'Path to directory for benchmark output files.'
  );
  outputDirSetting.addText(text =>
    text
      .setPlaceholder('rag-bench/runs/crag-unified')
      .setValue(configManager.get('cragUnifiedOutputDir'))
      .onChange(
        async value => await configManager.set('cragUnifiedOutputDir', value)
      )
  );

  const sampleSizeSetting = new Setting(container).setName('Sample size');
  renderMarkdownDesc(
    app,
    plugin,
    sampleSizeSetting.descEl,
    'Number of queries to process (`0` = all queries).'
  );
  sampleSizeSetting.addText(text =>
    text
      .setPlaceholder('0')
      .setValue(String(configManager.get('cragUnifiedSampleSize')))
      .onChange(async value => {
        const num = parseInt(value, 10);
        if (!isNaN(num) && num >= 0) {
          await configManager.set('cragUnifiedSampleSize', num);
        }
      })
  );

  const sampleOffsetSetting = new Setting(container).setName('Sample offset');
  renderMarkdownDesc(
    app,
    plugin,
    sampleOffsetSetting.descEl,
    'Number of queries to skip (for resuming from a specific point).'
  );
  sampleOffsetSetting.addText(text =>
    text
      .setPlaceholder('0')
      .setValue(String(configManager.get('cragUnifiedSampleOffset')))
      .onChange(async value => {
        const num = parseInt(value, 10);
        if (!isNaN(num) && num >= 0) {
          await configManager.set('cragUnifiedSampleOffset', num);
        }
      })
  );
}
