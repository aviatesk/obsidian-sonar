import { Notice, Plugin, WorkspaceLeaf, debounce } from 'obsidian';
import { EmbeddingSearch } from './src/EmbeddingSearch';
import { BM25Store } from './src/BM25Store';
import { BM25Search } from './src/BM25Search';
import { DEFAULT_SETTINGS } from './src/config';
import {
  RelatedNotesView,
  RELATED_NOTES_VIEW_TYPE,
} from './src/ui/RelatedNotesView';
import { SemanticNoteFinder } from './src/ui/SemanticNoteFinder';
import { Tokenizer } from './src/Tokenizer';
import { IndexManager } from './src/IndexManager';
import { ConfigManager } from './src/ConfigManager';
import { SettingTab } from './src/ui/SettingTab';
import { getIndexableFilesCount } from 'src/fileFilters';
import { EmbeddingStore } from './src/EmbeddingStore';
import { OllamaClient } from './src/OllamaClient';
export default class SonarPlugin extends Plugin {
  configManager!: ConfigManager;
  statusBarItem!: HTMLElement;
  embeddingSearch: EmbeddingSearch | null = null;
  bm25Store: BM25Store | null = null;
  bm25Search: BM25Search | null = null;
  indexManager: IndexManager | null = null;
  embeddingStore: EmbeddingStore | null = null;
  ollamaClient: OllamaClient | null = null;
  tokenizer: Tokenizer | null = null;

  async onload() {
    this.configManager = await ConfigManager.initialize(
      () => this.loadData(),
      data => this.saveData(data),
      DEFAULT_SETTINGS
    );

    // UI elements - needed immediately
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.setText('Sonar: Loading...');

    // Register commands immediately (lightweight)
    this.registerCommands();
    const settingTab = new SettingTab(this.app, this);
    this.addSettingTab(settingTab);

    // Defer heavy initialization to avoid blocking plugin load
    this.app.workspace.onLayoutReady(() => this.initializeAsync());
  }

  private async initializeAsync(): Promise<void> {
    const embeddingModel = this.configManager.get('embeddingModel');
    const tokenizerModel = this.configManager.get('tokenizerModel');

    try {
      this.tokenizer = await Tokenizer.initialize(
        embeddingModel,
        this.configManager.getLogger(),
        tokenizerModel || undefined
      );
    } catch (error) {
      this.configManager
        .getLogger()
        .error(`Failed to initialize tokenizer: ${error}`);
      new Notice('Failed to initialize tokenizer - check console for details');
      return;
    }

    const ollamaUrl = this.configManager.get('ollamaUrl');

    this.ollamaClient = new OllamaClient({
      ollamaUrl,
      model: embeddingModel,
    });

    try {
      await this.ollamaClient.checkModel();
    } catch {
      new Notice('Failed to connect to Ollama - check console for details');
      return;
    }

    this.configManager
      .getLogger()
      .log(`Ollama initialized with model: ${embeddingModel}`);

    let wasUpgraded = false;
    try {
      const result = await EmbeddingStore.initialize(
        this.configManager.getLogger()
      );
      this.embeddingStore = result.store;
      wasUpgraded = result.wasUpgraded;
    } catch {
      new Notice('Failed to initialize vector store - check console');
      return;
    }

    if (wasUpgraded) {
      const frag = document.createDocumentFragment();
      const container = frag.createEl('div');
      container.createEl('div', {
        text: 'Sonar: Database schema updated. Index cleared.',
      });
      const buttonContainer = container.createEl('div', {
        cls: 'notice-button-container',
      });
      buttonContainer.style.marginTop = '8px';
      const rebuildButton = buttonContainer.createEl('button', {
        text: 'Rebuild Index',
      });
      rebuildButton.addEventListener('click', () => {
        this.indexManager?.rebuildIndex();
      });
      new Notice(frag, 0);
    }

    this.configManager.getLogger().log('Vector store initialized');

    try {
      // Use the same tokenizer as embedding model for BM25
      this.bm25Store = await BM25Store.initialize(
        this.configManager.getLogger(),
        this.tokenizer
      );
      this.configManager.getLogger().log('BM25 store initialized');
    } catch (error) {
      this.configManager
        .getLogger()
        .error(`Failed to initialize BM25 store: ${error}`);
      new Notice('Failed to initialize BM25 store - check console');
      return;
    }

    // Initialize BM25 search
    this.bm25Search = new BM25Search(this.bm25Store, this.embeddingStore);
    this.configManager.getLogger().log('BM25 search initialized');

    // Initialize embedding search with BM25 for hybrid functionality
    this.embeddingSearch = new EmbeddingSearch(
      this.embeddingStore,
      this.ollamaClient,
      this.configManager.get('scoreDecay'),
      this.bm25Search
    );
    this.configManager
      .getLogger()
      .log('Embedding search with hybrid support initialized');

    this.indexManager = new IndexManager(
      this.embeddingStore,
      this.bm25Store,
      this.ollamaClient,
      this.app.vault,
      this.app.workspace,
      this.configManager,
      () => this.tokenizer!,
      this.configManager.getLogger(),
      (status: string) => this.updateStatusBar(status),
      () => this.updateStatusBarWithFileCount()
    );

    this.updateStatusBarWithFileCount();

    this.registerViews(this.embeddingSearch);

    if (this.configManager.get('autoOpenRelatedNotes')) {
      this.activateRelatedNotesView();
    }

    this.setupEventHandlers();

    try {
      await this.indexManager.onLayoutReady();
    } catch {
      this.updateStatusBar('Failed to initialize');
      new Notice(
        'Failed to initialize semantic search - Check Ollama is running'
      );
    }
  }

  private isInitialized(): boolean {
    return this.embeddingSearch !== null && this.indexManager !== null;
  }

  private registerViews(embeddingSearch: EmbeddingSearch): void {
    this.registerView(RELATED_NOTES_VIEW_TYPE, leaf => {
      return new RelatedNotesView(
        leaf,
        embeddingSearch,
        this.configManager,
        () => this.tokenizer!,
        this.configManager.getLogger(),
        ext => this.registerEditorExtension(ext),
        processor => this.registerMarkdownPostProcessor(processor)
      );
    });
  }

  private setupEventHandlers(): void {
    const debouncedStatusUpdate = debounce(
      () => this.updateStatusBarWithFileCount(),
      500,
      true
    );
    this.registerEvent(this.app.vault.on('create', debouncedStatusUpdate));
    this.registerEvent(this.app.vault.on('delete', debouncedStatusUpdate));
    this.registerEvent(this.app.vault.on('rename', debouncedStatusUpdate));
  }

  private registerCommands(): void {
    // Rebuild entire index from scratch
    this.addCommand({
      id: 'rebuild-index',
      name: 'Rebuild entire search index',
      callback: async () => {
        if (!this.isInitialized()) {
          new Notice('Sonar is still initializing. Please wait...');
          return;
        }
        const startTime = Date.now();
        await this.indexManager!.rebuildIndex((current, total) => {
          this.updateStatusBar(`Rebuilding index: ${current}/${total}`);
        });
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        new Notice(`Index rebuilt in ${duration}s`);
        await this.updateStatusBarWithFileCount();
      },
    });

    // Index current file
    this.addCommand({
      id: 'index-current-file',
      name: 'Index current file',
      callback: async () => {
        if (!this.isInitialized()) {
          new Notice('Sonar is still initializing. Please wait...');
          return;
        }
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
          new Notice('No active file');
          return;
        }
        await this.indexManager!.indexFile(activeFile);
      },
    });

    // Open related notes view
    this.addCommand({
      id: 'open-related-notes',
      name: 'Open related notes view',
      callback: () => {
        this.activateRelatedNotesView();
      },
    });

    // Semantic search
    this.addCommand({
      id: 'semantic-search-notes',
      name: 'Semantic search notes',
      callback: () => {
        this.openSemanticNoteFinder();
      },
    });

    // Sync index with current vault state
    this.addCommand({
      id: 'sync-index',
      name: 'Sync search index with vault',
      callback: async () => {
        if (!this.isInitialized()) {
          new Notice('Sonar is still initializing. Please wait...');
          return;
        }
        await this.indexManager!.syncIndex();
      },
    });

    // BM25-specific commands
    this.addCommand({
      id: 'rebuild-bm25-index',
      name: 'Rebuild BM25 full-text index',
      callback: async () => {
        if (!this.isInitialized()) {
          new Notice('Sonar is still initializing. Please wait...');
          return;
        }
        const startTime = Date.now();
        await this.indexManager!.rebuildBM25Index((current, total) => {
          this.updateStatusBar(`Rebuilding BM25: ${current}/${total}`);
        });
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        new Notice(`BM25 index rebuilt in ${duration}s`);
        await this.updateStatusBarWithFileCount();
      },
    });

    this.addCommand({
      id: 'sync-bm25-index',
      name: 'Sync BM25 full-text index',
      callback: async () => {
        if (!this.isInitialized()) {
          new Notice('Sonar is still initializing. Please wait...');
          return;
        }
        await this.indexManager!.syncBM25Index();
        new Notice('BM25 index synced');
      },
    });

    this.addCommand({
      id: 'clear-bm25-index',
      name: 'Clear BM25 full-text index',
      callback: async () => {
        if (!this.isInitialized()) {
          new Notice('Sonar is still initializing. Please wait...');
          return;
        }
        await this.indexManager!.clearBM25Index();
        new Notice('BM25 index cleared');
      },
    });

    this.addCommand({
      id: 'show-indexable-files-stats',
      name: 'Show indexable files statistics',
      callback: async () => {
        if (!this.isInitialized()) {
          new Notice('Sonar is still initializing. Please wait...');
          return;
        }

        const startTime = Date.now();
        this.updateStatusBar('Calculating statistics...');

        try {
          const stats = await this.indexManager!.getIndexableFilesStats();
          const duration = ((Date.now() - startTime) / 1000).toFixed(2);

          const message = [
            `Indexable Files Statistics (calculated in ${duration}s):`,
            ``,
            `Files: ${stats.fileCount.toLocaleString()}`,
            ``,
            `Tokens:`,
            `  Total: ${stats.totalTokens.toLocaleString()}`,
            `  Average: ${stats.averageTokens.toLocaleString()}`,
            ``,
            `Characters:`,
            `  Total: ${stats.totalCharacters.toLocaleString()}`,
            `  Average: ${stats.averageCharacters.toLocaleString()}`,
            ``,
            `File Size:`,
            `  Total: ${this.formatBytes(stats.totalSize)}`,
            `  Average: ${this.formatBytes(stats.averageSize)}`,
          ].join('\n');

          this.configManager.getLogger().log(message);
          new Notice(message, 0);
        } catch (error) {
          this.configManager
            .getLogger()
            .error(`Failed to calculate statistics: ${error}`);
          new Notice('Failed to calculate statistics - check console');
        } finally {
          await this.updateStatusBarWithFileCount();
        }
      },
    });
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${Math.round((bytes / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`;
  }

  async activateRelatedNotesView() {
    if (!this.isInitialized()) {
      new Notice('Sonar is still initializing. Please wait...');
      return;
    }

    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(RELATED_NOTES_VIEW_TYPE);

    if (leaves.length > 0) {
      leaf = leaves[0];
      workspace.revealLeaf(leaf);
    } else {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        leaf = rightLeaf;
        await leaf.setViewState({
          type: RELATED_NOTES_VIEW_TYPE,
          active: true,
        });
        workspace.revealLeaf(leaf);
      }
    }
  }

  openSemanticNoteFinder(): void {
    if (!this.isInitialized()) {
      new Notice('Sonar is still initializing. Please wait...');
      return;
    }

    const modal = new SemanticNoteFinder(
      this.app,
      this.embeddingSearch!,
      this.configManager,
      this.configManager.getLogger()
    );
    modal.open();
  }

  updateStatusBar(text: string) {
    if (this.statusBarItem) {
      const maxLength = this.configManager.get('statusBarMaxLength');

      // If maxLength is 0, no padding/truncation
      if (maxLength === 0) {
        this.statusBarItem.setText(`Sonar: ${text}`);
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
      this.statusBarItem.setText(`Sonar: ${paddedText}`);
    }
  }

  async updateStatusBarWithFileCount() {
    if (!this.indexManager) {
      this.updateStatusBar('Initializing...');
      return;
    }

    try {
      const stats = await this.indexManager.getStats();
      const indexableCount = getIndexableFilesCount(
        this.app.vault,
        this.configManager
      );
      this.updateStatusBar(
        `Indexed ${stats.totalFiles}/${indexableCount} files`
      );
    } catch {
      this.updateStatusBar('Vector store errored');
    }
  }

  async onunload() {
    this.configManager.getLogger().log('Obsidian Sonar plugin unloaded');
    if (this.indexManager) {
      this.indexManager.cleanup();
    }
    if (this.embeddingStore) {
      await this.embeddingStore.close();
    }
    if (this.bm25Store) {
      await this.bm25Store.close();
    }
  }
}
