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

export function createRetrievalBenchmarkSettings(
  app: App,
  plugin: SonarPlugin,
  containerEl: HTMLElement,
  configManager: ConfigManager
): void {
  const benchmarkDetails = containerEl.createEl('details', {
    cls: 'sonar-settings-section',
  });
  benchmarkDetails.createEl('summary', { text: 'Retrieval benchmark' });
  const benchmarkContainer = benchmarkDetails.createDiv();

  const queriesPathSetting = new Setting(benchmarkContainer).setName(
    'Benchmark queries path'
  );
  renderMarkdownDesc(
    app,
    plugin,
    queriesPathSetting.descEl,
    'Path to `queries.jsonl` file for benchmarks. Can be absolute or relative to vault root.'
  );
  queriesPathSetting.addText(text =>
    text
      .setPlaceholder(
        'retrieval-bench/queries.jsonl or /absolute/path/to/queries.jsonl'
      )
      .setValue(configManager.get('benchmarkQueriesPath'))
      .onChange(
        async value => await configManager.set('benchmarkQueriesPath', value)
      )
  );

  const qrelsPathSetting = new Setting(benchmarkContainer).setName(
    'Benchmark qrels path'
  );
  renderMarkdownDesc(
    app,
    plugin,
    qrelsPathSetting.descEl,
    'Path to `qrels.tsv` file for benchmarks. Can be absolute or relative to vault root.'
  );
  qrelsPathSetting.addText(text =>
    text
      .setPlaceholder('retrieval-bench/qrels.tsv or /absolute/path/to/qrels.tsv')
      .setValue(configManager.get('benchmarkQrelsPath'))
      .onChange(
        async value => await configManager.set('benchmarkQrelsPath', value)
      )
  );

  const outputDirSetting = new Setting(benchmarkContainer).setName(
    'Benchmark output directory'
  );
  renderMarkdownDesc(
    app,
    plugin,
    outputDirSetting.descEl,
    'Path to directory for TREC output files. Can be absolute or relative to vault root.'
  );
  outputDirSetting.addText(text =>
    text
      .setPlaceholder('retrieval-bench/output or /absolute/path/to/output')
      .setValue(configManager.get('benchmarkOutputDir'))
      .onChange(
        async value => await configManager.set('benchmarkOutputDir', value)
      )
  );

  const topKSetting = new Setting(benchmarkContainer).setName('Benchmark top K');
  renderMarkdownDesc(
    app,
    plugin,
    topKSetting.descEl,
    'Number of documents to return for benchmarks (default: `100`).'
  );
  topKSetting.addSlider(slider =>
    slider
      .setLimits(10, 1000, 10)
      .setValue(configManager.get('benchmarkTopK'))
      .setDynamicTooltip()
      .onChange(
        async value => await configManager.set('benchmarkTopK', value)
      )
  );
}
