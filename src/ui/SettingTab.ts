import {
  App,
  Modal,
  Notice,
  PluginSettingTab,
  Setting,
  normalizePath,
} from 'obsidian';
import { ConfigManager } from '../ConfigManager';
import type SonarPlugin from '../../main';
import { getIndexableFilesCount } from 'src/fileFilters';

export class SettingTab extends PluginSettingTab {
  plugin: SonarPlugin;
  statsDiv: HTMLDivElement | null = null;
  private configManager: ConfigManager;

  constructor(app: App, plugin: SonarPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.configManager = plugin.configManager;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName('Actions').setHeading();

    new Setting(containerEl)
      .setName('Rebuild entire index')
      .setDesc(
        `Rebuild index for all files in: ${this.configManager.get('indexPath')}`
      )
      .addButton(button =>
        button
          .setButtonText('Rebuild')
          .setWarning()
          .onClick(async () => {
            if (!this.plugin.indexManager) {
              new Notice('Index manager not initialized');
              return;
            }

            const confirmed = await this.confirmRebuildIndex();
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

    new Setting(containerEl)
      .setName('Sync index with vault')
      .setDesc('Add missing files and remove deleted ones')
      .addButton(button =>
        button.setButtonText('Sync').onClick(async () => {
          if (this.plugin.indexManager) {
            await this.plugin.indexManager.syncIndex();
            await this.updateStats();
          } else {
            new Notice('Index manager not initialized');
          }
        })
      );

    new Setting(containerEl)
      .setName('Clear current search index')
      .setDesc(
        `Clear indexed data for current configuration (${this.configManager.get('embedderType')} / ${this.configManager.get('embeddingModel')})`
      )
      .addButton(button =>
        button
          .setButtonText('Clear')
          .setWarning()
          .onClick(async () => {
            if (!this.plugin.indexManager) {
              new Notice('Index manager not initialized');
              return;
            }

            const confirmed = await this.confirmClearCurrentIndex();
            if (!confirmed) {
              return;
            }

            await this.plugin.indexManager.clearCurrentIndex();
            new Notice('Current index cleared');
            await this.updateStats();
          })
      );

    new Setting(containerEl)
      .setName('Clear all search indices for this vault')
      .setDesc(
        'Remove all indexed data for all embedders and models used in this vault'
      )
      .addButton(button =>
        button
          .setButtonText('Clear All')
          .setWarning()
          .onClick(async () => {
            await this.plugin.clearAllVaultIndices();
            await this.updateStats();
          })
      );

    new Setting(containerEl).setName('Statistics').setHeading();
    const statsDiv = containerEl.createDiv({
      cls: 'sonar-stats-in-settings',
    });
    this.statsDiv = statsDiv;
    this.updateStats();

    new Setting(containerEl).setName('Settings').setHeading();

    // Add a description showing current indexable files count
    new Setting(containerEl)
      .setName('Index path')
      .setDesc(
        'Path to index (leave it empty for indexing entire vault, or specify a folder like /Notes)'
      )
      .addText(text =>
        text
          .setPlaceholder('')
          .setValue(this.configManager.get('indexPath'))
          .onChange(async value => {
            const normalized = value ? normalizePath(value) : '';
            await this.configManager.set('indexPath', normalized);
            await this.updateStats();
          })
      );

    new Setting(containerEl)
      .setName('Excluded paths')
      .setDesc(
        'Paths to ignore during indexing (one per line). Supports: folder names (e.g., "Archive"), relative paths (e.g., "Daily Notes/2023"), and glob patterns (e.g., "**/*.tmp", "**/test/**")'
      )
      .addTextArea(text => {
        text
          .setPlaceholder('Archive\nDaily Notes\n**/*.tmp\n**/test/**')
          .setValue((this.configManager.get('excludedPaths') || []).join('\n'))
          .onChange(async value => {
            // Split by newlines and filter out empty lines
            const paths = value
              .split('\n')
              .map(line => line.trim())
              .filter(line => line.length > 0)
              .map(path => normalizePath(path));
            await this.configManager.set('excludedPaths', paths);
            await this.updateStats();
          });
        // Make the text area larger
        text.inputEl.rows = 5;
        text.inputEl.cols = 50;
      });

    new Setting(containerEl)
      .setName('Embedding model')
      .setDesc('HuggingFace model ID for embeddings (e.g., `Xenova/bge-m3`)')
      .addText(text =>
        text
          .setPlaceholder('Xenova/bge-m3')
          .setValue(this.configManager.get('embeddingModel'))
          .onChange(async value => {
            await this.configManager.set('embeddingModel', value);
          })
      );

    new Setting(containerEl)
      .setName('Max chunk size')
      .setDesc('Maximum tokens per chunk (recommended: 512)')
      .addSlider(slider =>
        slider
          .setLimits(64, 2048, 64)
          .setValue(this.configManager.get('maxChunkSize'))
          .setDynamicTooltip()
          .onChange(async value => {
            await this.configManager.set('maxChunkSize', value);
          })
      );

    new Setting(containerEl)
      .setName('Chunk overlap')
      .setDesc(
        'Number of overlapping tokens between chunks (recommended: 64 ~10% of chunk size)'
      )
      .addSlider(slider =>
        slider
          .setLimits(0, 256, 8)
          .setValue(this.configManager.get('chunkOverlap'))
          .setDynamicTooltip()
          .onChange(async value => {
            await this.configManager.set('chunkOverlap', value);
          })
      );

    new Setting(containerEl)
      .setName('Max query tokens')
      .setDesc('Maximum number of tokens for search queries (recommended: 128)')
      .addSlider(slider =>
        slider
          .setLimits(32, 512, 16)
          .setValue(this.configManager.get('maxQueryTokens'))
          .setDynamicTooltip()
          .onChange(async value => {
            await this.configManager.set('maxQueryTokens', value);
          })
      );

    new Setting(containerEl)
      .setName('Search results count')
      .setDesc('Number of search results to return (default: 10)')
      .addSlider(slider =>
        slider
          .setLimits(1, 20, 1)
          .setValue(this.configManager.get('searchResultsCount'))
          .setDynamicTooltip()
          .onChange(async value => {
            await this.configManager.set('searchResultsCount', value);
          })
      );

    new Setting(containerEl)
      .setName('Log level')
      .setDesc('Set logging verbosity (error < warn < log)')
      .addDropdown(dropdown =>
        dropdown
          .addOption('error', 'Error only')
          .addOption('warn', 'Warn + Error')
          .addOption('log', 'Log + Warn + Error')
          .setValue(this.configManager.get('debugMode'))
          .onChange(async value => {
            await this.configManager.set(
              'debugMode',
              value as 'error' | 'warn' | 'log'
            );
          })
      );

    new Setting(containerEl)
      .setName('Auto-open related notes view')
      .setDesc('Automatically open the related notes view on startup')
      .addToggle(toggle =>
        toggle
          .setValue(this.configManager.get('autoOpenRelatedNotes'))
          .onChange(async value => {
            await this.configManager.set('autoOpenRelatedNotes', value);
          })
      );

    new Setting(containerEl).setName('Auto-indexing').setHeading();

    new Setting(containerEl)
      .setName('Enable auto-indexing')
      .setDesc(
        'Automatically index files when they are created, modified, or deleted'
      )
      .addToggle(toggle =>
        toggle
          .setValue(this.configManager.get('autoIndex'))
          .onChange(async value => {
            await this.configManager.set('autoIndex', value);
          })
      );

    new Setting(containerEl)
      .setName('Related notes update delay')
      .setDesc(
        'Delay in milliseconds before updating related notes view after typing (default: 5000ms = 5s)'
      )
      .addSlider(slider =>
        slider
          .setLimits(500, 10000, 500)
          .setValue(this.configManager.get('relatedNotesDebounceMs'))
          .setDynamicTooltip()
          .onChange(async value => {
            await this.configManager.set('relatedNotesDebounceMs', value);
          })
      );

    new Setting(containerEl)
      .setName('Status bar max length')
      .setDesc(
        'Maximum number of characters in status bar (default: 40, 0 = no limit)'
      )
      .addSlider(slider =>
        slider
          .setLimits(0, 100, 5)
          .setValue(this.configManager.get('statusBarMaxLength'))
          .setDynamicTooltip()
          .onChange(async value => {
            await this.configManager.set('statusBarMaxLength', value);
          })
      );

    new Setting(containerEl)
      .setName('Indexing batch size')
      .setDesc(
        'Number of texts (titles + chunks) to process in a single batch during indexing. Larger values process more texts at once but use more memory. Smaller values reduce memory usage but increase the number of calls to the embedder. (default: 32)'
      )
      .addSlider(slider =>
        slider
          .setLimits(1, 128, 1)
          .setValue(this.configManager.get('indexingBatchSize'))
          .setDynamicTooltip()
          .onChange(async value => {
            await this.configManager.set('indexingBatchSize', value);
          })
      );
  }

  private getCurrentConfigInfo(): string {
    const embedderType = this.configManager.get('embedderType');
    const embeddingModel = this.configManager.get('embeddingModel');
    return `Embedder: ${embedderType}\nModel: ${embeddingModel}`;
  }

  private async confirmAction(
    title: string,
    message: string,
    actionButtonText: string
  ): Promise<boolean> {
    return new Promise(resolve => {
      const modal = new Modal(this.app);
      modal.titleEl.setText(title);
      modal.contentEl.setText(message);

      const buttonContainer = modal.contentEl.createDiv({
        cls: 'modal-button-container',
      });
      buttonContainer
        .createEl('button', { text: 'Cancel' })
        .addEventListener('click', () => {
          modal.close();
          resolve(false);
        });
      buttonContainer
        .createEl('button', { text: actionButtonText, cls: 'mod-warning' })
        .addEventListener('click', () => {
          modal.close();
          resolve(true);
        });

      modal.open();
    });
  }

  async confirmRebuildIndex(): Promise<boolean> {
    return this.confirmAction(
      'Rebuild index',
      `Rebuild entire search index?\n\n${this.getCurrentConfigInfo()}\n\nThis will clear all indexed data and reindex all files. This cannot be undone.`,
      'Rebuild'
    );
  }

  async confirmClearCurrentIndex(): Promise<boolean> {
    return this.confirmAction(
      'Clear current index',
      `Clear current search index?\n\n${this.getCurrentConfigInfo()}\n\nThis will remove all indexed data for the current configuration. This cannot be undone.`,
      'Clear'
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
      text: `Total chunks: ${stats.totalDocuments}`,
    });
    this.statsDiv.createEl('p', {
      text: `Index path: ${this.configManager.get('indexPath')}`,
    });
  }
}
