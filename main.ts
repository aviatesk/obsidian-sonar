import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
  debounce,
} from 'obsidian';
import { ObsidianEmbeddingSearch } from './src/embeddingSearch';
import { DEFAULT_OBSIDIAN_CONFIG } from './src/core/config';
import {
  RelatedNotesView,
  RELATED_NOTES_VIEW_TYPE,
} from './src/ui/RelatedNotesView';
import { SearchModal } from './src/ui/SearchModal';
import { SonarTokenizer } from './src/core/tokenizer';
import { IndexManager } from './src/IndexManager';
import { ConfigManager, ObsidianSonarSettings } from './src/ConfigManager';

const DEFAULT_SETTINGS: ObsidianSonarSettings = {
  ...DEFAULT_OBSIDIAN_CONFIG,
  autoOpenRelatedNotes: true,
  excludedPaths: [],
  autoIndex: false,
  indexDebounceMs: 10000, // 10s
  showIndexNotifications: true,
  statusBarMaxLength: 40,
};

export default class ObsidianSonarPlugin extends Plugin {
  configManager!: ConfigManager;
  statusBarItem!: HTMLElement;
  embeddingSearch: ObsidianEmbeddingSearch | null = null;
  relatedNotesView: RelatedNotesView | null = null;
  settingTab: ObsidianSonarSettingTab | null = null;
  indexManager: IndexManager | null = null;

  async onload() {
    // Initialize ConfigManager with static factory method
    this.configManager = await ConfigManager.initialize(
      () => this.loadData(),
      data => this.saveData(data),
      DEFAULT_SETTINGS
    );

    SonarTokenizer.setFallbackNotification((message, type) => {
      if (type === 'error') {
        console.error(message);
        new Notice(message);
      } else if (type === 'warning') {
        console.warn(message);
        if (this.configManager.get('debugMode')) {
          new Notice(message);
        }
      } else {
        console.log(message);
        if (this.configManager.get('debugMode')) {
          new Notice(message, 3000);
        }
      }
    });

    // Initialize tokenizer with embedding model or custom tokenizer model
    try {
      const embeddingModel = this.configManager.get('embeddingModel');
      const tokenizerModel = this.configManager.get('tokenizerModel');
      await SonarTokenizer.initialize(
        embeddingModel,
        tokenizerModel || undefined
      );
      if (tokenizerModel) {
        console.log('Tokenizer initialized with custom model:', tokenizerModel);
      } else {
        console.log(
          'Tokenizer initialized with embedding model:',
          embeddingModel
        );
      }
    } catch (error) {
      console.error('Failed to initialize tokenizer:', error);
      new Notice('Failed to initialize tokenizer - check console for details');
    }

    // Initialize semantic search system with ConfigManager
    try {
      this.embeddingSearch = await ObsidianEmbeddingSearch.initialize(
        this.app.vault,
        this.configManager
      );
      console.log('Semantic search system initialized with Ollama');

      this.indexManager = new IndexManager(
        this.embeddingSearch,
        this.app.vault,
        this.configManager,
        (status: string) => this.updateStatusBarPadded(status),
        () => this.updateStatusBarWithFileCount()
      );
    } catch (error) {
      console.error('Failed to initialize semantic search:', error);
      new Notice(
        'Failed to initialize semantic search - Check Ollama is running'
      );
    }

    this.statusBarItem = this.addStatusBarItem();

    // Rebuild entire index from scratch
    this.addCommand({
      id: 'rebuild-index',
      name: 'Rebuild entire search index',
      callback: async () => {
        if (this.indexManager) {
          const startTime = Date.now();
          await this.indexManager.rebuildIndex(async (current, total) => {
            this.updateStatusBar(`Rebuilding index: ${current}/${total}`);
          });
          const duration = ((Date.now() - startTime) / 1000).toFixed(2);
          new Notice(`Index rebuilt in ${duration}s`);
          await this.updateStatusBarWithFileCount();
        } else {
          new Notice('Index manager not initialized');
        }
      },
    });

    // Index current file
    this.addCommand({
      id: 'index-current-file',
      name: 'Index current file',
      callback: async () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && this.indexManager) {
          await this.indexManager.indexFile(activeFile);
        } else if (!activeFile) {
          new Notice('No active file');
        } else {
          new Notice('Index manager not initialized');
        }
      },
    });

    this.addCommand({
      id: 'open-related-notes',
      name: 'Open related notes view',
      callback: () => {
        this.activateRelatedNotesView();
      },
    });

    this.addCommand({
      id: 'semantic-search-notes',
      name: 'Semantic search notes',
      callback: () => {
        this.openSearchModal();
      },
    });

    // Sync index with current vault state
    this.addCommand({
      id: 'sync-index',
      name: 'Sync search index with vault',
      callback: async () => {
        if (this.indexManager) {
          await this.indexManager.syncIndex();
        } else {
          new Notice('Index manager not initialized');
        }
      },
    });

    this.registerView(RELATED_NOTES_VIEW_TYPE, leaf => {
      if (!this.embeddingSearch) {
        new Notice('Semantic search not initialized');
        throw new Error('Semantic search not initialized');
      }
      this.relatedNotesView = new RelatedNotesView(
        this,
        leaf,
        this.embeddingSearch,
        this.configManager.get('ollamaUrl'),
        this.configManager.get('embeddingModel'),
        this.configManager.get('summaryModel'),
        this.configManager.get('maxQueryTokens'),
        this.configManager.get('tokenizerModel'),
        this.configManager.get('followCursor'),
        this.configManager.get('withExtraction')
      );
      return this.relatedNotesView;
    });

    if (this.configManager.get('autoOpenRelatedNotes')) {
      this.app.workspace.onLayoutReady(() => {
        this.activateRelatedNotesView();
      });
    }

    // N.B. Register vault events after layout is ready to avoid startup event spam
    this.app.workspace.onLayoutReady(() => {
      this.updateStatusBarWithFileCount();

      const debouncedStatusUpdate = debounce(
        () => this.updateStatusBarWithFileCount(),
        500,
        true
      );
      this.registerEvent(this.app.vault.on('create', debouncedStatusUpdate));
      this.registerEvent(this.app.vault.on('delete', debouncedStatusUpdate));
      this.registerEvent(this.app.vault.on('rename', debouncedStatusUpdate));

      if (this.indexManager) {
        this.indexManager.onLayoutReady();
      }
    });

    // this.registerEvent(
    //   this.app.workspace.on('active-leaf-change', async () => {
    //     this.updateTokenCount();
    //   })
    // );
    // this.registerEvent(
    //   this.app.workspace.on('editor-change', async () => {
    //     this.updateTokenCount();
    //   })
    // );

    this.settingTab = new ObsidianSonarSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    console.log('Obsidian Sonar plugin loaded');
  }

  async activateRelatedNotesView() {
    if (!this.embeddingSearch) {
      new Notice('Please initialize semantic search first');
      return;
    }

    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(RELATED_NOTES_VIEW_TYPE);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        leaf = rightLeaf;
      }
    }

    if (leaf) {
      await leaf.setViewState({
        type: RELATED_NOTES_VIEW_TYPE,
        active: true,
      });
      workspace.revealLeaf(leaf);
    }
  }

  openSearchModal(): void {
    if (!this.embeddingSearch) {
      new Notice('Please initialize semantic search first');
      return;
    }

    const modal = new SearchModal(this.app, this.embeddingSearch);
    modal.open();
  }

  updateStatusBar(text: string) {
    if (this.statusBarItem) {
      this.statusBarItem.setText(text);
    }
  }

  updateStatusBarPadded(text: string) {
    if (this.statusBarItem) {
      const maxLength = this.configManager.get('statusBarMaxLength');

      // If maxLength is 0, no padding/truncation
      if (maxLength === 0) {
        this.statusBarItem.setText(text);
        return;
      }

      let paddedText = text;
      if (text.length > maxLength) {
        // Truncate with ellipsis in the middle
        const halfLength = Math.floor((maxLength - 3) / 2);
        const prefix = text.slice(0, halfLength);
        const suffix = text.slice(-(maxLength - halfLength - 3));
        paddedText = prefix + '...' + suffix;
      } else {
        paddedText = text.padEnd(maxLength);
      }
      this.statusBarItem.setText(paddedText);
    }
  }

  async updateStatusBarWithFileCount() {
    if (!this.embeddingSearch) {
      this.updateStatusBar('Sonar: Not initialized');
      return;
    }

    try {
      const stats = await this.embeddingSearch.getStats();
      const indexableCount =
        await this.embeddingSearch.getIndexableFilesCount();
      this.updateStatusBar(
        `Sonar: Indexed ${stats.totalFiles}/${indexableCount} files`
      );
    } catch (error) {
      this.updateStatusBar('Sonar: Vector store errored');
    }
  }

  async onunload() {
    console.log('Obsidian Sonar plugin unloaded');
    if (this.indexManager) {
      this.indexManager.cleanup();
    }
    if (this.embeddingSearch) {
      await this.embeddingSearch.close();
    }
  }
}

class ObsidianSonarSettingTab extends PluginSettingTab {
  plugin: ObsidianSonarPlugin;
  statsDiv: HTMLDivElement | null = null;
  private configManager: ConfigManager;

  constructor(app: App, plugin: ObsidianSonarPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.configManager = plugin.configManager;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h3', { text: 'Obsidian Sonar Actions' });

    new Setting(containerEl)
      .setName('Rebuild entire index')
      .setDesc(
        `Rebuild index for all files in: ${this.configManager.get('indexPath')}`
      )
      .addButton(button =>
        button.setButtonText('Rebuild').onClick(async () => {
          if (this.plugin.indexManager) {
            const startTime = Date.now();
            await this.plugin.indexManager.rebuildIndex(
              async (current, total) => {
                this.plugin.updateStatusBar(`Indexing ${current}/${total}`);
                // Update stats periodically
                if (current % 10 === 0) {
                  await this.updateStats();
                }
              }
            );
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            new Notice(`Index rebuilt in ${duration}s`);
            await this.updateStats();
            await this.plugin.updateStatusBarWithFileCount();
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
            await this.plugin.updateStatusBarWithFileCount();
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
              if (this.plugin.embeddingSearch) {
                await this.plugin.embeddingSearch.clearIndex();
                new Notice('Index cleared');
                await this.updateStats();
                // Reload indexed files in IndexManager after clearing
                if (this.plugin.indexManager) {
                  await this.plugin.indexManager.reloadIndexedFiles();
                }
              } else {
                new Notice('Semantic search not initialized');
              }
            }
          })
      );

    containerEl.createEl('h3', { text: 'Obsidian Sonar Statistics' });
    const statsDiv = containerEl.createDiv({
      cls: 'sonar-stats-in-settings',
    });
    this.statsDiv = statsDiv;
    this.updateStats();

    containerEl.createEl('h2', { text: 'Obsidian Sonar Settings' });

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
        'Path to index (use / for entire vault, or specify a folder like /Notes)'
      )
      .addText(text =>
        text
          .setPlaceholder('/')
          .setValue(this.configManager.get('indexPath'))
          .onChange(async value => {
            await this.configManager.set('indexPath', value || '/');
            await this.updateStats();
            await this.plugin.updateStatusBarWithFileCount();
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
              .filter(line => line.length > 0);
            await this.configManager.set('excludedPaths', paths);
            await this.updateStats();
            await this.plugin.updateStatusBarWithFileCount();
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
            // Reinitialize tokenizer with new model
            try {
              await SonarTokenizer.initialize(
                this.configManager.get('embeddingModel'),
                value || undefined
              );
              if (value) {
                new Notice(`Tokenizer updated to: ${value}`);
              } else {
                new Notice(
                  `Tokenizer using default mapping for: ${this.configManager.get('embeddingModel')}`
                );
              }
            } catch (error) {
              console.error('Failed to update tokenizer:', error);
              new Notice('Failed to update tokenizer model');
            }
          })
      );

    new Setting(containerEl)
      .setName('Max chunk size')
      .setDesc('Maximum tokens per chunk')
      .addText(text =>
        text
          .setPlaceholder('512')
          .setValue(String(this.configManager.get('maxChunkSize')))
          .onChange(async value => {
            const num = parseInt(value);
            if (!isNaN(num) && num > 0) {
              await this.configManager.set('maxChunkSize', num);
            }
          })
      );

    new Setting(containerEl)
      .setName('Chunk overlap')
      .setDesc('Number of overlapping tokens between chunks')
      .addText(text =>
        text
          .setPlaceholder('64')
          .setValue(String(this.configManager.get('chunkOverlap')))
          .onChange(async value => {
            const num = parseInt(value);
            if (!isNaN(num) && num >= 0) {
              await this.configManager.set('chunkOverlap', num);
            }
          })
      );

    new Setting(containerEl)
      .setName('Max query tokens')
      .setDesc('Maximum number of tokens for search queries (recommended: 128)')
      .addText(text =>
        text
          .setPlaceholder('128')
          .setValue(String(this.configManager.get('maxQueryTokens')))
          .onChange(async value => {
            const num = parseInt(value);
            if (!isNaN(num) && num > 0) {
              await this.configManager.set('maxQueryTokens', num);
            }
          })
      );

    new Setting(containerEl)
      .setName('Default search results')
      .setDesc('Number of results to return by default')
      .addText(text =>
        text
          .setPlaceholder('5')
          .setValue(String(this.configManager.get('defaultTopK')))
          .onChange(async value => {
            const num = parseInt(value);
            if (!isNaN(num) && num > 0) {
              await this.configManager.set('defaultTopK', num);
            }
          })
      );

    new Setting(containerEl)
      .setName('Debug mode')
      .setDesc('Enable debug logging to console')
      .addToggle(toggle =>
        toggle
          .setValue(this.configManager.get('debugMode'))
          .onChange(async value => {
            await this.configManager.set('debugMode', value);
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

    containerEl.createEl('h3', { text: 'Auto-indexing Settings' });

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
        'Wait time before processing file changes (reduces frequent updates)'
      )
      .addText(text =>
        text
          .setPlaceholder('10000')
          .setValue(String(this.configManager.get('indexDebounceMs')))
          .onChange(async value => {
            const num = parseInt(value);
            if (!isNaN(num) && num >= 100) {
              await this.configManager.set('indexDebounceMs', num);
            }
          })
      );

    new Setting(containerEl)
      .setName('Show index notifications')
      .setDesc('Display notifications when files are indexed')
      .addToggle(toggle =>
        toggle
          .setValue(this.configManager.get('showIndexNotifications'))
          .onChange(async value => {
            await this.configManager.set('showIndexNotifications', value);
          })
      );

    new Setting(containerEl)
      .setName('Status bar max length')
      .setDesc('Maximum number of characters in status bar (0 = no padding)')
      .addText(text =>
        text
          .setPlaceholder('40')
          .setValue(String(this.configManager.get('statusBarMaxLength')))
          .onChange(async value => {
            const length = parseInt(value) || 0;
            await this.configManager.set('statusBarMaxLength', length);
          })
      );
  }

  async confirmClearIndex(): Promise<boolean> {
    return new Promise(resolve => {
      const modal = new Modal(this.app);
      modal.titleEl.setText('Clear Index');
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
    if (!this.statsDiv || !this.plugin.embeddingSearch) return;

    try {
      const stats = await this.plugin.embeddingSearch.getStats();
      const indexableCount =
        await this.plugin.embeddingSearch.getIndexableFilesCount();
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
    } catch (error) {
      console.error('Failed to get stats:', error);
      this.statsDiv.empty();
      this.statsDiv.createEl('p', { text: 'Stats unavailable' });
    }
  }
}
