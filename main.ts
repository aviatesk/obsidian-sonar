import { Notice, Plugin, setTooltip, TFile, WorkspaceLeaf } from 'obsidian';
import { SearchManager } from './src/SearchManager';
import { EmbeddingSearch } from './src/EmbeddingSearch';
import { BM25Store } from './src/BM25Store';
import { BM25Search } from './src/BM25Search';
import { DEFAULT_SETTINGS } from './src/config';
import {
  RelatedNotesView,
  RELATED_NOTES_VIEW_TYPE,
} from './src/ui/RelatedNotesView';
import {
  SemanticNoteFinder,
  SEMANTIC_NOTE_FINDER_SOURCE,
} from './src/ui/SemanticNoteFinder';
import { IndexManager } from './src/IndexManager';
import { ConfigManager } from './src/ConfigManager';
import { SettingTab } from './src/ui/SettingTab';
import { getDBName, MetadataStore } from './src/MetadataStore';
import { EmbeddingStore } from './src/EmbeddingStore';
import { LlamaCppEmbedder } from './src/LlamaCppEmbedder';
import { LlamaCppReranker } from './src/LlamaCppReranker';
import { CHAT_VIEW_TYPE, ChatView } from './src/ui/ChatView';
import { isAudioExtension } from './src/audio';
import { confirmAction } from './src/obsidian-utils';
import {
  sonarState,
  getState,
  checkSearchReady,
  checkHasFailure,
} from './src/SonarState';

export default class SonarPlugin extends Plugin {
  configManager!: ConfigManager;
  statusBarItem!: HTMLElement;
  searchManager: SearchManager | null = null;
  indexManager: IndexManager | null = null;
  metadataStore: MetadataStore | null = null;
  embedder: LlamaCppEmbedder | null = null;
  reranker: LlamaCppReranker | null = null;
  private semanticNoteFinder: SemanticNoteFinder | null = null;
  private reinitializing = false;
  private indexUpdateUnsubscribe: (() => void) | null = null;

  private log(msg: string): void {
    this.configManager.getLogger().log(`[Sonar.Plugin] ${msg}`);
  }

  private error(msg: string): void {
    this.configManager.getLogger().error(`[Sonar.Plugin] ${msg}`);
  }

  private warn(msg: string): void {
    this.configManager.getLogger().warn(`[Sonar.Plugin] ${msg}`);
  }

  private formatStatusBarText(status: string): string {
    return `Sonar: ${status}`;
  }

  updateStatusBar(text: string, tooltip?: string): void {
    const maxLength = this.configManager.get('statusBarMaxLength');
    const fullText = this.formatStatusBarText(text);

    // Always set tooltip to show full text (use custom tooltip if provided)
    setTooltip(
      this.statusBarItem,
      tooltip ? this.formatStatusBarText(tooltip) : fullText,
      { placement: 'top', gap: 8 }
    );

    let paddedText = text;
    if (maxLength > 0 && text.length > maxLength) {
      // Need at least 4 characters for ellipsis truncation (e.g., "a...b")
      if (maxLength >= 4) {
        const halfLength = Math.floor((maxLength - 3) / 2);
        const prefix = text.slice(0, halfLength);
        const suffix = text.slice(-(maxLength - halfLength - 3));
        paddedText = prefix + '...' + suffix;
      } else {
        // For very short maxLength, just truncate
        paddedText = text.slice(0, maxLength);
      }
    } else if (maxLength > 0) {
      paddedText = text.padEnd(maxLength);
    }
    this.statusBarItem.setText(this.formatStatusBarText(paddedText));
  }

  /**
   * Show confirmation dialog for model download
   * Used by ChatView for chat model downloads
   */
  confirmModelDownload(modelType: string, modelId: string): Promise<boolean> {
    return confirmAction(
      this.app,
      `Download ${modelType} model?`,
      `The ${modelType} model is not cached and needs to be downloaded:\n\n` +
        `\`${modelId}\`\n\n` +
        `If you want to use a different model, select **Cancel** and change ` +
        `the model settings in **Settings → Sonar**, then reinitialize.`,
      'Download'
    );
  }

  private async initializeEmbedder(
    embedder: LlamaCppEmbedder,
    backendName: string,
    modelDescription: string
  ): Promise<boolean> {
    try {
      await embedder.initialize();
      this.log(`${backendName} embedder initialized: ${modelDescription}`);
      return true;
    } catch (error) {
      this.error(`Failed to initialize ${backendName} embedder: ${error}`);
      new Notice(
        `Failed to initialize ${backendName} embedder.\n\n` +
          `Check console for details.\n\n` +
          `You can change settings and run "Sonar: Reinitialize Sonar" command to retry.`,
        0
      );
      await embedder.cleanup();
      return false;
    }
  }

  private async initializeReranker(
    reranker: LlamaCppReranker,
    modelDescription: string
  ): Promise<boolean> {
    try {
      await reranker.initialize();
      this.log(`Reranker initialized: ${modelDescription}`);
      return true;
    } catch (error) {
      this.warn(`Failed to initialize reranker: ${error}`);
      await reranker.cleanup();
      return false;
    }
  }

  async reinitializeSonar(): Promise<void> {
    if (this.reinitializing) {
      this.warn('Sonar reinitialization already in progress');
      return;
    }

    this.reinitializing = true;
    sonarState.setStatusBarText('Reinitializing...');

    try {
      this.log('Reinitializing Sonar...');

      if (this.indexUpdateUnsubscribe) {
        this.indexUpdateUnsubscribe();
        this.indexUpdateUnsubscribe = null;
      }
      this.semanticNoteFinder = null;

      if (this.indexManager) {
        this.indexManager.cleanup();
        this.indexManager = null;
      }
      this.searchManager = null;

      if (this.embedder) {
        this.log('Cleaning up old embedder...');
        await this.embedder.cleanup();
        this.embedder = null;
      }

      if (this.reranker) {
        this.log('Cleaning up old reranker...');
        await this.reranker.cleanup();
        this.reranker = null;
      }

      if (this.metadataStore) {
        this.log('Closing old database...');
        await this.metadataStore.close();
        this.metadataStore = null;
      }

      sonarState.reset();

      const success = await this.initializeAsync();
      if (!success) return;

      this.log('Sonar reinitialized successfully');
      new Notice('Sonar reinitialized successfully');
    } catch (error) {
      this.error(`Failed to reinitialize Sonar: ${error}`);
      new Notice('Failed to reinitialize Sonar - check console');
    } finally {
      this.reinitializing = false;
    }
  }

  async onload() {
    this.configManager = await ConfigManager.initialize(
      () => this.loadData(),
      data => this.saveData(data),
      DEFAULT_SETTINGS
    );

    // UI elements - needed immediately
    this.statusBarItem = this.addStatusBarItem();

    // Subscribe to state changes for reactive status bar updates
    const unsubscribe = sonarState.subscribe(state => {
      // Derive final status from ModelStatus (failures take priority)
      if (checkHasFailure(state)) {
        this.updateStatusBar('Initialization failed');
        return;
      }
      if (checkSearchReady(state)) {
        // Once ready, IndexManager takes over status bar updates
        // via statusBarText for showing index progress
      }
      // Show progress text from components
      this.updateStatusBar(state.statusBarText, state.statusBarTooltip);
    });
    this.register(() => unsubscribe());

    // Register commands immediately (lightweight)
    this.registerCommands();
    this.registerFileMenuHandlers();
    const settingTab = new SettingTab(this.app, this);
    this.addSettingTab(settingTab);

    // Register views once
    this.registerViews();

    // Register quit event for cleanup when Obsidian closes
    // Note: onunload() is NOT called when Obsidian closes, only on plugin reload
    // The quit event is not guaranteed to complete - OS may kill process at any time
    this.registerEvent(
      this.app.workspace.on('quit', () => {
        this.log('Quit event triggered, performing cleanup...');
        // Fire-and-forget: best effort cleanup before process terminates
        this.performCleanup().catch(error => {
          this.error(`Cleanup during quit failed: ${error}`);
        });
      })
    );

    // Defer heavy initialization to avoid blocking plugin load
    this.app.workspace.onLayoutReady(() => {
      if (this.configManager.get('autoOpenRelatedNotes')) {
        this.activateRelatedNotesView();
      }
      this.initializeAsync();
    });
  }

  private createConfirmDownload(
    modelType: string
  ): (modelId: string) => Promise<boolean> {
    return (modelId: string) => this.confirmModelDownload(modelType, modelId);
  }

  private async initializeAsync(): Promise<boolean> {
    const serverPath = this.configManager.get('llamacppServerPath');

    const embedderModelRepo =
      this.configManager.get('llamaEmbedderModelRepo') ||
      DEFAULT_SETTINGS.llamaEmbedderModelRepo;
    const embedderModelFile =
      this.configManager.get('llamaEmbedderModelFile') ||
      DEFAULT_SETTINGS.llamaEmbedderModelFile;
    const embedderModelIdentifier = `${embedderModelRepo}/${embedderModelFile}`;
    const embedder = (this.embedder = new LlamaCppEmbedder(
      serverPath,
      embedderModelRepo,
      embedderModelFile,
      this.configManager,
      status => sonarState.setEmbedderStatus(status),
      (msg, duration) => new Notice(msg, duration),
      this.createConfirmDownload('embedder')
    ));

    const rerankerModelRepo =
      this.configManager.get('llamaRerankerModelRepo') ||
      DEFAULT_SETTINGS.llamaRerankerModelRepo;
    const rerankerModelFile =
      this.configManager.get('llamaRerankerModelFile') ||
      DEFAULT_SETTINGS.llamaRerankerModelFile;
    const rerankerModelIdentifier = `${rerankerModelRepo}/${rerankerModelFile}`;
    const reranker = (this.reranker = new LlamaCppReranker(
      serverPath,
      rerankerModelRepo,
      rerankerModelFile,
      this.configManager,
      status => sonarState.setRerankerStatus(status),
      (msg, duration) => new Notice(msg, duration),
      this.createConfirmDownload('reranker')
    ));

    const [embedderInitialized] = await Promise.all([
      this.initializeEmbedder(embedder, 'llama.cpp', embedderModelIdentifier),
      this.initializeReranker(reranker, rerankerModelIdentifier),
    ]);
    if (!embedderInitialized) return false;

    sonarState.setMetadataStoreStatus('initializing');
    sonarState.setStatusBarText('Loading metadata store...');
    try {
      this.metadataStore = await MetadataStore.initialize(
        this.app.vault.getName(),
        embedderModelIdentifier,
        this.configManager
      );
    } catch (error) {
      sonarState.setMetadataStoreStatus('failed');
      this.error(`Failed to initialize metadata store: ${error}`);
      new Notice(
        'Failed to initialize metadata store.\n\n' +
          'Check console for details.\n\n' +
          'You can change settings and run "Sonar: Reinitialize Sonar" command to retry.',
        0
      );
      return false;
    }

    sonarState.setMetadataStoreStatus('ready');

    const db = this.metadataStore.getDB();
    const embeddingStore = new EmbeddingStore(db, this.configManager);
    let bm25Store: BM25Store;
    sonarState.setBm25StoreStatus('initializing');
    sonarState.setStatusBarText('Loading BM25 store...');
    try {
      bm25Store = await BM25Store.initialize(db, this.configManager);
    } catch (error) {
      sonarState.setBm25StoreStatus('failed');
      this.error(`Failed to initialize BM25 store: ${error}`);
      new Notice(
        'Failed to initialize BM25 store.\n\n' +
          'Check console for details.\n\n' +
          'You can change settings and run "Sonar: Reinitialize Sonar" command to retry.',
        0
      );
      return false;
    }
    sonarState.setBm25StoreStatus('ready');

    const bm25Search = new BM25Search(
      bm25Store,
      this.metadataStore,
      this.configManager
    );

    const embeddingSearch = new EmbeddingSearch(
      this.metadataStore,
      embeddingStore,
      this.embedder,
      this.configManager
    );

    this.searchManager = new SearchManager(
      embeddingSearch,
      bm25Search,
      this.reranker!,
      this.configManager
    );

    this.indexManager = new IndexManager(
      this.metadataStore,
      embeddingStore,
      bm25Store,
      this.embedder,
      this.app.vault,
      this.app.workspace,
      this.configManager
    );

    try {
      await this.indexManager.onLayoutReady();
    } catch (error) {
      this.error(`Failed to initialize Sonar: ${error}`);
      new Notice(
        'Failed to initialize Sonar.\n\n' +
          'Check console for details.\n\n' +
          'You can change settings and run "Reinitialize Sonar" action/command to retry.',
        0
      );
      return false;
    }

    this.indexUpdateUnsubscribe = this.indexManager.onIndexUpdated(() => {
      this.semanticNoteFinder?.invalidateCache();
    });

    return true;
  }

  private isInitialized(): boolean {
    return this.indexManager !== null;
  }

  private checkInitialized(): boolean {
    if (!this.isInitialized()) {
      const state = getState();
      if (state.embedder === 'failed') {
        new Notice(
          'Embedder initialization failed.\n\n' +
            'Check llama.cpp configuration in Settings → Sonar, ' +
            'then run "Reinitialize Sonar".'
        );
      } else if (state.metadataStore === 'failed') {
        new Notice(
          'Metadata store initialization failed.\n\n' +
            'Check the console for details, ' +
            'then run "Reinitialize Sonar".'
        );
      } else if (state.bm25Store === 'failed') {
        new Notice(
          'BM25 store initialization failed.\n\n' +
            'Check the console for details, ' +
            'then run "Reinitialize Sonar".'
        );
      } else if (
        state.embedder !== 'ready' ||
        state.metadataStore !== 'ready' ||
        state.bm25Store !== 'ready'
      ) {
        new Notice('Sonar is still initializing. Please wait...');
      } else {
        new Notice(
          'Sonar initialization failed.\n\n' +
            'Check the console for details, ' +
            'then run "Reinitialize Sonar".'
        );
      }
      return false;
    }
    return true;
  }

  private registerViews(): void {
    this.registerView(RELATED_NOTES_VIEW_TYPE, leaf => {
      return new RelatedNotesView(leaf, this, this.configManager);
    });
    this.registerView(CHAT_VIEW_TYPE, leaf => {
      return new ChatView(leaf, this, this.configManager);
    });
    this.registerHoverLinkSource(SEMANTIC_NOTE_FINDER_SOURCE, {
      display: 'Sonar: Semantic note finder',
      defaultMod: true,
    });
    this.registerHoverLinkSource(RELATED_NOTES_VIEW_TYPE, {
      display: 'Sonar: Related notes',
      defaultMod: true,
    });
    this.registerHoverLinkSource(CHAT_VIEW_TYPE, {
      display: 'Sonar: Chat',
      defaultMod: true,
    });
  }

  private registerCommands(): void {
    this.addCommand({
      id: 'reinitialize-sonar',
      name: 'Reinitialize Sonar',
      callback: async () => {
        await this.reinitializeSonar();
      },
    });

    this.addCommand({
      id: 'sync-index',
      name: 'Sync search index with vault',
      callback: async () => {
        if (!this.checkInitialized()) return;
        await this.indexManager!.syncIndex();
      },
    });

    this.addCommand({
      id: 'clear-current-index',
      name: 'Clear current search index',
      callback: async () => {
        if (!this.checkInitialized()) return;
        const confirmed = await this.configManager.confirmClearCurrentIndex(
          this.app
        );
        if (!confirmed) return;
        await this.indexManager!.clearCurrentIndex();
        new Notice('Current index cleared');
      },
    });

    this.addCommand({
      id: 'show-failed-files',
      name: 'Show files that failed to index',
      callback: async () => {
        if (!this.checkInitialized()) return;
        const failedFiles = await this.metadataStore!.getAllFailedFiles();
        if (failedFiles.length === 0) {
          new Notice('No files have failed to index');
        } else {
          const message = [
            `Files that failed to index (${failedFiles.length}):`,
            '',
            ...failedFiles.map(
              f =>
                `- ${f.filePath} (failed at ${new Date(f.failedAt).toLocaleString()})`
            ),
          ].join('\n');
          this.log(message);
          new Notice(
            `${failedFiles.length} files failed to index - check console for details`,
            0
          );
        }
      },
    });

    this.addCommand({
      id: 'delete-vault-databases',
      name: 'Delete all search databases for this vault',
      callback: () => this.deleteAllVaultDatabases(),
    });

    this.addCommand({
      id: 'rebuild-index',
      name: 'Rebuild current search index',
      callback: async () => {
        if (!this.checkInitialized()) return;
        const confirmed = await this.configManager.confirmRebuildIndex(
          this.app
        );
        if (!confirmed) return;
        await this.indexManager!.rebuildIndex((current, total, filePath) => {
          this.log(`Rebuilding index: ${current}/${total} - ${filePath}`);
        });
      },
    });

    this.addCommand({
      id: 'index-current-file',
      name: 'Index current file',
      callback: async () => {
        if (!this.checkInitialized()) return;
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
      id: 'open-semantic-note-finder',
      name: 'Open Semantic note finder',
      callback: () => {
        this.openSemanticNoteFinder();
      },
    });

    this.addCommand({
      id: 'open-chat',
      name: 'Open chat view',
      callback: () => {
        this.activateChatView();
      },
    });

    this.addCommand({
      id: 'show-indexable-files-stats',
      name: 'Show indexable files statistics',
      callback: async () => {
        if (!this.checkInitialized()) return;
        await this.indexManager!.showIndexableFilesStats();
      },
    });

    // Register benchmark commands conditionally (only in development builds)
    if (process.env.INCLUDE_BENCHMARK === 'true') {
      this.registerBenchmarkCommands();
    }
  }

  private async registerBenchmarkCommands(): Promise<void> {
    const { registerRetrievalBenchmarkCommands } = await import(
      './retrieval-bench/src/index'
    );
    const {
      registerCragBenchmarkCommands,
      registerCragUnifiedBenchmarkCommands,
    } = await import('./rag-bench/src/index');
    registerRetrievalBenchmarkCommands(this);
    registerCragBenchmarkCommands(this);
    registerCragUnifiedBenchmarkCommands(this);
  }

  private registerFileMenuHandlers(): void {
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile)) return;
        if (!file.extension) return;

        if (isAudioExtension(file.extension)) {
          menu.addItem(item => {
            item
              .setTitle('Create transcription note')
              .setIcon('file-text')
              .onClick(() => this.createTranscriptionNote(file));
          });
        } else if (file.extension === 'pdf') {
          menu.addItem(item => {
            item
              .setTitle('Create PDF extract note')
              .setIcon('file-text')
              .onClick(() => this.createPdfExtractNote(file));
          });
        }
      })
    );
  }

  private async createTranscriptionNote(audioFile: TFile): Promise<void> {
    if (!this.checkInitialized()) return;

    const chunks = await this.metadataStore!.getChunksByFile(audioFile.path);
    if (chunks.length === 0) {
      new Notice(
        `No transcription found for ${audioFile.name}.\n\n` +
          'Please index this file first.'
      );
      return;
    }

    // Sort chunks by id (which includes chunk index) and join content
    chunks.sort((a, b) => a.id.localeCompare(b.id));
    const transcriptionText = chunks.map(c => c.content).join('\n\n');

    const audioFolder = audioFile.parent?.path || '';
    const noteName = audioFile.basename;
    const notePath = audioFolder
      ? `${audioFolder}/${noteName}.md`
      : `${noteName}.md`;

    const existingFile = this.app.vault.getAbstractFileByPath(notePath);
    if (existingFile) {
      new Notice(`Note already exists: ${notePath}`);
      const leaf = this.app.workspace.getLeaf();
      await leaf.openFile(existingFile as TFile);
      return;
    }

    const content = `[[${audioFile.name}]]\n\n${transcriptionText}`;
    const newFile = await this.app.vault.create(notePath, content);
    new Notice(`Created transcription note: ${notePath}`);

    const leaf = this.app.workspace.getLeaf();
    await leaf.openFile(newFile);
  }

  private async createPdfExtractNote(pdfFile: TFile): Promise<void> {
    if (!this.checkInitialized()) return;

    const chunks = await this.metadataStore!.getChunksByFile(pdfFile.path);
    if (chunks.length === 0) {
      new Notice(
        `No extracted text found for ${pdfFile.name}.\n\n` +
          'Please index this file first.'
      );
      return;
    }

    chunks.sort((a, b) => a.id.localeCompare(b.id));
    const extractedText = chunks.map(c => c.content).join('\n\n');

    const pdfFolder = pdfFile.parent?.path || '';
    const noteName = pdfFile.basename;
    const notePath = pdfFolder
      ? `${pdfFolder}/${noteName}.md`
      : `${noteName}.md`;

    const existingFile = this.app.vault.getAbstractFileByPath(notePath);
    if (existingFile) {
      new Notice(`Note already exists: ${notePath}`);
      const leaf = this.app.workspace.getLeaf();
      await leaf.openFile(existingFile as TFile);
      return;
    }

    const content = `[[${pdfFile.name}]]\n\n${extractedText}`;
    const newFile = await this.app.vault.create(notePath, content);
    new Notice(`Created PDF extract note: ${notePath}`);

    const leaf = this.app.workspace.getLeaf();
    await leaf.openFile(newFile);
  }

  async activateRelatedNotesView() {
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
    if (!this.checkInitialized()) return;
    (this.semanticNoteFinder ??= new SemanticNoteFinder(
      this.app,
      this.searchManager!,
      this.configManager
    )).open();
  }

  async activateChatView(): Promise<void> {
    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(CHAT_VIEW_TYPE);

    if (leaves.length > 0) {
      leaf = leaves[0];
      workspace.revealLeaf(leaf);
    } else {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        leaf = rightLeaf;
        await leaf.setViewState({
          type: CHAT_VIEW_TYPE,
          active: true,
        });
        workspace.revealLeaf(leaf);
      }
    }
  }

  async deleteAllVaultDatabases(): Promise<void> {
    const vaultName = this.app.vault.getName();
    const databases = await MetadataStore.listDatabasesForVault(vaultName);

    if (databases.length === 0) {
      new Notice(`No indices found for vault: ${vaultName}`);
      return;
    }

    this.log(
      `Found ${databases.length} database(s) for vault ${vaultName}: ${databases.join(', ')}`
    );

    const confirmed = await this.configManager.confirmDeleteAllVaultDatabases(
      this.app,
      vaultName,
      databases
    );
    if (!confirmed) {
      return;
    }

    // Close current database connections if they're in the list to be deleted
    if (this.metadataStore) {
      const modelRepo = this.configManager.get('llamaEmbedderModelRepo');
      const modelFile = this.configManager.get('llamaEmbedderModelFile');
      const modelIdentifier = `${modelRepo}/${modelFile}`;
      const currentDbName = getDBName(vaultName, modelIdentifier);

      if (databases.includes(currentDbName)) {
        this.log(`Closing current database before deletion: ${currentDbName}`);
        await this.metadataStore.close();
        this.metadataStore = null;
        if (this.indexManager) {
          this.indexManager.cleanup();
          this.indexManager = null;
        }
      }
    }

    let deletedCount = 0;
    for (const dbName of databases) {
      try {
        await MetadataStore.deleteDatabase(dbName);
        deletedCount++;
        this.log(`Deleted database: ${dbName}`);
      } catch (error) {
        this.error(`Failed to delete database ${dbName}: ${error}`);
      }
    }

    if (deletedCount > 0) {
      new Notice(`Deleted ${deletedCount} database(s).`, 0);
      this.log(`Deleted ${deletedCount} database(s) for vault ${vaultName}`);
    } else {
      new Notice('Failed to delete any databases - check console');
    }

    this.reinitializeSonar();
  }

  private async performCleanup(): Promise<void> {
    if (this.indexUpdateUnsubscribe) {
      this.indexUpdateUnsubscribe();
      this.indexUpdateUnsubscribe = null;
    }
    this.semanticNoteFinder = null;
    if (this.indexManager) {
      this.indexManager.cleanup();
    }
    if (this.metadataStore) {
      await this.metadataStore.close();
    }
    // Run server cleanups in parallel to maximize chance of completion
    // before quit event terminates the process
    await Promise.all([this.embedder?.cleanup(), this.reranker?.cleanup()]);
  }

  async onunload() {
    this.log('Obsidian Sonar plugin unloaded');
    await this.performCleanup();
  }
}
