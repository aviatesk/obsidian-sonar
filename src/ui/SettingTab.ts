import {
  App,
  MarkdownRenderer,
  Notice,
  PluginSettingTab,
  Setting,
  normalizePath,
} from 'obsidian';
import { ConfigManager } from '../ConfigManager';
import type SonarPlugin from '../../main';
import { getIndexableFilesCount } from 'src/fileFilters';
import type { EmbedderBackend, AggregationMethod, LogLevel } from '../config';

export class SettingTab extends PluginSettingTab {
  plugin: SonarPlugin;
  statsDiv: HTMLDivElement | null = null;
  private configManager: ConfigManager;
  private configListeners: Array<() => void> = [];

  constructor(app: App, plugin: SonarPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.configManager = plugin.configManager;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.setupConfigListeners();

    this.createActionsSection(containerEl);
    this.createStatisticsSection(containerEl);
    this.createIndexConfigSection(containerEl);
    this.createUiPreferencesSection(containerEl);
    this.createChunkingConfigSection(containerEl);
    this.createEmbedderConfigSection(containerEl);
    this.createSearchParamsSection(containerEl);
    this.createLoggingConfigSection(containerEl);
    this.createBenchmarkConfigSection(containerEl);
    this.createDebugConfigSection(containerEl);
  }

  hide(): void {
    this.configListeners.forEach(unsubscribe => unsubscribe());
    this.configListeners = [];
  }

  private setupConfigListeners(): void {
    this.configListeners.forEach(unsubscribe => unsubscribe());
    this.configListeners = [];

    const handleStatsUpdate = async () => {
      await this.updateStats();
    };

    // Index configuration changes (indexable files change)
    this.configListeners.push(
      this.configManager.subscribe('indexPath', handleStatsUpdate)
    );
    this.configListeners.push(
      this.configManager.subscribe('excludedPaths', handleStatsUpdate)
    );
    // Embedder backend changes (database changes)
    this.configListeners.push(
      this.configManager.subscribe('embedderBackend', handleStatsUpdate)
    );
    this.configListeners.push(
      this.configManager.subscribe('tfjsEmbedderModel', handleStatsUpdate)
    );
    this.configListeners.push(
      this.configManager.subscribe('llamaEmbedderModelRepo', handleStatsUpdate)
    );
    this.configListeners.push(
      this.configManager.subscribe('llamaEmbedderModelFile', handleStatsUpdate)
    );
  }

  private renderMarkdownDesc(el: HTMLElement, markdown: string): void {
    MarkdownRenderer.render(this.app, markdown, el, '', this.plugin);
  }

  private createActionsSection(containerEl: HTMLElement): void {
    const actionsDetails = containerEl.createEl('details', {
      cls: 'sonar-settings-section',
    });
    actionsDetails.setAttr('open', '');
    actionsDetails.createEl('summary', { text: 'Actions' });
    const actionsContainer = actionsDetails.createDiv();

    let indexPath = `\`${this.configManager.get('indexPath')}\``;
    if (indexPath == '``') {
      indexPath = 'root (all files in this vault)';
    }

    const reinitializeSetting = new Setting(actionsContainer).setName(
      'Reinitialize Sonar'
    );
    this.renderMarkdownDesc(
      reinitializeSetting.descEl,
      'Reinitialize embedder backend (useful to reinitialize after updating configuration if the initialization failed for missing configuration etc.).'
    );
    reinitializeSetting.addButton(button =>
      button.setButtonText('Reinitialize').onClick(async () => {
        await this.plugin.reinitializeSonar();
      })
    );

    const syncSetting = new Setting(actionsContainer).setName(
      'Sync search index with vault'
    );
    this.renderMarkdownDesc(
      syncSetting.descEl,
      `Add missing files and remove deleted ones in: ${indexPath}`
    );
    syncSetting.addButton(button =>
      button.setButtonText('Sync').onClick(async () => {
        if (this.plugin.indexManager) {
          await this.plugin.indexManager.syncIndex();
          await this.updateStats();
        } else {
          new Notice('Index manager not initialized');
        }
      })
    );

    const rebuildSetting = new Setting(actionsContainer).setName(
      'Rebuild current search index'
    );
    this.renderMarkdownDesc(
      rebuildSetting.descEl,
      `Rebuild search index for all files in: ${indexPath}`
    );
    rebuildSetting.addButton(button =>
      button
        .setButtonText('Rebuild')
        .setWarning()
        .onClick(async () => {
          if (!this.plugin.indexManager) {
            new Notice('Index manager not initialized');
            return;
          }
          const confirmed = await this.configManager.confirmRebuildIndex(
            this.app
          );
          if (!confirmed) {
            return;
          }
          await this.plugin.indexManager.rebuildIndex(
            async (current, total, filePath) => {
              this.configManager.logger.log(
                `Rebuilding index: ${current}/${total} - ${filePath}`
              );
              if (current % 10 === 0) {
                await this.updateStats();
              }
            }
          );
          await this.updateStats();
        })
    );

    const clearCurrentSetting = new Setting(actionsContainer).setName(
      'Clear current search index'
    );
    this.renderMarkdownDesc(
      clearCurrentSetting.descEl,
      'Clear indexed data for current configuration'
    );
    clearCurrentSetting.addButton(button =>
      button
        .setButtonText('Clear')
        .setWarning()
        .onClick(async () => {
          if (!this.plugin.indexManager) {
            new Notice('Index manager not initialized');
            return;
          }
          const confirmed = await this.configManager.confirmClearCurrentIndex(
            this.app
          );
          if (!confirmed) {
            return;
          }
          await this.plugin.indexManager.clearCurrentIndex();
          new Notice('Current index cleared');
          await this.updateStats();
        })
    );

    const deleteAllSetting = new Setting(actionsContainer).setName(
      'Delete all search databases for this vault'
    );
    this.renderMarkdownDesc(
      deleteAllSetting.descEl,
      'Delete all search databases for all embedders and models used in this vault.'
    );
    deleteAllSetting.addButton(button =>
      button
        .setButtonText('Delete All')
        .setWarning()
        .onClick(async () => {
          await this.plugin.deleteAllVaultDatabases();
          await this.updateStats();
        })
    );
  }

  private createStatisticsSection(containerEl: HTMLElement): void {
    const statsDetails = containerEl.createEl('details', {
      cls: 'sonar-settings-section',
    });
    statsDetails.setAttr('open', '');
    statsDetails.createEl('summary', { text: 'Statistics' });
    const statsContainer = statsDetails.createDiv();
    const statsDiv = statsContainer.createDiv({
      cls: 'sonar-stats-in-settings',
    });
    this.statsDiv = statsDiv;
    this.updateStats();
  }

  private createIndexConfigSection(containerEl: HTMLElement): void {
    const indexConfigDetails = containerEl.createEl('details', {
      cls: 'sonar-settings-section',
    });
    indexConfigDetails.setAttr('open', '');
    indexConfigDetails.createEl('summary', { text: 'Index configuration' });
    const indexConfigContainer = indexConfigDetails.createDiv();

    const indexPathSetting = new Setting(indexConfigContainer).setName(
      'Index path'
    );
    this.renderMarkdownDesc(
      indexPathSetting.descEl,
      'Path to index (leave it empty for indexing entire vault, or specify a folder like `/Notes`).'
    );
    indexPathSetting.addText(text =>
      text
        .setPlaceholder('')
        .setValue(this.configManager.get('indexPath'))
        .onChange(async value => {
          const normalized = value ? normalizePath(value) : '';
          await this.configManager.set('indexPath', normalized);
        })
    );

    const excludedPathsSetting = new Setting(indexConfigContainer).setName(
      'Excluded paths'
    );
    this.renderMarkdownDesc(
      excludedPathsSetting.descEl,
      `Paths to ignore during indexing (one per line).
Supports:
- Folder names (e.g., \`Archive\`)
- Relative paths (e.g., \`Daily Notes/2023\`)
- Glob patterns (e.g., \`**/*.tmp\`, \`**/test/**\`)`
    );
    excludedPathsSetting.addTextArea(text => {
      text
        .setPlaceholder('Archive\nDaily Notes\n**/*.tmp\n**/test/**')
        .setValue((this.configManager.get('excludedPaths') || []).join('\n'))
        .onChange(async value => {
          const paths = value
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(path => normalizePath(path));
          await this.configManager.set('excludedPaths', paths);
        });
      text.inputEl.rows = 5;
      text.inputEl.cols = 50;
    });

    const indexingBatchSetting = new Setting(indexConfigContainer).setName(
      'Indexing batch size'
    );
    this.renderMarkdownDesc(
      indexingBatchSetting.descEl,
      `Number of texts (titles + chunks) to process in a single batch during indexing (default: \`32\`).
- Larger values: process more texts at once but use more memory.
- Smaller values: reduce memory usage but increase the number of calls to the embedder.

> [!WARNING]: This setting only applies to llama.cpp backend. Transformers.js always processes texts sequentially to avoid NaN embeddings.`
    );
    indexingBatchSetting.addSlider(slider =>
      slider
        .setLimits(1, 128, 1)
        .setValue(this.configManager.get('indexingBatchSize'))
        .setDynamicTooltip()
        .onChange(async value => {
          await this.configManager.set('indexingBatchSize', value);
        })
    );

    const updateIndexingBatchVisibility = () => {
      const backend = this.configManager.get('embedderBackend');
      indexingBatchSetting.settingEl.style.display =
        backend === 'llamacpp' ? '' : 'none';
    };
    updateIndexingBatchVisibility();
    this.configListeners.push(
      this.configManager.subscribe('embedderBackend', () => {
        updateIndexingBatchVisibility();
      })
    );

    const autoIndexSetting = new Setting(indexConfigContainer).setName(
      'Enable auto-indexing'
    );
    this.renderMarkdownDesc(
      autoIndexSetting.descEl,
      'Automatically index files when they are created, modified, or deleted.'
    );
    autoIndexSetting.addToggle(toggle =>
      toggle
        .setValue(this.configManager.get('autoIndex'))
        .onChange(async value => {
          await this.configManager.set('autoIndex', value);
        })
    );
  }

  private createUiPreferencesSection(containerEl: HTMLElement): void {
    const uiPreferencesDetails = containerEl.createEl('details', {
      cls: 'sonar-settings-section',
    });
    uiPreferencesDetails.setAttr('open', '');
    uiPreferencesDetails.createEl('summary', { text: 'UI preferences' });
    const uiPreferencesContainer = uiPreferencesDetails.createDiv();

    const autoOpenSetting = new Setting(uiPreferencesContainer).setName(
      'Auto-open related notes view'
    );
    this.renderMarkdownDesc(
      autoOpenSetting.descEl,
      'Automatically open the related notes view on startup.'
    );
    autoOpenSetting.addToggle(toggle =>
      toggle
        .setValue(this.configManager.get('autoOpenRelatedNotes'))
        .onChange(async value => {
          await this.configManager.set('autoOpenRelatedNotes', value);
        })
    );

    const showQuerySetting = new Setting(uiPreferencesContainer).setName(
      'Show related notes query'
    );
    this.renderMarkdownDesc(
      showQuerySetting.descEl,
      'Display the search query in the related notes view.'
    );
    showQuerySetting.addToggle(toggle =>
      toggle
        .setValue(this.configManager.get('showRelatedNotesQuery'))
        .onChange(async value => {
          await this.configManager.set('showRelatedNotesQuery', value);
        })
    );

    const showExcerptsSetting = new Setting(uiPreferencesContainer).setName(
      'Show related notes excerpts'
    );
    this.renderMarkdownDesc(
      showExcerptsSetting.descEl,
      'Display text excerpts in the related notes view.'
    );
    showExcerptsSetting.addToggle(toggle =>
      toggle
        .setValue(this.configManager.get('showRelatedNotesExcerpts'))
        .onChange(async value => {
          await this.configManager.set('showRelatedNotesExcerpts', value);
        })
    );

    const showGraphSetting = new Setting(uiPreferencesContainer).setName(
      'Show knowledge graph'
    );
    this.renderMarkdownDesc(
      showGraphSetting.descEl,
      'Display the knowledge graph visualization.'
    );
    showGraphSetting.addToggle(toggle =>
      toggle
        .setValue(this.configManager.get('showKnowledgeGraph'))
        .onChange(async value => {
          await this.configManager.set('showKnowledgeGraph', value);
        })
    );

    const searchResultsSetting = new Setting(uiPreferencesContainer).setName(
      'Search results count'
    );
    this.renderMarkdownDesc(
      searchResultsSetting.descEl,
      `Number of final documents to return (default: \`10\`).

This is the final number after chunk aggregation:
- Larger values: more related notes shown, but may include less relevant results.
- Smaller values: only top matches shown.`
    );
    searchResultsSetting.addSlider(slider =>
      slider
        .setLimits(1, 20, 1)
        .setValue(this.configManager.get('searchResultsCount'))
        .setDynamicTooltip()
        .onChange(async value => {
          await this.configManager.set('searchResultsCount', value);
        })
    );

    const debounceSetting = new Setting(uiPreferencesContainer).setName(
      'Related notes update delay'
    );
    this.renderMarkdownDesc(
      debounceSetting.descEl,
      'Delay in milliseconds before updating related notes view after typing (default: `5000`ms = 5s).'
    );
    debounceSetting.addSlider(slider =>
      slider
        .setLimits(500, 10000, 500)
        .setValue(this.configManager.get('relatedNotesDebounceMs'))
        .setDynamicTooltip()
        .onChange(async value => {
          await this.configManager.set('relatedNotesDebounceMs', value);
        })
    );
  }

  private createChunkingConfigSection(containerEl: HTMLElement): void {
    const chunkingConfigDetails = containerEl.createEl('details', {
      cls: 'sonar-settings-section',
    });
    chunkingConfigDetails.createEl('summary', {
      text: 'Chunking configuration',
    });
    const chunkingConfigContainer = chunkingConfigDetails.createDiv();

    const maxChunkSizeSetting = new Setting(chunkingConfigContainer).setName(
      'Max chunk size'
    );
    this.renderMarkdownDesc(
      maxChunkSizeSetting.descEl,
      `Maximum tokens per chunk (recommended: \`512\`).
- Larger values: more context per chunk, better for understanding broader topics.
- Smaller values*: more granular chunks, better for precise keyword matching.`
    );
    maxChunkSizeSetting.addSlider(slider =>
      slider
        .setLimits(64, 2048, 64)
        .setValue(this.configManager.get('maxChunkSize'))
        .setDynamicTooltip()
        .onChange(async value => {
          await this.configManager.set('maxChunkSize', value);
        })
    );

    const chunkOverlapSetting = new Setting(chunkingConfigContainer).setName(
      'Chunk overlap'
    );
    this.renderMarkdownDesc(
      chunkOverlapSetting.descEl,
      `Number of overlapping tokens between consecutive chunks (recommended: \`64\`, ~10% of chunk size).
- Larger values: less context lost at chunk boundaries, but larger index size.
- Smaller values: smaller index, but potentially fragmented context.`
    );
    chunkOverlapSetting.addSlider(slider =>
      slider
        .setLimits(0, 256, 8)
        .setValue(this.configManager.get('chunkOverlap'))
        .setDynamicTooltip()
        .onChange(async value => {
          await this.configManager.set('chunkOverlap', value);
        })
    );
  }

  private createEmbedderConfigSection(containerEl: HTMLElement): void {
    const embedderDetails = containerEl.createEl('details', {
      cls: 'sonar-settings-section',
    });
    embedderDetails.setAttr('open', '');
    embedderDetails.createEl('summary', { text: 'Embedder configuration' });
    const embedderContainer = embedderDetails.createDiv();

    const embedderBackendSetting = new Setting(embedderContainer).setName(
      'Embedder backend'
    );
    this.renderMarkdownDesc(
      embedderBackendSetting.descEl,
      'Choose embedding backend (Transformers.js or llama.cpp).'
    );

    let transformersSettings: HTMLElement;
    let llamacppSettings: HTMLElement;

    const updateVisibility = (backendType: EmbedderBackend) => {
      if (backendType === 'transformers') {
        transformersSettings.style.display = '';
        llamacppSettings.style.display = 'none';
      } else {
        transformersSettings.style.display = 'none';
        llamacppSettings.style.display = '';
      }
    };

    embedderBackendSetting.addDropdown(dropdown =>
      dropdown
        .addOption('transformers', 'Transformers.js')
        .addOption('llamacpp', 'llama.cpp')
        .setValue(this.configManager.get('embedderBackend'))
        .onChange(async value => {
          await this.configManager.set(
            'embedderBackend',
            value as EmbedderBackend
          );
          updateVisibility(value as EmbedderBackend);
        })
    );

    // Transformers.js settings
    transformersSettings = embedderContainer.createDiv();
    const transformersHeader = transformersSettings.createEl('h4', {
      text: 'Transformers.js configuration',
    });
    transformersHeader.style.marginTop = '1em';
    transformersHeader.style.marginBottom = '0.5em';

    const embeddingModelSetting = new Setting(transformersSettings).setName(
      'Embedding model'
    );
    this.renderMarkdownDesc(
      embeddingModelSetting.descEl,
      'HuggingFace model ID for Transformers.js (e.g., `Xenova/multilingual-e5-small`).'
    );
    embeddingModelSetting.addText(text =>
      text
        .setPlaceholder('Xenova/multilingual-e5-small')
        .setValue(this.configManager.get('tfjsEmbedderModel'))
        .onChange(async value => {
          await this.configManager.set('tfjsEmbedderModel', value);
        })
    );

    // llama.cpp settings
    llamacppSettings = embedderContainer.createDiv();
    const llamacppHeader = llamacppSettings.createEl('h4', {
      text: 'llama.cpp configuration',
    });
    llamacppHeader.style.marginTop = '1em';
    llamacppHeader.style.marginBottom = '0.5em';

    const llamacppServerPathSetting = new Setting(llamacppSettings).setName(
      'Server path'
    );
    this.renderMarkdownDesc(
      llamacppServerPathSetting.descEl,
      'Path to llama.cpp server binary (e.g., `llama-server` or `/path/to/llama-server`).'
    );
    llamacppServerPathSetting.addText(text =>
      text
        .setPlaceholder('llama-server')
        .setValue(this.configManager.get('llamacppServerPath'))
        .onChange(async value => {
          await this.configManager.set('llamacppServerPath', value);
        })
    );

    const llamacppModelRepoSetting = new Setting(llamacppSettings).setName(
      'Model repository'
    );
    this.renderMarkdownDesc(
      llamacppModelRepoSetting.descEl,
      'HuggingFace repository for llama.cpp model (e.g., `BAAI/bge-m3-gguf`).'
    );
    llamacppModelRepoSetting.addText(text =>
      text
        .setPlaceholder('BAAI/bge-m3-gguf')
        .setValue(this.configManager.get('llamaEmbedderModelRepo'))
        .onChange(async value => {
          await this.configManager.set('llamaEmbedderModelRepo', value);
        })
    );

    const llamacppModelFileSetting = new Setting(llamacppSettings).setName(
      'Model file'
    );
    this.renderMarkdownDesc(
      llamacppModelFileSetting.descEl,
      'GGUF filename in the repository (e.g., `bge-m3-q8_0.gguf`).'
    );
    llamacppModelFileSetting.addText(text =>
      text
        .setPlaceholder('bge-m3-q8_0.gguf')
        .setValue(this.configManager.get('llamaEmbedderModelFile'))
        .onChange(async value => {
          await this.configManager.set('llamaEmbedderModelFile', value);
        })
    );

    updateVisibility(this.configManager.get('embedderBackend'));
  }

  private createSearchParamsSection(containerEl: HTMLElement): void {
    const searchParamsDetails = containerEl.createEl('details', {
      cls: 'sonar-settings-section',
    });
    searchParamsDetails.createEl('summary', { text: 'Search parameters' });
    const searchParamsContainer = searchParamsDetails.createDiv();

    const queryTokensSetting = new Setting(searchParamsContainer).setName(
      'Search query tokens'
    );
    this.renderMarkdownDesc(
      queryTokensSetting.descEl,
      `Maximum number of tokens for search queries (recommended: \`128\`).

Queries are constructed from the current note filename and content:
- Larger values: more and broader context in queries, slower embedding.
- Smaller values: faster queries, less and focused context.`
    );
    queryTokensSetting.addSlider(slider =>
      slider
        .setLimits(32, 512, 16)
        .setValue(this.configManager.get('maxQueryTokens'))
        .setDynamicTooltip()
        .onChange(async value => {
          await this.configManager.set('maxQueryTokens', value);
        })
    );

    const bm25Setting = new Setting(searchParamsContainer).setName(
      'BM25 aggregation method'
    );
    this.renderMarkdownDesc(
      bm25Setting.descEl,
      `Method for aggregating BM25 scores across chunks within a document:
- \`max_p\` (default): uses highest chunk score, best for keyword-dominant queries.
- \`top_m_sum\`: sums top M chunks, balances precision and recall.
- \`top_m_avg\`: averages top M chunks, length-normalized.
- \`rrf_per_doc\`: RRF-style scoring, no score normalization needed.
- \`weighted_top_l_sum\`: weighted sum with exponential decay, prioritizes top chunks while incorporating context.`
    );
    bm25Setting.addDropdown(dropdown =>
      dropdown
        .addOption('max_p', 'Max Passage (max_p)')
        .addOption('top_m_sum', 'Top M Sum')
        .addOption('top_m_avg', 'Top M Average')
        .addOption('rrf_per_doc', 'RRF per Document')
        .addOption('weighted_top_l_sum', 'Weighted Top L Sum')
        .setValue(this.configManager.get('bm25AggMethod'))
        .onChange(async value => {
          await this.configManager.set(
            'bm25AggMethod',
            value as AggregationMethod
          );
        })
    );

    const vectorSetting = new Setting(searchParamsContainer).setName(
      'Vector aggregation method'
    );
    this.renderMarkdownDesc(
      vectorSetting.descEl,
      `Method for aggregating vector similarity scores across chunks:
- \`max_p\`: uses highest chunk score, best for focused semantic matches.
- \`top_m_sum\`: sums top M chunks, captures distributed semantic evidence.
- \`top_m_avg\`: averages top M chunks.
- \`rrf_per_doc\`: RRF-style scoring.
- \`weighted_top_l_sum\` (default): weighted sum with decay, best for balancing precision with contextual relevance.`
    );
    vectorSetting.addDropdown(dropdown =>
      dropdown
        .addOption('max_p', 'Max Passage (max_p)')
        .addOption('top_m_sum', 'Top M Sum')
        .addOption('top_m_avg', 'Top M Average')
        .addOption('rrf_per_doc', 'RRF per Document')
        .addOption('weighted_top_l_sum', 'Weighted Top L Sum')
        .setValue(this.configManager.get('vectorAggMethod'))
        .onChange(async value => {
          await this.configManager.set(
            'vectorAggMethod',
            value as AggregationMethod
          );
        })
    );

    const aggMSetting = new Setting(searchParamsContainer).setName(
      'Aggregation M'
    );
    this.renderMarkdownDesc(
      aggMSetting.descEl,
      `Number of top chunks for \`top_m_sum\`/\`top_m_avg\` methods (default: \`3\`):
- Larger values: considers more chunks, captures broader evidence but may dilute precision.
- Smaller values: focuses on best matches only.`
    );
    aggMSetting.addSlider(slider =>
      slider
        .setLimits(1, 10, 1)
        .setValue(this.configManager.get('aggM'))
        .setDynamicTooltip()
        .onChange(async value => {
          await this.configManager.set('aggM', value);
        })
    );

    const aggLSetting = new Setting(searchParamsContainer).setName(
      'Aggregation L'
    );
    this.renderMarkdownDesc(
      aggLSetting.descEl,
      `Number of top chunks for \`weighted_top_l_sum\` method (default: \`3\`).
- Larger values: includes more chunks with decreasing weights, captures more context.
- Smaller values: focuses on top chunks only.`
    );
    aggLSetting.addSlider(slider =>
      slider
        .setLimits(1, 10, 1)
        .setValue(this.configManager.get('aggL'))
        .setDynamicTooltip()
        .onChange(async value => {
          await this.configManager.set('aggL', value);
        })
    );

    const aggDecaySetting = new Setting(searchParamsContainer).setName(
      'Aggregation decay'
    );
    this.renderMarkdownDesc(
      aggDecaySetting.descEl,
      `Decay factor for \`weighted_top_l_sum\` method (default: \`0.95\`).

Formula: \`w_i = decay^i\` for i-th chunk:
- Larger values (closer to \`1.0\`): slower decay, lower-ranked chunks contribute more.
- Smaller values (closer to \`0.5\`): faster decay, heavily prioritizes top chunk.`
    );
    aggDecaySetting.addSlider(slider =>
      slider
        .setLimits(0.5, 1.0, 0.01)
        .setValue(this.configManager.get('aggDecay'))
        .setDynamicTooltip()
        .onChange(async value => {
          await this.configManager.set('aggDecay', value);
        })
    );

    const aggRrfKSetting = new Setting(searchParamsContainer).setName(
      'RRF k parameter'
    );
    this.renderMarkdownDesc(
      aggRrfKSetting.descEl,
      `k parameter for \`rrf_per_doc\` method (default: \`60\`).

Formula: \`score = sum(1/(k + rank))\`:
- Larger \`k\`: flattens rank differences, makes lower ranks contribute more.
- Smaller \`k\`: amplifies rank differences, prioritizes top chunks.`
    );
    aggRrfKSetting.addSlider(slider =>
      slider
        .setLimits(1, 100, 1)
        .setValue(this.configManager.get('aggRrfK'))
        .setDynamicTooltip()
        .onChange(async value => {
          await this.configManager.set('aggRrfK', value);
        })
    );

    const retrievalMultiplierSetting = new Setting(
      searchParamsContainer
    ).setName('Retrieval multiplier');
    this.renderMarkdownDesc(
      retrievalMultiplierSetting.descEl,
      `Multiplier for candidate retrieval (default: \`10\`).

Used in two contexts:
- **Hybrid search**: limits embedding and BM25 results to \`top_k * multiplier\` before RRF fusion.
- **Reranking**: retrieves \`top_k * multiplier\` initial results before reranking. Larger values increase latency.

Larger values increase recall but may add noise; smaller values focus on high-quality results.`
    );
    retrievalMultiplierSetting.addSlider(slider =>
      slider
        .setLimits(1, 50, 1)
        .setValue(this.configManager.get('retrievalMultiplier'))
        .setDynamicTooltip()
        .onChange(async value => {
          await this.configManager.set('retrievalMultiplier', value);
        })
    );
  }

  private createLoggingConfigSection(containerEl: HTMLElement): void {
    const loggingDetails = containerEl.createEl('details', {
      cls: 'sonar-settings-section',
    });
    loggingDetails.createEl('summary', { text: 'Logging configuration' });
    const loggingContainer = loggingDetails.createDiv();

    const statusBarSetting = new Setting(loggingContainer).setName(
      'Status bar max length'
    );
    this.renderMarkdownDesc(
      statusBarSetting.descEl,
      'Maximum number of characters in status bar (default: `40`, `0` = no limit).'
    );
    statusBarSetting.addSlider(slider =>
      slider
        .setLimits(0, 100, 5)
        .setValue(this.configManager.get('statusBarMaxLength'))
        .setDynamicTooltip()
        .onChange(async value => {
          await this.configManager.set('statusBarMaxLength', value);
        })
    );

    const showBackendSetting = new Setting(loggingContainer).setName(
      'Show backend in status bar'
    );
    this.renderMarkdownDesc(
      showBackendSetting.descEl,
      'Display embedder backend in status bar (e.g., `Sonar (llama): Ready`).'
    );
    showBackendSetting.addToggle(toggle =>
      toggle
        .setValue(this.configManager.get('showBackendInStatusBar'))
        .onChange(async value => {
          await this.configManager.set('showBackendInStatusBar', value);
        })
    );

    const logLevelSetting = new Setting(loggingContainer).setName('Log level');
    this.renderMarkdownDesc(logLevelSetting.descEl, 'Set logging verbosity.');
    logLevelSetting.addDropdown(dropdown =>
      dropdown
        .addOption('error', 'Error only')
        .addOption('warn', 'Warn + Error')
        .addOption('log', 'Log + Warn + Error')
        .addOption('verbose', 'Verbose message + Log + Warn + Error')
        .setValue(this.configManager.get('debugMode'))
        .onChange(async value => {
          await this.configManager.set('debugMode', value as LogLevel);
        })
    );
  }

  private createBenchmarkConfigSection(containerEl: HTMLElement): void {
    const benchmarkDetails = containerEl.createEl('details', {
      cls: 'sonar-settings-section',
    });
    benchmarkDetails.createEl('summary', { text: 'Benchmark configuration' });
    const benchmarkContainer = benchmarkDetails.createDiv();

    const queriesPathSetting = new Setting(benchmarkContainer).setName(
      'Benchmark queries path'
    );
    this.renderMarkdownDesc(
      queriesPathSetting.descEl,
      'Path to `queries.jsonl` file for benchmarks. Can be absolute or relative to vault root.'
    );
    queriesPathSetting.addText(text =>
      text
        .setPlaceholder(
          'bench/queries.jsonl or /absolute/path/to/queries.jsonl'
        )
        .setValue(this.configManager.get('benchmarkQueriesPath'))
        .onChange(async value => {
          await this.configManager.set('benchmarkQueriesPath', value);
        })
    );

    const qrelsPathSetting = new Setting(benchmarkContainer).setName(
      'Benchmark qrels path'
    );
    this.renderMarkdownDesc(
      qrelsPathSetting.descEl,
      'Path to `qrels.tsv` file for benchmarks. Can be absolute or relative to vault root.'
    );
    qrelsPathSetting.addText(text =>
      text
        .setPlaceholder('bench/qrels.tsv or /absolute/path/to/qrels.tsv')
        .setValue(this.configManager.get('benchmarkQrelsPath'))
        .onChange(async value => {
          await this.configManager.set('benchmarkQrelsPath', value);
        })
    );

    const outputDirSetting = new Setting(benchmarkContainer).setName(
      'Benchmark output directory'
    );
    this.renderMarkdownDesc(
      outputDirSetting.descEl,
      'Path to directory for TREC output files. Can be absolute or relative to vault root.'
    );
    outputDirSetting.addText(text =>
      text
        .setPlaceholder('bench/output or /absolute/path/to/output')
        .setValue(this.configManager.get('benchmarkOutputDir'))
        .onChange(async value => {
          await this.configManager.set('benchmarkOutputDir', value);
        })
    );

    const topKSetting = new Setting(benchmarkContainer).setName(
      'Benchmark top K'
    );
    this.renderMarkdownDesc(
      topKSetting.descEl,
      'Number of documents to return for benchmarks (default: `100`).'
    );
    topKSetting.addSlider(slider =>
      slider
        .setLimits(10, 1000, 10)
        .setValue(this.configManager.get('benchmarkTopK'))
        .setDynamicTooltip()
        .onChange(async value => {
          await this.configManager.set('benchmarkTopK', value);
        })
    );
  }

  private createDebugConfigSection(containerEl: HTMLElement): void {
    const debugDetails = containerEl.createEl('details', {
      cls: 'sonar-settings-section',
    });
    debugDetails.createEl('summary', { text: 'Debug configuration' });
    const debugContainer = debugDetails.createDiv();

    const debugPathSetting = new Setting(debugContainer).setName(
      'Debug samples path'
    );
    this.renderMarkdownDesc(
      debugPathSetting.descEl,
      'Absolute path to debug samples directory (default: `bench/debug`).'
    );
    debugPathSetting.addText(text =>
      text
        .setPlaceholder('/path/to/debug')
        .setValue(this.configManager.get('debugSamplesPath'))
        .onChange(async value => {
          await this.configManager.set('debugSamplesPath', value);
        })
    );
  }

  async updateStats() {
    if (!this.statsDiv || !this.plugin.indexManager) return;

    const indexableCount = getIndexableFilesCount(
      this.plugin.app.vault,
      this.plugin.configManager
    );
    let stats;
    try {
      stats = await this.plugin.indexManager.getStats();
    } catch (err) {
      this.configManager.getLogger().error(`Failed to get stats: ${err}`);
      this.statsDiv.empty();
      this.statsDiv.createEl('p', { text: 'Stats unavailable' });
      return;
    }
    this.statsDiv.empty();
    this.statsDiv.createEl('p', {
      text: `Files indexed: ${stats.totalFiles} / ${indexableCount}`,
    });
    this.statsDiv.createEl('p', {
      text: `Total chunks: ${stats.totalChunks}`,
    });
    this.statsDiv.createEl('p', {
      text: `Index path: ${this.configManager.get('indexPath')}`,
    });
  }
}
