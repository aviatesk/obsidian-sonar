import { Notice, Plugin, WorkspaceLeaf, debounce } from 'obsidian';
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
import { ObsidianSonarSettingTab } from './src/ui/SettingsTab';

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
