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

export default class ObsidianSonarPlugin extends Plugin {
  configManager!: ConfigManager;
  statusBarItem!: HTMLElement;
  embeddingSearch: EmbeddingSearch | null = null;
  indexManager: IndexManager | null = null;
  vectorStore: VectorStore | null = null;
  ollamaClient: OllamaClient | null = null;

  async onload() {
    // Critical initialization - needed immediately
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

    // Setup notification handler (lightweight)
    this.setupNotificationHandler();

    // Defer heavy initialization to avoid blocking plugin load
    this.app.workspace.onLayoutReady(() => this.initializeAsync());
  }

  private async initializeAsync(): Promise<void> {
    try {
      const embeddingModel = this.configManager.get('embeddingModel');
      const tokenizerModel = this.configManager.get('tokenizerModel');
      await Tokenizer.initialize(embeddingModel, tokenizerModel || undefined);
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

    try {
      // Initialize Ollama client
      const ollamaUrl = this.configManager.get('ollamaUrl');
      const embeddingModel = this.configManager.get('embeddingModel');

      this.ollamaClient = new OllamaClient({
        ollamaUrl,
        model: embeddingModel,
      });

      await this.ollamaClient.checkModel();
      console.log(`Ollama initialized with model: ${embeddingModel}`);

      // Initialize vector store
      this.vectorStore = await VectorStore.initialize();
      console.log('Vector store initialized');

      // Initialize search interface (read-only)
      this.embeddingSearch = new EmbeddingSearch(
        this.vectorStore,
        this.ollamaClient
      );
      console.log('Semantic search system initialized');

      // Initialize index manager (handles all DB modifications)
      this.indexManager = new IndexManager(
        this.vectorStore,
        this.ollamaClient,
        this.app.vault,
        this.configManager,
        (status: string) => this.updateStatusBarPadded(status),
        () => this.updateStatusBarWithFileCount()
      );

      this.updateStatusBarWithFileCount();

      this.registerViews(this.embeddingSearch);
      // Auto-open related notes view if configured
      if (this.configManager.get('autoOpenRelatedNotes')) {
        this.activateRelatedNotesView();
      }
      this.setupEventHandlers();

      // Initialize IndexManager's event handlers and smart sync
      await this.indexManager.onLayoutReady();
    } catch {
      this.updateStatusBar('Sonar: Failed to initialize');
      new Notice(
        'Failed to initialize semantic search - Check Ollama is running'
      );
    }
  }

  private setupNotificationHandler(): void {
    Tokenizer.setFallbackNotification((message, type) => {
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
  }

  private isInitialized(): boolean {
    return this.embeddingSearch !== null && this.indexManager !== null;
  }

  private registerViews(embeddingSearch: EmbeddingSearch): void {
    this.registerView(RELATED_NOTES_VIEW_TYPE, leaf => {
      return new RelatedNotesView(leaf, embeddingSearch, this.configManager);
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
        await this.indexManager!.rebuildIndex(async (current, total) => {
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
      this.configManager
    );
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
    if (!this.indexManager) {
      this.updateStatusBar('Sonar: Initializing...');
      return;
    }

    try {
      const stats = await this.indexManager.getStats();
      const indexableCount = getIndexableFilesCount(
        this.app.vault,
        this.configManager
      );
      this.updateStatusBar(
        `Sonar: Indexed ${stats.totalFiles}/${indexableCount} files`
      );
    } catch {
      this.updateStatusBar('Sonar: Vector store errored');
    }
  }

  async onunload() {
    console.log('Obsidian Sonar plugin unloaded');
    if (this.indexManager) {
      this.indexManager.cleanup();
    }
    if (this.vectorStore) {
      await this.vectorStore.close();
    }
  }
}
