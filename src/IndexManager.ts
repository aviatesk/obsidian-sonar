import {
  TAbstractFile,
  TFile,
  Vault,
  EventRef,
  Notice,
  debounce,
} from 'obsidian';
import { ObsidianEmbeddingSearch } from './embeddingSearch';
import { ConfigManager } from './ConfigManager';
import { shouldIndexFile, getIndexableFiles } from './fileFilters';

interface FileOperation {
  type: 'create' | 'modify' | 'delete' | 'rename';
  file: TFile | null;
  oldPath?: string;
}

export class IndexManager {
  private embeddingSearch: ObsidianEmbeddingSearch;
  private vault: Vault;
  private configManager: ConfigManager;
  private pendingOperations: Map<string, FileOperation> = new Map();
  private debouncedProcess: () => void;
  private eventRefs: EventRef[] = [];
  private isProcessing: boolean = false;
  private indexedFiles: Set<string> = new Set();
  private configUnsubscribers: Array<() => void> = [];
  private isInitialized: boolean = false;
  private statusUpdateCallback: (status: string) => void;
  private onProcessingCompleteCallback: () => void;

  constructor(
    embeddingSearch: ObsidianEmbeddingSearch,
    vault: Vault,
    configManager: ConfigManager,
    statusUpdateCallback: (status: string) => void,
    onProcessingCompleteCallback: () => void
  ) {
    this.embeddingSearch = embeddingSearch;
    this.vault = vault;
    this.configManager = configManager;
    this.statusUpdateCallback = statusUpdateCallback;
    this.onProcessingCompleteCallback = onProcessingCompleteCallback;

    const debounceMs = configManager.get('indexDebounceMs');
    this.debouncedProcess = debounce(
      () => this.processPendingOperations(),
      debounceMs,
      true
    );

    this.setupConfigListeners();

    this.loadIndexedFiles()
      .then(() => {
        console.log(
          `IndexManager: Loaded ${this.indexedFiles.size} indexed files`
        );
      })
      .catch(error => {
        console.error('IndexManager: Failed to load indexed files:', error);
        this.indexedFiles = new Set();
      });
  }

  /**
   * Initialize after layout is ready to avoid startup event spam
   */
  onLayoutReady(): void {
    this.isInitialized = true;

    if (this.configManager.get('autoIndex')) {
      this.registerEventHandlers();
      console.log('IndexManager: Auto-indexing enabled');
    } else {
      console.log('IndexManager: Auto-indexing disabled');
    }
  }

  private setupConfigListeners(): void {
    // Listen for auto-index changes
    this.configUnsubscribers.push(
      this.configManager.subscribe('autoIndex', (_key, value) => {
        if (this.isInitialized) {
          if (value) {
            this.registerEventHandlers();
            console.log('IndexManager: Auto-indexing enabled');
          } else {
            this.unregisterEventHandlers();
            console.log('IndexManager: Auto-indexing disabled');
          }
        }
      })
    );

    this.configUnsubscribers.push(
      this.configManager.subscribe('excludedPaths', () => {
        if (!this.isInitialized) return; // Skip during initialization
        console.log('IndexManager: Excluded paths updated, resyncing...');
        // Run sync asynchronously to avoid blocking
        this.syncIndex().catch(error =>
          console.error(
            'IndexManager: Failed to sync after excluded paths change:',
            error
          )
        );
      })
    );

    this.configUnsubscribers.push(
      this.configManager.subscribe('indexPath', () => {
        if (!this.isInitialized) return; // Skip during initialization
        console.log('IndexManager: Index path updated, reloading...');
        // Run reload and sync asynchronously to avoid blocking
        this.reloadIndexedFiles()
          .then(() => this.syncIndex())
          .catch(error =>
            console.error(
              'IndexManager: Failed to reload/sync after index path change:',
              error
            )
          );
      })
    );
  }

  private async loadIndexedFiles(): Promise<void> {
    this.indexedFiles = await this.embeddingSearch.getIndexedFiles();
  }

  async reloadIndexedFiles(): Promise<void> {
    await this.loadIndexedFiles();
  }

  private registerEventHandlers(): void {
    this.eventRefs.push(
      this.vault.on('create', (file: TAbstractFile) => {
        if (
          file instanceof TFile &&
          shouldIndexFile(file, this.configManager)
        ) {
          this.scheduleOperation({
            type: 'create',
            file: file,
          });
        }
      })
    );

    this.eventRefs.push(
      this.vault.on('modify', (file: TAbstractFile) => {
        if (
          file instanceof TFile &&
          shouldIndexFile(file, this.configManager)
        ) {
          this.scheduleOperation({
            type: 'modify',
            file: file,
          });
        }
      })
    );

    this.eventRefs.push(
      this.vault.on('delete', (file: TAbstractFile) => {
        if (file instanceof TFile && this.indexedFiles.has(file.path)) {
          this.scheduleOperation({
            type: 'delete',
            file: null,
            oldPath: file.path,
          });
        }
      })
    );

    this.eventRefs.push(
      this.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
        if (file instanceof TFile) {
          const wasIndexed = this.indexedFiles.has(oldPath);
          const shouldIndex = shouldIndexFile(file, this.configManager);

          if (wasIndexed && !shouldIndex) {
            this.scheduleOperation({
              type: 'delete',
              file: null,
              oldPath: oldPath,
            });
          } else if (!wasIndexed && shouldIndex) {
            this.scheduleOperation({
              type: 'create',
              file: file,
            });
          } else if (wasIndexed && shouldIndex) {
            this.scheduleOperation({
              type: 'rename',
              file: file,
              oldPath: oldPath,
            });
          }
        }
      })
    );
  }

  private scheduleOperation(operation: FileOperation): void {
    const key = operation.oldPath || operation.file?.path || '';

    if (!key) return;

    const existing = this.pendingOperations.get(key);

    if (existing) {
      if (existing.type === 'create' && operation.type === 'modify') {
        return;
      } else if (existing.type === 'create' && operation.type === 'delete') {
        this.pendingOperations.delete(key);
        return;
      } else if (existing.type === 'modify' && operation.type === 'delete') {
        this.pendingOperations.set(key, operation);
      }
    } else {
      this.pendingOperations.set(key, operation);
    }

    this.debouncedProcess();
  }

  private async processPendingOperations(): Promise<void> {
    if (this.isProcessing || this.pendingOperations.size === 0) {
      return;
    }

    this.isProcessing = true;
    const operations = Array.from(this.pendingOperations.values());
    this.pendingOperations.clear();

    if (operations.length > 0) {
      console.log(
        `IndexManager: Processing ${operations.length} file operation(s)`
      );
    }

    let successCount = 0;
    let errorCount = 0;
    const totalOperations = operations.length;

    for (let i = 0; i < operations.length; i++) {
      const operation = operations[i];
      try {
        const fileName =
          operation.file?.basename || operation.oldPath || 'unknown';
        this.updateStatus({
          file: fileName,
          current: i + 1,
          total: totalOperations,
        });
        await this.processOperation(operation);
        successCount++;
      } catch (error) {
        const filePath = operation.file?.path || operation.oldPath || 'unknown';
        console.error(
          `IndexManager: Failed to ${operation.type} ${filePath}:`,
          error
        );
        errorCount++;
      }
    }

    if (errorCount > 0) {
      if (errorCount > 0) {
        new Notice(`Sonar index failed to update ${errorCount} files`);
      }
    }

    this.isProcessing = false;

    this.onProcessingCompleteCallback();
  }

  private async processOperation(operation: FileOperation): Promise<void> {
    switch (operation.type) {
      case 'create':
      case 'modify':
        if (operation.file) {
          await this.embeddingSearch.indexFile(operation.file);
          this.indexedFiles.add(operation.file.path);
          console.log(`IndexManager: Indexed ${operation.file.path}`);
        }
        break;

      case 'delete':
        if (operation.oldPath) {
          await this.deleteFromIndex(operation.oldPath);
          this.indexedFiles.delete(operation.oldPath);
          console.log(`IndexManager: Deleted ${operation.oldPath} from index`);
        }
        break;

      case 'rename':
        if (operation.oldPath && operation.file) {
          await this.deleteFromIndex(operation.oldPath);
          this.indexedFiles.delete(operation.oldPath);

          await this.embeddingSearch.indexFile(operation.file);
          this.indexedFiles.add(operation.file.path);

          console.log(
            `IndexManager: Renamed ${operation.oldPath} to ${operation.file.path}`
          );
        }
        break;
    }
  }

  private async deleteFromIndex(filePath: string): Promise<void> {
    await this.embeddingSearch.deleteDocumentsByFile(filePath);
  }

  async indexFile(file: TFile): Promise<void> {
    if (!shouldIndexFile(file, this.configManager)) {
      new Notice(`File excluded from indexing: ${file.path}`);
      return;
    }

    await this.embeddingSearch.indexFile(file);
    this.indexedFiles.add(file.path);

    if (this.configManager.get('showIndexNotifications')) {
      new Notice(`Indexed: ${file.path}`);
    }
  }

  async rebuildIndex(
    progressCallback?: (
      current: number,
      total: number,
      filePath: string
    ) => void | Promise<void>
  ): Promise<void> {
    console.log('IndexManager: Starting full index rebuild...');
    const allFiles = await this.getFilesToIndex();
    const totalFiles = allFiles.length;
    let successCount = 0;
    let errorCount = 0;

    // Clear existing index
    await this.embeddingSearch.clearIndex();
    this.indexedFiles.clear();

    // Rebuild from scratch
    for (let i = 0; i < allFiles.length; i++) {
      const file = allFiles[i];

      if (progressCallback) {
        await progressCallback(i + 1, totalFiles, file.path);
      }
      this.updateStatus({
        file: file.basename,
        current: i + 1,
        total: totalFiles,
      });

      try {
        await this.embeddingSearch.indexFile(file);
        this.indexedFiles.add(file.path);
        successCount++;
      } catch (error) {
        console.error(`IndexManager: Failed to index ${file.path}:`, error);
        errorCount++;
      }
    }

    if (this.configManager.get('showIndexNotifications')) {
      const message = `Index rebuilt: ${successCount} files indexed${errorCount > 0 ? `, ${errorCount} errors` : ''}`;
      new Notice(message);
    }
  }

  async syncIndex(): Promise<void> {
    const allFiles = this.vault.getMarkdownFiles();
    const filesToIndex: TFile[] = [];
    const pathsToDelete: string[] = [];

    // Find files that should be indexed but aren't
    for (const file of allFiles) {
      if (
        shouldIndexFile(file, this.configManager) &&
        !this.indexedFiles.has(file.path)
      ) {
        filesToIndex.push(file);
      }
    }

    // Find indexed files that no longer exist or should not be indexed
    for (const indexedPath of this.indexedFiles) {
      const file = allFiles.find(f => f.path === indexedPath);
      if (!file || !shouldIndexFile(file, this.configManager)) {
        pathsToDelete.push(indexedPath);
      }
    }

    console.log(
      `IndexManager: Sync found ${filesToIndex.length} files to index, ${pathsToDelete.length} to delete`
    );

    // Process additions
    let addedCount = 0;
    let addErrors = 0;
    for (const file of filesToIndex) {
      try {
        this.updateStatus({
          file: file.basename,
          current: addedCount + 1,
          total: filesToIndex.length,
        });
        await this.embeddingSearch.indexFile(file);
        this.indexedFiles.add(file.path);
        addedCount++;
      } catch (error) {
        console.error(`IndexManager: Failed to index ${file.path}:`, error);
        addErrors++;
      }
    }

    // Process deletions
    let deletedCount = 0;
    let deleteErrors = 0;
    for (const path of pathsToDelete) {
      try {
        await this.deleteFromIndex(path);
        this.indexedFiles.delete(path);
        deletedCount++;
      } catch (error) {
        console.error(
          `IndexManager: Failed to delete ${path} from index:`,
          error
        );
        deleteErrors++;
      }
    }

    if (this.configManager.get('showIndexNotifications')) {
      let message = `Index synced: ${addedCount} added, ${deletedCount} removed`;
      if (addErrors > 0 || deleteErrors > 0) {
        message += ` (${addErrors + deleteErrors} errors)`;
      }
      new Notice(message);
    }
  }

  private unregisterEventHandlers(): void {
    for (const eventRef of this.eventRefs) {
      this.vault.offref(eventRef);
    }
    this.eventRefs = [];
  }

  cleanup(): void {
    this.unregisterEventHandlers();

    // Unsubscribe from config changes
    for (const unsubscribe of this.configUnsubscribers) {
      unsubscribe();
    }
    this.configUnsubscribers = [];
  }

  getStats(): { indexed: number; pending: number; processing: boolean } {
    return {
      indexed: this.indexedFiles.size,
      pending: this.pendingOperations.size,
      processing: this.isProcessing,
    };
  }

  private async getFilesToIndex(): Promise<TFile[]> {
    const allFiles = this.vault.getMarkdownFiles();
    return getIndexableFiles(allFiles, this.configManager);
  }

  private updateStatus(progress: {
    file: string;
    current: number;
    total: number;
  }): void {
    this.statusUpdateCallback(
      `Sonar: Indexing ${progress.file} [${progress.current}/${progress.total}]`
    );
  }
}
