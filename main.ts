import { Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { SearchManager } from './src/SearchManager';
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
import { MetadataStore } from './src/MetadataStore';
import { EmbeddingStore } from './src/EmbeddingStore';
import { OllamaClient } from './src/OllamaClient';
import { formatDuration } from './src/ObsidianUtils';
export default class SonarPlugin extends Plugin {
  configManager!: ConfigManager;
  statusBarItem!: HTMLElement;
  searchManager: SearchManager | null = null;
  indexManager: IndexManager | null = null;
  metadataStore: MetadataStore | null = null;
  tokenizer: Tokenizer | null = null;

  async onload() {
    this.configManager = await ConfigManager.initialize(
      () => this.loadData(),
      data => this.saveData(data),
      DEFAULT_SETTINGS
    );

    // UI elements - needed immediately
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.setText('Sonar: Initializing...');

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
    const ollamaClient = new OllamaClient({
      ollamaUrl,
      model: embeddingModel,
    });
    try {
      await ollamaClient.checkModel();
    } catch {
      new Notice('Failed to connect to Ollama - check console for details');
      return;
    }
    this.configManager
      .getLogger()
      .log(`Ollama initialized with model: ${embeddingModel}`);

    try {
      this.metadataStore = await MetadataStore.initialize();
    } catch {
      new Notice('Failed to initialize metadata store - check console');
      return;
    }
    this.configManager.getLogger().log('MetadataStore initialized');

    const db = this.metadataStore.getDB();

    const embeddingStore = new EmbeddingStore(
      db,
      this.configManager.getLogger()
    );
    this.configManager.getLogger().log('EmbeddingStore initialized');

    let bm25Store: BM25Store;
    try {
      bm25Store = await BM25Store.initialize(
        db,
        this.configManager.getLogger(),
        this.tokenizer
      );
    } catch (error) {
      this.configManager
        .getLogger()
        .error(`Failed to initialize BM25 store: ${error}`);
      new Notice('Failed to initialize BM25 store - check console');
      return;
    }
    this.configManager.getLogger().log('BM25Store initialized');

    const bm25Search = new BM25Search(bm25Store, this.metadataStore);
    this.configManager.getLogger().log('BM25Search initialized');

    const embeddingSearch = new EmbeddingSearch(
      this.metadataStore,
      embeddingStore,
      ollamaClient,
      this.configManager
    );
    this.configManager.getLogger().log('EmbeddingSearch initialized');

    this.searchManager = new SearchManager(
      embeddingSearch,
      bm25Search,
      this.metadataStore
    );
    this.configManager.getLogger().log('SearchManager initialized');

    this.indexManager = new IndexManager(
      this.metadataStore,
      embeddingStore,
      bm25Store,
      ollamaClient,
      this.app.vault,
      this.app.workspace,
      this.configManager,
      () => this.tokenizer!,
      this.statusBarItem
    );

    this.registerViews(this.searchManager);

    if (this.configManager.get('autoOpenRelatedNotes')) {
      this.activateRelatedNotesView();
    }

    try {
      await this.indexManager.onLayoutReady();
    } catch {
      this.statusBarItem.setText('Sonar: Failed to initialize');
      new Notice(
        'Failed to initialize semantic search - Check Ollama is running'
      );
    }
  }

  private isInitialized(): boolean {
    return this.indexManager !== null;
  }

  private registerViews(searchManager: SearchManager): void {
    this.registerView(RELATED_NOTES_VIEW_TYPE, leaf => {
      return new RelatedNotesView(
        leaf,
        searchManager,
        this.configManager,
        () => this.tokenizer!,
        ext => this.registerEditorExtension(ext),
        processor => this.registerMarkdownPostProcessor(processor)
      );
    });
  }

  private registerCommands(): void {
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

    // TODO Delete this command when releasing
    this.addCommand({
      id: 'rebuild-index',
      name: 'Rebuild entire search index',
      callback: async () => {
        if (!this.isInitialized()) {
          new Notice('Sonar is still initializing. Please wait...');
          return;
        }
        await this.indexManager!.rebuildIndex((current, total, filePath) => {
          this.configManager.logger.log(
            `Rebuilding index: ${current}/${total} - ${filePath}`
          );
        });
      },
    });

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
        this.openSemanticNoteFinder();
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
        try {
          const stats = await this.indexManager!.getIndexableFilesStats();
          const duration = formatDuration(Date.now() - startTime);
          const message = [
            `Indexable Files Statistics (calculated in ${duration}):`,
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
      this.searchManager!,
      this.configManager
    );
    modal.open();
  }

  async onunload() {
    this.configManager.getLogger().log('Obsidian Sonar plugin unloaded');
    if (this.indexManager) {
      this.indexManager.cleanup();
    }
    if (this.metadataStore) {
      await this.metadataStore.close();
    }
  }
}
