import {
  TAbstractFile,
  TFile,
  Vault,
  type EventRef,
  Notice,
  debounce,
  Workspace,
} from 'obsidian';
import { ConfigManager } from './ConfigManager';
import { shouldIndexFile, getFilesToIndex } from './fileFilters';
import { type DocumentMetadata, VectorStore } from './VectorStore';
import { createChunks } from './chunker';
import { OllamaClient } from './OllamaClient';

interface FileOperation {
  type: 'create' | 'modify' | 'delete' | 'rename';
  file: TFile | null;
  oldPath?: string;
}

export class IndexManager {
  private vectorStore: VectorStore;
  private ollamaClient: OllamaClient;
  private vault: Vault;
  private workspace: Workspace;
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
  private metadataCache: Map<string, DocumentMetadata> | null = null;
  private previousActiveFile: TFile | null = null;

  constructor(
    vectorStore: VectorStore,
    ollamaClient: OllamaClient,
    vault: Vault,
    workspace: Workspace,
    configManager: ConfigManager,
    statusUpdateCallback: (status: string) => void,
    onProcessingCompleteCallback: () => void
  ) {
    this.vectorStore = vectorStore;
    this.ollamaClient = ollamaClient;
    this.vault = vault;
    this.workspace = workspace;
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
  }

  /**
   * Initialize after layout is ready to avoid startup event spam
   */
  async onLayoutReady(): Promise<void> {
    // Load current DB state first
    await this.loadIndexedFiles();

    // Then sync to detect changes made while Obsidian was closed
    await this.syncOnLoad();

    this.isInitialized = true;

    if (this.configManager.get('autoIndex')) {
      this.registerEventHandlers();
      console.log('IndexManager: Auto-indexing enabled');
    } else {
      console.log('IndexManager: Auto-indexing disabled');
    }
  }

  private setupConfigListeners(): void {
    const debouncedConfigSync = debounce(
      () => {
        if (!this.isInitialized) return;
        console.log('IndexManager: Config changed, syncing index...');
        this.syncIndex().catch(error =>
          console.error(
            'IndexManager: Failed to sync after config change:',
            error
          )
        );
      },
      5000,
      true
    );

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
        if (!this.isInitialized) return;
        console.log('IndexManager: Excluded paths updated, scheduling sync...');
        debouncedConfigSync();
      })
    );

    this.configUnsubscribers.push(
      this.configManager.subscribe('indexPath', () => {
        if (!this.isInitialized) return;
        console.log('IndexManager: Index path updated, scheduling sync...');
        debouncedConfigSync();
      })
    );
  }

  private async loadIndexedFiles(): Promise<void> {
    const metadata = await this.getDbFileMetadata();
    this.indexedFiles = new Set(metadata.keys());
  }

  async reloadIndexedFiles(): Promise<void> {
    await this.loadIndexedFiles();
  }

  private async getDbFileMetadata(): Promise<Map<string, DocumentMetadata>> {
    if (this.metadataCache) {
      return this.metadataCache;
    }

    const allDocs = await this.vectorStore.getAllDocuments();
    const metadata = new Map<string, DocumentMetadata>();

    for (const doc of allDocs) {
      const filePath = doc.metadata.filePath;
      if (!metadata.has(filePath)) {
        metadata.set(filePath, doc.metadata);
      }
    }

    this.metadataCache = metadata;
    return metadata;
  }

  private clearMetadataCache(): void {
    this.metadataCache = null;
  }

  private needsReindex(
    file: TFile,
    metadata: DocumentMetadata | undefined
  ): boolean {
    if (!metadata) return true;
    return (
      file.stat.mtime !== metadata.mtime || file.stat.size !== metadata.size
    );
  }

  private async syncOnLoad(): Promise<void> {
    console.log('IndexManager: Starting sync...');
    await this.performSync();
    console.log('IndexManager: Sync completed');
    this.onProcessingCompleteCallback();
  }

  private async performSync(
    progressCallback?: (
      current: number,
      total: number,
      filePath: string
    ) => void | Promise<void>
  ): Promise<{
    newCount: number;
    modifiedCount: number;
    deletedCount: number;
    skippedCount: number;
    errorCount: number;
  }> {
    const dbFileMap = await this.getDbFileMetadata();
    const vaultFiles = getFilesToIndex(this.vault, this.configManager);
    const vaultFileMap = new Map(vaultFiles.map(f => [f.path, f]));

    // Build operations list
    const operations: FileOperation[] = [];
    let skippedCount = 0;

    // Check vault files for new/modified
    const unchangedFiles: string[] = [];
    for (const file of vaultFiles) {
      const meta = dbFileMap.get(file.path);
      if (this.needsReindex(file, meta)) {
        operations.push({
          type: meta ? 'modify' : 'create',
          file,
        });
      } else {
        skippedCount++;
        unchangedFiles.push(file.path); // Track unchanged files
      }
    }

    // Check for deleted files
    for (const path of dbFileMap.keys()) {
      if (!vaultFileMap.has(path)) {
        operations.push({
          type: 'delete',
          file: null,
          oldPath: path,
        });
      }
    }

    // Count operation types for logging
    const newCount = operations.filter(op => op.type === 'create').length;
    const modifiedCount = operations.filter(op => op.type === 'modify').length;
    const deletedCount = operations.filter(op => op.type === 'delete').length;

    console.log(
      `IndexManager: Files - New: ${newCount}, Modified: ${modifiedCount}, Deleted: ${deletedCount}, Unchanged: ${skippedCount}`
    );

    // Schedule all operations through the queue without triggering debounce
    for (const operation of operations) {
      this.scheduleOperation(operation, true);
    }

    // Process all scheduled operations synchronously
    const errorCount = await this.processPendingOperations(
      true,
      progressCallback
    );

    // Update indexedFiles to reflect the current DB state
    // Add unchanged files that are still in the DB
    for (const path of unchangedFiles) {
      this.indexedFiles.add(path);
    }

    return {
      newCount,
      modifiedCount,
      deletedCount,
      skippedCount,
      errorCount,
    };
  }

  private registerEventHandlers(): void {
    this.eventRefs.push(
      this.workspace.on('active-leaf-change', () => {
        const activeFile = this.workspace.getActiveFile();
        if (
          this.previousActiveFile &&
          this.previousActiveFile !== activeFile &&
          shouldIndexFile(this.previousActiveFile, this.configManager)
        ) {
          this.scheduleOperation({
            type: 'modify',
            file: this.previousActiveFile,
          });
        }
        // Update the reference to current active file
        this.previousActiveFile =
          activeFile instanceof TFile ? activeFile : null;
      })
    );

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

  private scheduleOperation(
    operation: FileOperation,
    skipDebounce = false
  ): void {
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

    if (!skipDebounce) {
      this.debouncedProcess();
    }
  }

  private async processPendingOperations(
    isSync: boolean = false,
    progressCallback?: (
      current: number,
      total: number,
      filePath: string
    ) => void | Promise<void>
  ): Promise<number> {
    if (this.pendingOperations.size === 0) {
      return 0;
    }

    // Prevent concurrent processing but allow sync to override
    const wasProcessing = this.isProcessing;
    if (wasProcessing && !isSync) {
      // Regular event-driven call, skip if already processing
      return 0;
    }

    this.isProcessing = true;
    const operations = Array.from(this.pendingOperations.values());
    this.pendingOperations.clear();

    if (operations.length > 0) {
      console.log(
        `IndexManager: Processing ${operations.length} file operation(s)${isSync ? ' synchronously' : ''}`
      );
    }

    let errorCount = 0;
    const totalOperations = operations.length;

    for (let i = 0; i < operations.length; i++) {
      const operation = operations[i];
      const filePath = operation.file?.path || operation.oldPath || 'unknown';

      if (progressCallback) {
        await progressCallback(i + 1, totalOperations, filePath);
      }

      try {
        const fileName =
          operation.file?.basename ||
          operation.oldPath?.split('/').pop() ||
          'unknown';
        this.updateStatus({
          file: fileName,
          current: i + 1,
          total: totalOperations,
        });
        // Skip change check if called from sync
        await this.processOperation(operation, isSync);
      } catch (error) {
        console.error(
          `IndexManager: Failed to ${operation.type} ${filePath}:`,
          error
        );
        errorCount++;
      }
    }

    // Clear metadata cache after all operations complete
    if (operations.length > 0) {
      this.clearMetadataCache();
    }

    if (errorCount > 0 && !isSync) {
      // Only show notice for event-driven operations, not sync
      new Notice(`Sonar index failed to update ${errorCount} files`);
    }

    // Restore processing state if it wasn't already processing
    if (!wasProcessing) {
      this.isProcessing = false;
    }

    this.onProcessingCompleteCallback();
    return errorCount;
  }

  private async processOperation(
    operation: FileOperation,
    skipChangeCheck = false
  ): Promise<void> {
    switch (operation.type) {
      case 'create':
      case 'modify':
        if (operation.file) {
          // For modify operations from events, check if re-indexing is actually needed
          // Skip this check during sync since we already checked
          if (!skipChangeCheck && operation.type === 'modify') {
            const dbFileMap = await this.getDbFileMetadata();
            const meta = dbFileMap.get(operation.file.path);

            if (!this.needsReindex(operation.file, meta)) {
              console.log(
                `IndexManager: Skipped ${operation.file.path} (no changes)`
              );
              return;
            }
          }

          await this.indexFileInternal(operation.file);
          console.log(`IndexManager: Indexed ${operation.file.path}`);
        }
        break;

      case 'delete':
        if (operation.oldPath) {
          await this.deleteFromIndex(operation.oldPath);
          console.log(`IndexManager: Deleted ${operation.oldPath} from index`);
        }
        break;

      case 'rename':
        if (operation.oldPath && operation.file) {
          await this.deleteFromIndex(operation.oldPath);

          await this.indexFileInternal(operation.file);

          console.log(
            `IndexManager: Renamed ${operation.oldPath} to ${operation.file.path}`
          );
        }
        break;
    }
  }

  private async deleteFromIndex(filePath: string): Promise<void> {
    await this.vectorStore.deleteDocumentsByFile(filePath);
    this.indexedFiles.delete(filePath);
  }

  private async indexFileInternal(file: TFile): Promise<void> {
    // Do the actual indexing
    await this.vectorStore.deleteDocumentsByFile(file.path);
    const content = await this.vault.cachedRead(file);
    const chunks = await createChunks(
      content,
      this.configManager.get('maxChunkSize'),
      this.configManager.get('chunkOverlap'),
      this.configManager.get('embeddingModel'),
      this.configManager.get('tokenizerModel')
    );

    const chunkContents = chunks.map(c => c.content);
    const embeddings = await this.ollamaClient.getEmbeddings(chunkContents);

    // Create metadata for each chunk
    const indexedAt = Date.now();
    if (chunks.length == 0) {
      await this.vectorStore.addDocument('', [], {
        filePath: file.path,
        title: file.basename,
        headings: [],
        mtime: file.stat.mtime,
        size: file.stat.size,
        indexedAt,
      });
    } else {
      for (let i = 0; i < chunks.length; i++) {
        const metadata: DocumentMetadata = {
          filePath: file.path,
          title: file.basename,
          headings: chunks[i].headings,
          mtime: file.stat.mtime,
          size: file.stat.size,
          indexedAt,
        };
        await this.vectorStore.addDocument(
          chunks[i].content,
          embeddings[i],
          metadata
        );
      }
    }

    this.indexedFiles.add(file.path);
  }

  async indexFile(file: TFile): Promise<void> {
    if (!shouldIndexFile(file, this.configManager)) {
      new Notice(`File excluded from indexing: ${file.path}`);
      return;
    }

    // Check if file needs re-indexing
    const dbFileMap = await this.getDbFileMetadata();
    const meta = dbFileMap.get(file.path);

    if (!this.needsReindex(file, meta)) {
      if (this.configManager.get('showIndexNotifications')) {
        new Notice(`${file.path} is already up to date`);
      }
      return;
    }

    await this.indexFileInternal(file);
    this.clearMetadataCache(); // Clear cache after DB change

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

    // Clear existing index
    await this.clearIndex();

    // Re-index all files
    const stats = await this.performSync(progressCallback);

    if (this.configManager.get('showIndexNotifications')) {
      const message = `Rebuild complete: ${stats.newCount} files indexed${stats.errorCount > 0 ? `, ${stats.errorCount} errors` : ''}`;
      new Notice(message);
    }
  }

  async syncIndex(): Promise<void> {
    const stats = await this.performSync();

    if (this.configManager.get('showIndexNotifications')) {
      const message = `Sync complete: ${stats.newCount} new, ${stats.modifiedCount} modified, ${stats.deletedCount} deleted${stats.errorCount > 0 ? `, ${stats.errorCount} errors` : ''}`;
      new Notice(message);
    }
  }

  private unregisterEventHandlers(): void {
    for (const eventRef of this.eventRefs) {
      this.workspace.offref(eventRef);
    }
    this.eventRefs = [];
    this.previousActiveFile = null;
  }

  cleanup(): void {
    this.unregisterEventHandlers();

    // Unsubscribe from config changes
    for (const unsubscribe of this.configUnsubscribers) {
      unsubscribe();
    }
    this.configUnsubscribers = [];
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

  async clearIndex(): Promise<void> {
    await this.vectorStore.clearAll();
    this.indexedFiles.clear();
    this.clearMetadataCache();
  }

  async getStats(): Promise<{ totalDocuments: number; totalFiles: number }> {
    return await this.vectorStore.getStats();
  }
}
