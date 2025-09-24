import { Notice, Plugin, WorkspaceLeaf, debounce } from 'obsidian';
import { EmbeddingSearch } from './src/EmbeddingSearch';
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
import { VectorStore } from './src/VectorStore';
import { OllamaClient } from './src/OllamaClient';
export default class SonarPlugin extends Plugin {
  configManager!: ConfigManager;
  statusBarItem!: HTMLElement;
  embeddingSearch: EmbeddingSearch | null = null;
  indexManager: IndexManager | null = null;
  vectorStore: VectorStore | null = null;
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

    try {
      this.vectorStore = await VectorStore.initialize(
        this.configManager.getLogger()
      );
    } catch {
      new Notice('Failed to initialize vector store - check console');
      return;
    }

    this.configManager.getLogger().log('Vector store initialized');

    this.embeddingSearch = new EmbeddingSearch(
      this.vectorStore,
      this.ollamaClient,
      this.configManager.get('scoreDecay')
    );
    this.configManager.getLogger().log('Semantic search system initialized');

    this.indexManager = new IndexManager(
      this.vectorStore,
      this.ollamaClient,
      this.app.vault,
      this.app.workspace,
      this.configManager,
      () => this.tokenizer!,
      this.configManager.getLogger(),
      (status: string) => this.updateStatusBarPadded(status),
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
        this.configManager.getLogger()
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
      this.statusBarItem.setText(`Sonar: ${text}`);
    }
  }

  updateStatusBarPadded(text: string) {
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
    if (this.vectorStore) {
      await this.vectorStore.close();
    }
  }
}
