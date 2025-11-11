import { Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { SearchManager } from './src/SearchManager';
import { EmbeddingSearch } from './src/EmbeddingSearch';
import { BM25Store } from './src/BM25Store';
import { BM25Search } from './src/BM25Search';
import { DEFAULT_SETTINGS } from './src/config';
import { probeGPU } from './src/GPUProbe';
import {
  RelatedNotesView,
  RELATED_NOTES_VIEW_TYPE,
} from './src/ui/RelatedNotesView';
import { SemanticNoteFinder } from './src/ui/SemanticNoteFinder';
import { IndexManager } from './src/IndexManager';
import { ConfigManager } from './src/ConfigManager';
import { SettingTab } from './src/ui/SettingTab';
import { getDBName, MetadataStore } from './src/MetadataStore';
import { EmbeddingStore } from './src/EmbeddingStore';
import type { Embedder } from './src/Embedder';
import { TransformersEmbedder } from './src/TransformersEmbedder';
import { LlamaCppEmbedder } from './src/LlamaCppEmbedder';
import { BenchmarkRunner } from './src/BenchmarkRunner';
import { DebugRunner } from './src/EmbeddingDebugger';

export default class SonarPlugin extends Plugin {
  configManager!: ConfigManager;
  statusBarItem!: HTMLElement;
  searchManager: SearchManager | null = null;
  indexManager: IndexManager | null = null;
  metadataStore: MetadataStore | null = null;
  embedder: Embedder | null = null;
  debugRunner: DebugRunner | null = null;
  private reinitializing = false;
  private configListeners: Array<() => void> = [];

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
    if (!this.configManager.get('showBackendInStatusBar')) {
      return `Sonar: ${status}`;
    }
    const backend = this.configManager.get('embedderBackend');
    const shortName = backend === 'llamacpp' ? 'llama' : 'tfjs';
    return `Sonar [${shortName}]: ${status}`;
  }

  private async initializeEmbedder(
    embedder: Embedder,
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
      embedder.cleanup();
      this.embedder = null;
      return false;
    }
  }

  private setupConfigListeners(): void {
    const handleBackendChange = async (
      _key: keyof typeof DEFAULT_SETTINGS,
      _value: any
    ) => {
      if (this.reinitializing) {
        return;
      }
      await this.reinitializeBackend();
    };

    this.configListeners.push(
      this.configManager.subscribe('embedderBackend', handleBackendChange)
    );
    this.configListeners.push(
      this.configManager.subscribe('tfjsEmbedderModel', handleBackendChange)
    );
    this.configListeners.push(
      this.configManager.subscribe('llamacppServerPath', handleBackendChange)
    );
    this.configListeners.push(
      this.configManager.subscribe(
        'llamaEmbedderModelRepo',
        handleBackendChange
      )
    );
    this.configListeners.push(
      this.configManager.subscribe(
        'llamaEmbedderModelFile',
        handleBackendChange
      )
    );
  }

  async reinitializeBackend(): Promise<void> {
    if (this.reinitializing) {
      this.warn('Backend reinitialization already in progress');
      return;
    }

    this.reinitializing = true;
    this.statusBarItem.setText(
      this.formatStatusBarText('Switching backend...')
    );

    try {
      this.log('Reinitializing backend...');

      if (this.indexManager) {
        this.indexManager.cleanup();
        this.indexManager = null;
      }
      this.searchManager = null;

      if (this.embedder) {
        this.log('Cleaning up old embedder...');
        this.embedder.cleanup();
        this.embedder = null;
      }

      if (this.metadataStore) {
        this.log('Closing old database...');
        await this.metadataStore.close();
        this.metadataStore = null;
      }

      await this.initializeAsync();

      this.log('Backend reinitialized successfully');
      new Notice('Embedder backend switched successfully');
    } catch (error) {
      this.error(`Failed to reinitialize backend: ${error}`);
      new Notice('Failed to switch embedder backend - check console');
      this.statusBarItem.setText(
        this.formatStatusBarText('Failed to switch backend')
      );
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
    this.statusBarItem.setText(this.formatStatusBarText('Initializing...'));

    // Register commands immediately (lightweight)
    this.registerCommands();
    const settingTab = new SettingTab(this.app, this);
    this.addSettingTab(settingTab);

    this.setupConfigListeners();

    // Defer heavy initialization to avoid blocking plugin load
    this.app.workspace.onLayoutReady(() => this.initializeAsync());
  }

  private async initializeAsync(): Promise<void> {
    const result = await probeGPU();
    if (result.webgpu.available) {
      this.log(
        `Detected WebGPU (fallback: ${result.webgpu.isFallbackAdapter}, ` +
          `features: ${result.webgpu.features?.length ?? 0})`
      );
    } else {
      this.warn(`WebGPU not detected - ${result.webgpu.reason}`);
    }
    if (result.webgl.available) {
      this.log(
        `Detected WebGL (${result.webgl.version}, ${result.webgl.renderer ?? 'unknown'})`
      );
    } else {
      this.warn(`WebGL not detected - ${result.webgl.reason}`);
    }

    const embedderBackend = this.configManager.get('embedderBackend');

    let modelIdentifier: string;

    if (embedderBackend === 'llamacpp') {
      const serverPath = this.configManager.get('llamacppServerPath');
      const modelRepo = this.configManager.get('llamaEmbedderModelRepo');
      const modelFile = this.configManager.get('llamaEmbedderModelFile');
      modelIdentifier = `${modelRepo}/${modelFile}`;

      const embedder = (this.embedder = new LlamaCppEmbedder(
        serverPath,
        modelRepo,
        modelFile,
        this.configManager
      ));
      embedder.setStatusCallback(status =>
        this.statusBarItem.setText(this.formatStatusBarText(status))
      );
      const success = await this.initializeEmbedder(
        embedder,
        'llama.cpp',
        modelIdentifier
      );
      if (!success) return;
    } else {
      const tfjsModel = this.configManager.get('tfjsEmbedderModel');
      modelIdentifier = tfjsModel;

      // Uses Blob URL Worker with inlined code to make Transformers.js think this Electron environment is a browser environment
      const device = result.webgpu.available ? 'webgpu' : 'wasm';
      this.log(`Using Transformers.js with device: ${device}`);

      const embedder = (this.embedder = new TransformersEmbedder(
        tfjsModel,
        this.configManager,
        device,
        'fp32'
      ));
      embedder.setStatusCallback(status =>
        this.statusBarItem.setText(this.formatStatusBarText(status))
      );
      const success = await this.initializeEmbedder(
        embedder,
        'Transformers.js',
        tfjsModel
      );
      if (!success) return;
    }

    try {
      this.metadataStore = await MetadataStore.initialize(
        this.app.vault.getName(),
        embedderBackend,
        modelIdentifier,
        this.configManager
      );
    } catch (error) {
      this.error(`Failed to initialize metadata store: ${error}`);
      new Notice(
        'Failed to initialize metadata store.\n\n' +
          'Check console for details.\n\n' +
          'You can change settings and run "Sonar: Reinitialize Sonar" command to retry.',
        0
      );
      return;
    }

    const db = this.metadataStore.getDB();

    const embeddingStore = new EmbeddingStore(db, this.configManager);

    let bm25Store: BM25Store;
    try {
      bm25Store = await BM25Store.initialize(
        db,
        this.configManager,
        this.embedder
      );
    } catch (error) {
      this.error(`Failed to initialize BM25 store: ${error}`);
      new Notice(
        'Failed to initialize BM25 store.\n\n' +
          'Check console for details.\n\n' +
          'You can change settings and run "Sonar: Reinitialize Sonar" command to retry.',
        0
      );
      return;
    }

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
      this.metadataStore,
      this.configManager
    );

    this.indexManager = new IndexManager(
      this.metadataStore,
      embeddingStore,
      bm25Store,
      this.embedder,
      this.app.vault,
      this.app.workspace,
      this.configManager,
      this.statusBarItem
    );

    this.debugRunner = new DebugRunner(this.configManager, this.embedder);

    this.registerViews(this.searchManager, this.embedder);

    if (this.configManager.get('autoOpenRelatedNotes')) {
      this.activateRelatedNotesView();
    }

    try {
      await this.indexManager.onLayoutReady();
    } catch (error) {
      this.statusBarItem.setText(
        this.formatStatusBarText('Failed to initialize')
      );
      this.error(`Failed to initialize semantic search: ${error}`);
      new Notice(
        'Failed to initialize semantic search.\n\n' +
          'Check console for details.\n\n' +
          'You can change settings and run "Sonar: Reinitialize Sonar" command to retry.',
        0
      );
    }
  }

  private isInitialized(): boolean {
    return this.indexManager !== null;
  }

  private checkInitialized(): boolean {
    if (!this.isInitialized()) {
      new Notice('Sonar is still initializing. Please wait...');
      return false;
    }
    return true;
  }

  private registerViews(
    searchManager: SearchManager,
    embedder: Embedder
  ): void {
    this.registerView(RELATED_NOTES_VIEW_TYPE, leaf => {
      return new RelatedNotesView(
        leaf,
        searchManager,
        this.configManager,
        embedder,
        ext => this.registerEditorExtension(ext),
        processor => this.registerMarkdownPostProcessor(processor)
      );
    });
  }

  private registerCommands(): void {
    this.addCommand({
      id: 'reinitialize-sonar',
      name: 'Reinitialize Sonar',
      callback: async () => {
        await this.reinitializeBackend();
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
                `- ${f.filePath} (failed at ${new Date(f.failedAt).toLocaleString()}, retries: ${f.retryCount})`
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
      callback: async () => {
        await this.deleteAllVaultDatabases();
      },
    });

    this.addCommand({
      id: 'rebuild-index',
      name: 'Rebuild entire search index',
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
      id: 'semantic-search-notes',
      name: 'Semantic search notes',
      callback: () => {
        this.openSemanticNoteFinder();
      },
    });

    this.addCommand({
      id: 'probe-gpu-capabilities',
      name: 'Probe GPU capabilities (WebGPU/WebGL)',
      callback: this.probeGPU,
    });

    this.addCommand({
      id: 'show-indexable-files-stats',
      name: 'Show indexable files statistics',
      callback: async () => {
        if (!this.checkInitialized()) return;
        await this.indexManager!.showIndexableFilesStats();
      },
    });

    this.addCommand({
      id: 'run-benchmark',
      name: 'Run benchmark (BM25, Vector, Hybrid)',
      callback: async () => {
        if (!this.checkInitialized()) return;
        const benchmarkRunner = new BenchmarkRunner(
          this.app,
          this.configManager,
          this.searchManager!,
          this.indexManager!
        );
        try {
          await benchmarkRunner.runBenchmark();
        } catch (error) {
          this.error(`Benchmark failed: ${error}`);
        }
      },
    });

    this.addCommand({
      id: 'debug-generate-sample-embeddings',
      name: 'Debug: Generate sample embeddings',
      callback: () => {
        if (!this.checkInitialized()) return;
        this.debugRunner!.generateSampleEmbeddings();
      },
    });
  }

  async activateRelatedNotesView() {
    if (!this.checkInitialized()) return;

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
    const modal = new SemanticNoteFinder(
      this.app,
      this.searchManager!,
      this.configManager
    );
    modal.open();
  }

  private async probeGPU() {
    const result = await probeGPU();
    const webgpuStatus = result.webgpu.available
      ? `Available${result.webgpu.isFallbackAdapter ? ' (fallback adapter)' : ''}`
      : `Not available - ${result.webgpu.reason}`;
    const webglStatus = result.webgl.available
      ? `Available (${result.webgl.version}${result.webgl.renderer ? `, ${result.webgl.renderer}` : ''})`
      : `Not available - ${result.webgl.reason}`;
    const message = [
      'Graphics Capabilities:',
      '',
      `- WebGPU: ${webgpuStatus}`,
      result.webgpu.available && result.webgpu.features
        ? `  * Features: ${result.webgpu.features.length} available`
        : '',
      '',
      `- WebGL: ${webglStatus}`,
      '',
      `- Electron: ${(window as any).process?.versions?.electron ?? 'N/A'}`,
      `- Chrome: ${(window as any).process?.versions?.chrome ?? 'N/A'}`,
    ]
      .filter(l => l !== '')
      .join('\n');
    new Notice(message, 0);
    this.log('GPU probe result: ' + JSON.stringify(result, null, 2));
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
      const embedderBackend = this.configManager.get('embedderBackend');
      let modelIdentifier: string;
      if (embedderBackend === 'llamacpp') {
        const modelRepo = this.configManager.get('llamaEmbedderModelRepo');
        const modelFile = this.configManager.get('llamaEmbedderModelFile');
        modelIdentifier = `${modelRepo}/${modelFile}`;
      } else {
        modelIdentifier = this.configManager.get('tfjsEmbedderModel');
      }
      const currentDbName = getDBName(
        vaultName,
        embedderBackend,
        modelIdentifier
      );

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
  }

  async onunload() {
    this.log('Obsidian Sonar plugin unloaded');

    this.configListeners.forEach(unsubscribe => unsubscribe());
    this.configListeners = [];

    if (this.indexManager) {
      this.indexManager.cleanup();
    }
    if (this.metadataStore) {
      await this.metadataStore.close();
    }
    if (this.embedder) {
      this.embedder.cleanup();
    }
  }
}
