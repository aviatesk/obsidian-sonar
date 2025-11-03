import {
  App,
  Notice,
  PluginSettingTab,
  Setting,
  Modal,
  normalizePath,
} from 'obsidian';
import { ConfigManager } from '../ConfigManager';
import { Tokenizer } from '../Tokenizer';
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
        button.setButtonText('Rebuild').onClick(async () => {
          if (this.plugin.indexManager) {
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
          } else {
            new Notice('Index manager not initialized');
          }
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
      .setName('Clear semantic search index')
      .setDesc('Remove all indexed data')
      .addButton(button =>
        button
          .setButtonText('Clear')
          .setWarning()
          .onClick(async () => {
            const confirm = await this.confirmClearIndex();
            if (confirm) {
              if (this.plugin.indexManager) {
                await this.plugin.indexManager.clearIndex();
                new Notice('Index cleared');
                await this.updateStats();
              } else {
                new Notice('Semantic search not initialized');
              }
            }
          })
      );

    new Setting(containerEl).setName('Statistics').setHeading();
    const statsDiv = containerEl.createDiv({
      cls: 'sonar-stats-in-settings',
    });
    this.statsDiv = statsDiv;
    this.updateStats();

    new Setting(containerEl).setName('Settings').setHeading();

    new Setting(containerEl)
      .setName('Ollama URL')
      .setDesc('URL for Ollama API endpoint')
      .addText(text =>
        text
          .setPlaceholder('http://localhost:11434')
          .setValue(this.configManager.get('ollamaUrl'))
          .onChange(async value => {
            await this.configManager.set('ollamaUrl', value);
          })
      );

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
      .setDesc(
        'Ollama model to use for embeddings (e.g., nomic-embed-text, mxbai-embed-large)'
      )
      .addText(text =>
        text
          .setPlaceholder('nomic-embed-text')
          .setValue(this.configManager.get('embeddingModel'))
          .onChange(async value => {
            await this.configManager.set('embeddingModel', value);
          })
      );

    new Setting(containerEl)
      .setName('Tokenizer model (optional)')
      .setDesc(
        'Custom Hugging Face tokenizer model (e.g., Xenova/bert-base-multilingual-cased). Leave empty to use default mapping.'
      )
      .addText(text =>
        text
          .setPlaceholder('Leave empty for auto-mapping')
          .setValue(this.configManager.get('tokenizerModel'))
          .onChange(async value => {
            await this.configManager.set('tokenizerModel', value || '');
            try {
              this.plugin.tokenizer = await Tokenizer.initialize(
                this.configManager.get('embeddingModel'),
                this.configManager.getLogger(),
                value || undefined
              );
              new Notice('Tokenizer updated');
            } catch (err) {
              this.configManager
                .getLogger()
                .error(`Failed to update tokenizer: ${err}`);
              new Notice('Failed to update tokenizer model');
            }
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
          .setValue(this.configManager.get('topK'))
          .setDynamicTooltip()
          .onChange(async value => {
            await this.configManager.set('topK', value);
          })
      );

    new Setting(containerEl)
      .setName('Multi-chunk score decay')
      .setDesc(
        'Controls scoring for files with multiple matching chunks. ' +
          'Higher values (0.3-0.5) give more weight to additional chunks, favoring longer documents. ' +
          'Lower values (0-0.2) prioritize the best match, treating all files more equally. ' +
          'Use 0 to score by best chunk only.'
      )
      .addSlider(slider =>
        slider
          .setLimits(0, 0.5, 0.05)
          .setValue(this.configManager.get('scoreDecay'))
          .setDynamicTooltip()
          .onChange(async value => {
            await this.configManager.set('scoreDecay', value);
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
      .setName('Index debounce time (ms)')
      .setDesc(
        'Wait time before processing indexing queue (default: 1000ms = 1s)'
      )
      .addSlider(slider =>
        slider
          .setLimits(500, 5000, 500)
          .setValue(this.configManager.get('indexDebounceMs'))
          .setDynamicTooltip()
          .onChange(async value => {
            await this.configManager.set('indexDebounceMs', value);
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
  }

  async confirmClearIndex(): Promise<boolean> {
    return new Promise(resolve => {
      const modal = new Modal(this.app);
      modal.titleEl.setText('Clear index');
      modal.contentEl.setText(
        'Are you sure you want to clear all indexed data? This action cannot be undone.'
      );

      modal.contentEl.createDiv(
        { cls: 'modal-button-container' },
        buttonContainer => {
          buttonContainer
            .createEl('button', { text: 'Cancel' })
            .addEventListener('click', () => {
              modal.close();
              resolve(false);
            });

          buttonContainer
            .createEl('button', {
              text: 'Clear',
              cls: 'mod-warning',
            })
            .addEventListener('click', () => {
              modal.close();
              resolve(true);
            });
        }
      );

      modal.open();
    });
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
