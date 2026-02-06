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
import type { AggregationMethod, LogLevel } from '../config';
import { FolderSuggestInput } from '../obsidian-utils';

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
    this.createLlamaCppConfigSection(containerEl);
    this.createIndexConfigSection(containerEl);
    this.createAudioConfigSection(containerEl);
    this.createUiPreferencesSection(containerEl);
    this.createChatConfigSection(containerEl);
    this.createChunkingConfigSection(containerEl);
    this.createSearchParamsSection(containerEl);
    this.createLoggingConfigSection(containerEl);

    // Benchmark settings are only available in development builds
    if (process.env.INCLUDE_BENCHMARK === 'true') {
      this.createBenchmarkConfigSection(containerEl);
    }
  }

  private async createBenchmarkConfigSection(
    containerEl: HTMLElement
  ): Promise<void> {
    const { createRetrievalBenchmarkSettings } =
      await import('../../retrieval-bench/src/settings');
    const { createCragBenchmarkSettings, createCragUnifiedBenchmarkSettings } =
      await import('../../rag-bench/src/settings');
    createRetrievalBenchmarkSettings(
      this.app,
      this.plugin,
      containerEl,
      this.configManager
    );
    createCragBenchmarkSettings(
      this.app,
      this.plugin,
      containerEl,
      this.configManager
    );
    createCragUnifiedBenchmarkSettings(
      this.app,
      this.plugin,
      containerEl,
      this.configManager
    );
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
    // Embedder model changes (database changes)
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
      'Restart all llama.cpp servers (embedder, reranker, chat). Use this after changing model settings or server path.'
    );
    reinitializeSetting.addButton(button =>
      button
        .setButtonText('Reinitialize')
        .onClick(async () => await this.plugin.reinitializeSonar())
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

    new Setting(statsContainer).addButton(button =>
      button.setButtonText('Copy').onClick(async () => {
        const statsText = this.getStatsText();
        if (statsText) {
          await navigator.clipboard.writeText(statsText);
          new Notice('Statistics copied to clipboard');
        }
      })
    );
  }

  private getStatsText(): string | null {
    if (!this.statsDiv) return null;
    const lines: string[] = [];
    this.statsDiv.querySelectorAll('p').forEach(p => {
      lines.push(p.textContent ?? '');
    });
    return lines.join('\n');
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
      `Paths to ignore during indexing.
Supports:
- Folder names (e.g., \`Archive\`)
- Relative paths (e.g., \`Daily Notes/2023\`)
- Glob patterns (e.g., \`**/*.tmp\`, \`**/test/**\`)`
    );
    const excludedPathsContainer = indexConfigContainer.createDiv({
      cls: 'sonar-excluded-paths-list',
    });
    this.renderExcludedPaths(excludedPathsContainer);

    const indexingBatchSetting = new Setting(indexConfigContainer).setName(
      'Indexing batch size'
    );
    this.renderMarkdownDesc(
      indexingBatchSetting.descEl,
      `Number of texts (titles + chunks) to process in a single batch during indexing (default: \`32\`).
- Larger values: process more texts at once but use more memory.
- Smaller values: reduce memory usage but increase the number of calls to the embedder.`
    );
    indexingBatchSetting.addSlider(slider =>
      slider
        .setLimits(1, 128, 1)
        .setValue(this.configManager.get('indexingBatchSize'))
        .setDynamicTooltip()
        .onChange(
          async value =>
            await this.configManager.set('indexingBatchSize', value)
        )
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
        .onChange(
          async value => await this.configManager.set('autoIndex', value)
        )
    );
  }

  private createUiPreferencesSection(containerEl: HTMLElement): void {
    const uiPreferencesDetails = containerEl.createEl('details', {
      cls: 'sonar-settings-section',
    });
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
        .onChange(
          async value =>
            await this.configManager.set('autoOpenRelatedNotes', value)
        )
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
        .onChange(
          async value =>
            await this.configManager.set('showRelatedNotesQuery', value)
        )
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
        .onChange(
          async value =>
            await this.configManager.set('showRelatedNotesExcerpts', value)
        )
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
        .onChange(
          async value =>
            await this.configManager.set('showKnowledgeGraph', value)
        )
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
        .onChange(
          async value =>
            await this.configManager.set('searchResultsCount', value)
        )
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
        .onChange(
          async value =>
            await this.configManager.set('relatedNotesDebounceMs', value)
        )
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
        .onChange(
          async value => await this.configManager.set('maxChunkSize', value)
        )
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
        .onChange(
          async value => await this.configManager.set('chunkOverlap', value)
        )
    );
  }

  private createLlamaCppConfigSection(containerEl: HTMLElement): void {
    const llamacppDetails = containerEl.createEl('details', {
      cls: 'sonar-settings-section',
    });
    llamacppDetails.setAttr('open', '');
    llamacppDetails.createEl('summary', {
      text: 'llama.cpp configuration',
    });
    const llamacppContainer = llamacppDetails.createDiv();

    const llamacppServerPathSetting = new Setting(llamacppContainer).setName(
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
        .onChange(
          async value =>
            await this.configManager.set('llamacppServerPath', value)
        )
    );

    llamacppContainer.createEl('h4', { text: 'Embedder model' });

    const llamacppModelRepoSetting = new Setting(llamacppContainer).setName(
      'Model repository'
    );
    this.renderMarkdownDesc(
      llamacppModelRepoSetting.descEl,
      'HuggingFace repository for embedder model (e.g., `ggml-org/bge-m3-Q8_0-GGUF`).'
    );
    llamacppModelRepoSetting.addText(text =>
      text
        .setPlaceholder('ggml-org/bge-m3-Q8_0-GGUF')
        .setValue(this.configManager.get('llamaEmbedderModelRepo'))
        .onChange(
          async value =>
            await this.configManager.set('llamaEmbedderModelRepo', value)
        )
    );

    const llamacppModelFileSetting = new Setting(llamacppContainer).setName(
      'Model file'
    );
    this.renderMarkdownDesc(
      llamacppModelFileSetting.descEl,
      'GGUF filename for embedder model (e.g., `bge-m3-q8_0.gguf`).'
    );
    llamacppModelFileSetting.addText(text =>
      text
        .setPlaceholder('bge-m3-q8_0.gguf')
        .setValue(this.configManager.get('llamaEmbedderModelFile'))
        .onChange(
          async value =>
            await this.configManager.set('llamaEmbedderModelFile', value)
        )
    );

    llamacppContainer.createEl('h4', { text: 'Reranker model' });

    const rerankerModelRepoSetting = new Setting(llamacppContainer).setName(
      'Model repository'
    );
    this.renderMarkdownDesc(
      rerankerModelRepoSetting.descEl,
      'HuggingFace repository for reranker model (e.g., `gpustack/bge-reranker-v2-m3-GGUF`).'
    );
    rerankerModelRepoSetting.addText(text =>
      text
        .setPlaceholder('gpustack/bge-reranker-v2-m3-GGUF')
        .setValue(this.configManager.get('llamaRerankerModelRepo'))
        .onChange(
          async value =>
            await this.configManager.set('llamaRerankerModelRepo', value)
        )
    );

    const rerankerModelFileSetting = new Setting(llamacppContainer).setName(
      'Model file'
    );
    this.renderMarkdownDesc(
      rerankerModelFileSetting.descEl,
      'GGUF filename for reranker model (e.g., `bge-reranker-v2-m3-Q8_0.gguf`).'
    );
    rerankerModelFileSetting.addText(text =>
      text
        .setPlaceholder('bge-reranker-v2-m3-Q8_0.gguf')
        .setValue(this.configManager.get('llamaRerankerModelFile'))
        .onChange(
          async value =>
            await this.configManager.set('llamaRerankerModelFile', value)
        )
    );

    llamacppContainer.createEl('h4', { text: 'Chat model' });

    const chatModelRepoSetting = new Setting(llamacppContainer).setName(
      'Model repository'
    );
    this.renderMarkdownDesc(
      chatModelRepoSetting.descEl,
      'HuggingFace repository for chat model (e.g., `Qwen/Qwen3-8B-GGUF`).'
    );
    chatModelRepoSetting.addText(text =>
      text
        .setPlaceholder('Qwen/Qwen3-8B-GGUF')
        .setValue(this.configManager.get('llamaChatModelRepo'))
        .onChange(
          async value =>
            await this.configManager.set('llamaChatModelRepo', value)
        )
    );

    const chatModelFileSetting = new Setting(llamacppContainer).setName(
      'Model file'
    );
    this.renderMarkdownDesc(
      chatModelFileSetting.descEl,
      'GGUF filename for chat model (e.g., `qwen3-8b-q8_0.gguf`).'
    );
    chatModelFileSetting.addText(text =>
      text
        .setPlaceholder('qwen3-8b-q8_0.gguf')
        .setValue(this.configManager.get('llamaChatModelFile'))
        .onChange(
          async value =>
            await this.configManager.set('llamaChatModelFile', value)
        )
    );
  }

  private createChatConfigSection(containerEl: HTMLElement): void {
    const chatDetails = containerEl.createEl('details', {
      cls: 'sonar-settings-section',
    });
    chatDetails.createEl('summary', { text: 'Chat configuration' });
    const chatContainer = chatDetails.createDiv();

    // Chat general settings
    const maxTokensSetting = new Setting(chatContainer).setName(
      'Max response tokens'
    );
    this.renderMarkdownDesc(
      maxTokensSetting.descEl,
      'Maximum tokens for response generation (default: `8192`).'
    );
    maxTokensSetting.addSlider(slider =>
      slider
        .setLimits(256, 16384, 256)
        .setValue(this.configManager.get('chatMaxTokens'))
        .setDynamicTooltip()
        .onChange(
          async value => await this.configManager.set('chatMaxTokens', value)
        )
    );

    const thinkingSetting = new Setting(chatContainer).setName(
      'Enable thinking mode'
    );
    this.renderMarkdownDesc(
      thinkingSetting.descEl,
      `Enable thinking mode for Qwen3 (default: disabled).
When enabled, the model will show its reasoning process before answering.`
    );
    thinkingSetting.addToggle(toggle =>
      toggle
        .setValue(this.configManager.get('chatEnableThinking'))
        .onChange(
          async value =>
            await this.configManager.set('chatEnableThinking', value)
        )
    );

    const maxIterationsSetting = new Setting(chatContainer).setName(
      'Agent max iterations'
    );
    this.renderMarkdownDesc(
      maxIterationsSetting.descEl,
      `Maximum iterations for agent loop (default: \`5\`).
The agent can call tools multiple times to gather information before responding.
Higher values allow more thorough research but may increase response time.`
    );
    maxIterationsSetting.addSlider(slider =>
      slider
        .setLimits(1, 10, 1)
        .setValue(this.configManager.get('agentMaxIterations'))
        .setDynamicTooltip()
        .onChange(
          async value =>
            await this.configManager.set('agentMaxIterations', value)
        )
    );

    // Context settings subsection
    chatContainer.createEl('h4', { text: 'Context settings' });

    const contextBudgetSetting = new Setting(chatContainer).setName(
      'Context token budget'
    );
    this.renderMarkdownDesc(
      contextBudgetSetting.descEl,
      `Maximum tokens for context (default: \`4096\`).
- Larger values: more context from your notes, but slower and uses more of the context window.
- Smaller values: faster responses, but may miss relevant information.`
    );
    contextBudgetSetting.addSlider(slider =>
      slider
        .setLimits(512, 16384, 512)
        .setValue(this.configManager.get('contextTokenBudget'))
        .setDynamicTooltip()
        .onChange(
          async value =>
            await this.configManager.set('contextTokenBudget', value)
        )
    );

    // Builtin tools settings subsection (collapsible)
    const builtinToolsDetails = chatContainer.createEl('details', {
      cls: 'sonar-settings-subsection',
    });
    builtinToolsDetails.createEl('summary', { text: 'Builtin tools settings' });
    const builtinToolsContainer = builtinToolsDetails.createDiv();

    builtinToolsContainer.createEl('h5', { text: 'Edit note' });

    const editNoteAutoAllowSetting = new Setting(builtinToolsContainer).setName(
      'Auto-allow edit operations'
    );
    this.renderMarkdownDesc(
      editNoteAutoAllowSetting.descEl,
      `Skip permission prompts for note editing.
> [!warning] Enabling this allows the AI to create, modify, and overwrite notes without confirmation.`
    );
    editNoteAutoAllowSetting.addToggle(toggle =>
      toggle
        .setValue(this.configManager.get('editNoteAutoAllow'))
        .onChange(
          async value =>
            await this.configManager.set('editNoteAutoAllow', value)
        )
    );

    builtinToolsContainer.createEl('h5', { text: 'Fetch URL' });

    const fetchUrlEnabledSetting = new Setting(builtinToolsContainer).setName(
      'Enable fetch URL tool'
    );
    this.renderMarkdownDesc(
      fetchUrlEnabledSetting.descEl,
      `Allow the assistant to fetch and read content from web URLs.
When enabled, the assistant can retrieve web page content when you provide a URL.`
    );
    fetchUrlEnabledSetting.addToggle(toggle =>
      toggle
        .setValue(this.configManager.get('fetchUrlEnabled'))
        .onChange(
          async value => await this.configManager.set('fetchUrlEnabled', value)
        )
    );

    // Extension tools subsection
    const extensionToolsDetails = chatContainer.createEl('details', {
      cls: 'sonar-settings-subsection',
      attr: { open: true },
    });
    extensionToolsDetails.createEl('summary', { text: 'Extension tools' });
    const extensionToolsContainer = extensionToolsDetails.createDiv();

    const extensionToolsPathSetting = new Setting(
      extensionToolsContainer
    ).setName('Extension tools folder');
    this.renderMarkdownDesc(
      extensionToolsPathSetting.descEl,
      `Vault folder containing extension tool scripts (\`.js\` files).
Extension tools are loaded from JavaScript files in this folder.
See the plugin documentation for script format and examples.`
    );
    extensionToolsPathSetting.addSearch(search => {
      search
        .setPlaceholder('scripts/tools')
        .setValue(this.configManager.get('extensionToolsPath'))
        .onChange(async value => {
          const normalized = value ? normalizePath(value) : '';
          await this.configManager.set('extensionToolsPath', normalized);
        });
      new FolderSuggestInput(this.app, search.inputEl);
    });

    extensionToolsContainer.createEl('p', {
      text: 'Extension tools are loaded when Chat view opens. Use the reload button in Chat view toolbar to reload after modifying scripts.',
      cls: 'setting-item-description',
    });

    // Generation parameters subsection (collapsible)
    const genDetails = chatContainer.createEl('details', {
      cls: 'sonar-settings-subsection',
    });
    genDetails.createEl('summary', { text: 'Generation parameters' });
    const genContainer = genDetails.createDiv();

    const temperatureSetting = new Setting(genContainer).setName('Temperature');
    this.renderMarkdownDesc(
      temperatureSetting.descEl,
      `Controls randomness in response generation (default: \`0.6\`).
- Lower values (\`0.1-0.4\`): more focused, deterministic responses.
- Higher values (\`0.7-1.0\`): more creative, varied responses.`
    );
    temperatureSetting.addSlider(slider =>
      slider
        .setLimits(0.0, 1.5, 0.1)
        .setValue(this.configManager.get('chatTemperature'))
        .setDynamicTooltip()
        .onChange(
          async value => await this.configManager.set('chatTemperature', value)
        )
    );

    const topPSetting = new Setting(genContainer).setName('Top-p');
    this.renderMarkdownDesc(
      topPSetting.descEl,
      `Nucleus sampling threshold (default: \`0.9\`).
- Lower values (\`0.5-0.8\`): samples from fewer tokens, more focused.
- Higher values (\`0.9-1.0\`): considers more tokens, more diverse.`
    );
    topPSetting.addSlider(slider =>
      slider
        .setLimits(0.5, 1.0, 0.05)
        .setValue(this.configManager.get('chatTopP'))
        .setDynamicTooltip()
        .onChange(
          async value => await this.configManager.set('chatTopP', value)
        )
    );

    const topKSetting = new Setting(genContainer).setName('Top-k');
    this.renderMarkdownDesc(
      topKSetting.descEl,
      `Limits sampling to top K most likely tokens (default: \`0\` = disabled).
- \`0\`: disabled, only top-p is used.
- \`10-50\`: samples from fixed number of top candidates.

Use with top-p for finer control, or set top-p to \`1.0\` to use top-k alone.`
    );
    topKSetting.addSlider(slider =>
      slider
        .setLimits(0, 100, 5)
        .setValue(this.configManager.get('chatTopK'))
        .setDynamicTooltip()
        .onChange(
          async value => await this.configManager.set('chatTopK', value)
        )
    );

    const presencePenaltySetting = new Setting(genContainer).setName(
      'Presence penalty'
    );
    this.renderMarkdownDesc(
      presencePenaltySetting.descEl,
      `Penalty for repeating tokens (default: \`0.5\`).
- Lower values (\`0.0-0.3\`): allows natural repetition.
- Higher values (\`0.5-1.5\`): discourages repetition, may reduce quality.`
    );
    presencePenaltySetting.addSlider(slider =>
      slider
        .setLimits(0.0, 2.0, 0.1)
        .setValue(this.configManager.get('chatPresencePenalty'))
        .setDynamicTooltip()
        .onChange(
          async value =>
            await this.configManager.set('chatPresencePenalty', value)
        )
    );
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
        .onChange(
          async value => await this.configManager.set('maxQueryTokens', value)
        )
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
        .onChange(async value => await this.configManager.set('aggM', value))
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
        .onChange(async value => await this.configManager.set('aggL', value))
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
        .onChange(
          async value => await this.configManager.set('aggDecay', value)
        )
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
        .onChange(async value => await this.configManager.set('aggRrfK', value))
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
        .onChange(
          async value =>
            await this.configManager.set('retrievalMultiplier', value)
        )
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
        .onChange(
          async value =>
            await this.configManager.set('statusBarMaxLength', value)
        )
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
        .onChange(
          async value =>
            await this.configManager.set('debugMode', value as LogLevel)
        )
    );
  }

  private createAudioConfigSection(containerEl: HTMLElement): void {
    const audioDetails = containerEl.createEl('details', {
      cls: 'sonar-settings-section',
    });
    audioDetails.setAttr('open', '');
    audioDetails.createEl('summary', {
      text: 'Audio transcription configuration',
    });
    const audioContainer = audioDetails.createDiv();

    const whisperPathSetting = new Setting(audioContainer).setName(
      'Whisper CLI path'
    );
    this.renderMarkdownDesc(
      whisperPathSetting.descEl,
      'Path to `whisper-cli` binary from whisper.cpp (e.g., `whisper-cli` or `/opt/homebrew/bin/whisper-cli`).'
    );
    whisperPathSetting.addText(text =>
      text
        .setPlaceholder('whisper-cli')
        .setValue(this.configManager.get('audioWhisperCliPath'))
        .onChange(
          async value =>
            await this.configManager.set('audioWhisperCliPath', value)
        )
    );

    const modelPathSetting = new Setting(audioContainer).setName(
      'Whisper model path'
    );
    this.renderMarkdownDesc(
      modelPathSetting.descEl,
      'Path to whisper.cpp model file. Supports `~` for home directory (e.g., `~/whisper-models/ggml-large-v3-turbo-q5_0.bin`).'
    );
    modelPathSetting.addText(text =>
      text
        .setPlaceholder('~/whisper-models/ggml-large-v3-turbo-q5_0.bin')
        .setValue(this.configManager.get('audioWhisperModelPath'))
        .onChange(
          async value =>
            await this.configManager.set('audioWhisperModelPath', value)
        )
    );

    const ffmpegPathSetting = new Setting(audioContainer).setName(
      'ffmpeg path'
    );
    this.renderMarkdownDesc(
      ffmpegPathSetting.descEl,
      'Path to `ffmpeg` binary (e.g., `ffmpeg` or `/opt/homebrew/bin/ffmpeg`).'
    );
    ffmpegPathSetting.addText(text =>
      text
        .setPlaceholder('ffmpeg')
        .setValue(this.configManager.get('audioFfmpegPath'))
        .onChange(
          async value => await this.configManager.set('audioFfmpegPath', value)
        )
    );

    const languageSetting = new Setting(audioContainer).setName(
      'Transcription language'
    );
    this.renderMarkdownDesc(
      languageSetting.descEl,
      'Language code for audio transcription (e.g., `auto` for auto-detection, `ja` for Japanese, `en` for English).'
    );
    languageSetting.addText(text =>
      text
        .setPlaceholder('auto')
        .setValue(this.configManager.get('audioTranscriptionLanguage'))
        .onChange(
          async value =>
            await this.configManager.set('audioTranscriptionLanguage', value)
        )
    );
  }

  private renderExcludedPaths(container: HTMLElement): void {
    container.empty();
    const paths = this.configManager.get('excludedPaths') || [];

    for (const path of paths) {
      new Setting(container)
        .setName(path)
        .setClass('sonar-excluded-path-item')
        .addExtraButton(btn =>
          btn.setIcon('x').onClick(async () => {
            const updated = paths.filter(p => p !== path);
            await this.configManager.set('excludedPaths', updated);
            this.renderExcludedPaths(container);
          })
        );
    }

    let pendingValue = '';
    new Setting(container)
      .setClass('sonar-excluded-path-item')
      .addSearch(search => {
        search.setPlaceholder('Archive, **/*.tmp, ...').onChange(value => {
          pendingValue = value;
        });
        new FolderSuggestInput(this.app, search.inputEl);
      })
      .addExtraButton(btn =>
        btn.setIcon('plus').onClick(async () => {
          const trimmed = pendingValue.trim();
          if (!trimmed) return;
          const normalized = normalizePath(trimmed);
          if (paths.includes(normalized)) return;
          await this.configManager.set('excludedPaths', [...paths, normalized]);
          this.renderExcludedPaths(container);
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
