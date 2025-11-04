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
import {
  shouldIndexFile,
  getFilesToIndex,
  getIndexableFilesCount,
} from './fileFilters';
import { type DocumentMetadata, MetadataStore } from './MetadataStore';
import { EmbeddingStore } from './EmbeddingStore';
import { createChunks } from './chunker';
import { Embedder } from './Embedder';
import { Tokenizer } from './Tokenizer';
import { Logger } from './Logger';
import { BM25Store } from './BM25Store';
import { formatDuration } from './ObsidianUtils';

interface FileOperation {
  type: 'create' | 'modify' | 'delete' | 'rename';
  file: TFile | null;
  oldPath?: string;
}

export class IndexManager {
  private logger: Logger;
  private pendingOperations: Map<string, FileOperation> = new Map();
  private eventRefs: EventRef[] = [];
  private isProcessing: boolean = false;
  private configUnsubscribers: Array<() => void> = [];
  private isInitialized: boolean = false;
  private previousActiveFile: TFile | null = null;

  constructor(
    private metadataStore: MetadataStore,
    private embeddingStore: EmbeddingStore,
    private bm25Store: BM25Store,
    private embedder: Embedder,
    private vault: Vault,
    private workspace: Workspace,
    private configManager: ConfigManager,
    private getTokenizer: () => Tokenizer,
    private statusBarItem: HTMLElement
  ) {
    this.logger = configManager.getLogger();
    this.setupConfigListeners();
    this.updateStatusBarWithFileCount();
  }

  /**
   * Initialize after layout is ready to avoid startup event spam
   */
  async onLayoutReady(): Promise<void> {
    // Sync to detect changes made while Obsidian was closed
    await this.syncIndex(true);

    this.isInitialized = true;

    if (this.configManager.get('autoIndex')) {
      this.registerEventHandlers();
      this.logger.log('IndexManager: Auto-indexing enabled');
    } else {
      this.logger.log('IndexManager: Auto-indexing disabled');
    }
  }

  private setupConfigListeners(): void {
    const debouncedConfigSync = debounce(
      () => {
        if (!this.isInitialized) return;
        this.logger.log('IndexManager: Config changed, syncing index...');
        this.syncIndex().catch(error =>
          this.logger.error(
            `IndexManager: Failed to sync after config change: ${error}`
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
            this.logger.log('IndexManager: Auto-indexing enabled');
          } else {
            this.unregisterEventHandlers();
            this.logger.log('IndexManager: Auto-indexing disabled');
          }
        }
      })
    );

    this.configUnsubscribers.push(
      this.configManager.subscribe('excludedPaths', () => {
        if (!this.isInitialized) return;
        this.logger.log(
          'IndexManager: Excluded paths updated, scheduling sync...'
        );
        debouncedConfigSync();
      })
    );

    this.configUnsubscribers.push(
      this.configManager.subscribe('indexPath', () => {
        if (!this.isInitialized) return;
        this.logger.log('IndexManager: Index path updated, scheduling sync...');
        debouncedConfigSync();
      })
    );
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
    const dbFileMap = await this.metadataStore.getFileMetadataMap();
    const vaultFiles = getFilesToIndex(this.vault, this.configManager);
    const vaultFileMap = new Map(vaultFiles.map(f => [f.path, f]));

    // Build operations list
    const operations: FileOperation[] = [];
    let skippedCount = 0;

    // Check vault files for new/modified
    for (const file of vaultFiles) {
      const meta = dbFileMap.get(file.path);
      if (this.needsReindex(file, meta)) {
        operations.push({
          type: meta ? 'modify' : 'create',
          file,
        });
      } else {
        skippedCount++;
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

    this.logger.log(
      `IndexManager: Files - New: ${newCount}, Modified: ${modifiedCount}, Deleted: ${deletedCount}, Unchanged: ${skippedCount}`
    );

    const errorCount = await this.processBatchOperations(
      operations,
      progressCallback
    );

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
      this.vault.on('delete', async (file: TAbstractFile) => {
        if (file instanceof TFile) {
          const wasIndexed = await this.metadataStore.hasFile(file.path);
          if (wasIndexed) {
            this.scheduleOperation({
              type: 'delete',
              file: null,
              oldPath: file.path,
            });
          }
        }
      })
    );

    this.eventRefs.push(
      this.vault.on('rename', async (file: TAbstractFile, oldPath: string) => {
        if (file instanceof TFile) {
          const wasIndexed = await this.metadataStore.hasFile(oldPath);
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
    debounce(
      () => this.processPendingOperations(),
      this.configManager.get('indexDebounceMs'),
      true
    );
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
      return 0; // Regular event-driven call, skip if already processing
    }

    this.isProcessing = true;
    const operations = Array.from(this.pendingOperations.values());
    this.pendingOperations.clear();

    if (operations.length > 0) {
      this.logger.log(
        `IndexManager: Processing ${operations.length} file operation(s)${isSync ? ' synchronously' : ''}`
      );
    }

    // Use batch processing for efficient bulk deletion
    const errorCount = await this.processBatchOperations(
      operations,
      progressCallback
    );

    if (errorCount > 0 && !isSync) {
      // Only show notice for event-driven operations, not sync
      new Notice(`Sonar index failed to update ${errorCount} files`);
    }

    // Restore processing state if it wasn't already processing
    if (!wasProcessing) {
      this.isProcessing = false;
    }

    await this.updateStatusBarWithFileCount();
    return errorCount;
  }

  /**
   * Process a batch of file operations with optimized bulk deletion
   * Common routine used by both sync and event-driven processing
   */
  private async processBatchOperations(
    operations: FileOperation[],
    progressCallback?: (
      current: number,
      total: number,
      filePath: string
    ) => void | Promise<void>
  ): Promise<number> {
    if (operations.length === 0) {
      return 0;
    }

    // Batch delete all affected files from all stores first
    const filesToDelete: string[] = [];
    for (const operation of operations) {
      if (operation.type === 'delete' && operation.oldPath) {
        filesToDelete.push(operation.oldPath);
      } else if (operation.type === 'rename' && operation.oldPath) {
        filesToDelete.push(operation.oldPath);
      } else if (
        (operation.type === 'create' || operation.type === 'modify') &&
        operation.file
      ) {
        filesToDelete.push(operation.file.path);
      }
    }

    if (filesToDelete.length > 0) {
      this.logger.log(
        `IndexManager: Batch deletion starting for ${filesToDelete.length} files`
      );

      // Get all document IDs from MetadataStore for these files (parallel)
      const docArrays = await Promise.all(
        filesToDelete.map(filePath =>
          this.metadataStore.getDocumentsByFile(filePath)
        )
      );
      const allDocIds: string[] = [];
      for (const docs of docArrays) {
        allDocIds.push(...docs.map(d => d.id));
      }

      this.logger.log(
        `IndexManager: Deleting ${allDocIds.length} documents from all stores`
      );

      // Delete from all stores in parallel
      await Promise.all([
        this.metadataStore.deleteDocuments(allDocIds),
        this.embeddingStore.deleteEmbeddings(allDocIds),
        this.bm25Store.deleteDocuments(allDocIds),
      ]);

      this.logger.log('IndexManager: Batch deletion complete');
    }

    // Process each operation (only re-indexing for create/modify/rename)
    let errorCount = 0;
    for (let i = 0; i < operations.length; i++) {
      const operation = operations[i];
      const filePath = operation.file?.path || operation.oldPath || 'unknown';

      if (progressCallback) {
        await progressCallback(i + 1, operations.length, filePath);
      }

      const fileName =
        operation.file?.basename ||
        operation.oldPath?.split('/').pop() ||
        'unknown';
      this.updateStatus({
        action: this.getOperationAction(operation.type),
        file: fileName,
        filePath,
        current: i + 1,
        total: operations.length,
      });

      try {
        await this.processOperationCore(operation, true);
        this.logger.log(
          `IndexManager: ${this.getOperationAction(operation.type)} ${filePath}`
        );
      } catch (error) {
        this.logger.error(
          `IndexManager: Failed to ${operation.type} ${filePath}: ${error}`
        );
        errorCount++;
      }
    }

    return errorCount;
  }

  /**
   * Core operation processing logic
   * Used after bulk deletion has been performed
   */
  private async processOperationCore(
    operation: FileOperation,
    alreadyDeleted: boolean
  ): Promise<void> {
    switch (operation.type) {
      case 'create':
      case 'modify':
        if (operation.file) {
          if (alreadyDeleted) {
            // Deletion already done in batch, just re-index
            await this.indexFileInternalCore(operation.file);
          } else {
            // Delete from all stores, then re-index
            await this.deleteDocumentsFromStores(operation.file.path, true);
            await this.indexFileInternalCore(operation.file);
          }
        }
        break;

      case 'delete':
        if (operation.oldPath && !alreadyDeleted) {
          // Delete from all stores (only if not already deleted in batch)
          await this.deleteDocumentsFromStores(operation.oldPath, true);
        }
        // If alreadyDeleted, nothing to do
        break;

      case 'rename':
        if (operation.oldPath && operation.file) {
          if (alreadyDeleted) {
            // Deletion already done in batch, just index new path
            await this.indexFileInternalCore(operation.file);
          } else {
            // Delete old path from all stores, then index new path
            await this.deleteDocumentsFromStores(operation.oldPath, true);
            await this.indexFileInternalCore(operation.file);
          }
        }
        break;
    }
  }

  private getOperationAction(type: FileOperation['type']): string {
    switch (type) {
      case 'create':
        return 'Indexing';
      case 'modify':
        return 'Reindexing';
      case 'delete':
        return 'Deleting';
      case 'rename':
        return 'Renaming';
    }
  }

  /**
   * Helper to delete documents from stores by file path
   * Gets document IDs from MetadataStore and deletes from all/selected stores
   */
  private async deleteDocumentsFromStores(
    filePath: string,
    includeBM25: boolean = true
  ): Promise<void> {
    const docs = await this.metadataStore.getDocumentsByFile(filePath);
    const docIds = docs.map(d => d.id);

    await this.metadataStore.deleteDocuments(docIds);
    await this.embeddingStore.deleteEmbeddings(docIds);
    if (includeBM25) {
      await this.bm25Store.deleteDocuments(docIds);
    }
  }

  private async indexFileInternal(file: TFile): Promise<void> {
    await this.deleteDocumentsFromStores(file.path, true);
    await this.indexFileInternalCore(file);
  }

  /**
   * Index file core logic (assumes deletion already performed if needed)
   */
  private async indexFileInternalCore(file: TFile): Promise<void> {
    const content = await this.vault.cachedRead(file);
    const chunks = await createChunks(
      content,
      this.configManager.get('maxChunkSize'),
      this.configManager.get('chunkOverlap'),
      this.getTokenizer()
    );

    const indexedAt = Date.now();

    if (chunks.length === 0) {
      // Empty file: index only title
      const titleEmbeddings = await this.embedder.getEmbeddings([
        file.basename,
      ]);
      const titleEmbedding = titleEmbeddings[0];

      const docId = `${file.path}#0`;
      const metadata: DocumentMetadata = {
        id: docId,
        filePath: file.path,
        title: file.basename,
        content: '',
        headings: [],
        mtime: file.stat.mtime,
        size: file.stat.size,
        indexedAt,
      };
      await this.metadataStore.addDocument(metadata);

      // Add title as separate BM25/embedding entries
      await this.embeddingStore.addEmbedding(
        `${file.path}#title`,
        titleEmbedding
      );
      await this.bm25Store.indexDocumentBatch([
        { docId: `${file.path}#title`, content: file.basename },
      ]);
    } else {
      // Non-empty file: process chunks

      const chunkContents = chunks.map(c => c.content);

      const metadataDocuments: DocumentMetadata[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const docId = `${file.path}#${i}`;
        metadataDocuments.push({
          id: docId,
          filePath: file.path,
          title: file.basename,
          content: chunkContents[i],
          headings: chunks[i].headings,
          mtime: file.stat.mtime,
          size: file.stat.size,
          indexedAt,
        });
      }

      const bm25Documents = [
        { docId: `${file.path}#title`, content: file.basename },
      ];
      for (let i = 0; i < chunks.length; i++) {
        bm25Documents.push({
          docId: `${file.path}#${i}`,
          content: chunkContents[i],
        });
      }

      const embeddings = await this.embedder.getEmbeddings(chunkContents);
      const titleEmbeddings = await this.embedder.getEmbeddings([
        file.basename,
      ]);
      const titleEmbedding = titleEmbeddings[0];
      const embeddingData: Array<{
        id: string;
        embedding: number[];
      }> = [{ id: `${file.path}#title`, embedding: titleEmbedding }];
      for (let i = 0; i < chunks.length; i++) {
        embeddingData.push({
          id: `${file.path}#${i}`,
          embedding: embeddings[i],
        });
      }

      // Batch index all chunks in single transactions
      await this.metadataStore.addDocuments(metadataDocuments);
      await this.embeddingStore.addEmbeddings(embeddingData);
      await this.bm25Store.indexDocumentBatch(bm25Documents);
    }
  }

  async indexFile(file: TFile): Promise<void> {
    if (!shouldIndexFile(file, this.configManager)) {
      new Notice(`File excluded from indexing: ${file.path}`);
      return;
    }
    const dbFileMap = await this.metadataStore.getFileMetadataMap();
    const meta = dbFileMap.get(file.path);
    if (!this.needsReindex(file, meta)) {
      new Notice(`${file.path} is already up to date`);
      return;
    }
    await this.indexFileInternal(file);
    new Notice(`Indexed: ${file.path}`);
  }

  async rebuildIndex(
    progressCallback?: (
      current: number,
      total: number,
      filePath: string
    ) => void | Promise<void>
  ): Promise<void> {
    this.logger.log('IndexManager: Starting full index rebuild...');
    const startTime = Date.now();
    await this.clearIndex();
    const stats = await this.performSync(progressCallback);
    const duration = formatDuration(Date.now() - startTime);
    const message = `Rebuild complete: ${stats.newCount} files indexed in ${duration}${stats.errorCount > 0 ? `, ${stats.errorCount} errors` : ''}`;
    new Notice(message, 0);
    this.logger.log('IndexManager: Rebuild completed');
    await this.updateStatusBarWithFileCount();
  }

  async syncIndex(onload: boolean = false): Promise<void> {
    this.logger.log('IndexManager: Starting sync...');
    const startTime = Date.now();
    const stats = await this.performSync();
    const duration = formatDuration(Date.now() - startTime);
    const message = `Sync complete: ${stats.newCount} new, ${stats.modifiedCount} modified, ${stats.deletedCount} deleted in ${duration}${stats.errorCount > 0 ? `, ${stats.errorCount} errors` : ''}`;
    new Notice(message, onload ? 10000 : 0);
    this.logger.log('IndexManager: Sync completed');
    await this.updateStatusBarWithFileCount();
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
    for (const unsubscribe of this.configUnsubscribers) {
      unsubscribe();
    }
    this.configUnsubscribers = [];
  }

  private updateStatusBar(text: string): void {
    const maxLength = this.configManager.get('statusBarMaxLength');
    const fullText = `Sonar: ${text}`;

    // Always set tooltip to show full text
    this.statusBarItem.title = fullText;

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
    this.statusBarItem.setText(`Sonar: ${paddedText}`);
  }

  private async updateStatusBarWithFileCount(): Promise<void> {
    const indexableCount = getIndexableFilesCount(
      this.vault,
      this.configManager
    );
    let stats;
    try {
      stats = await this.getStats();
    } catch (error) {
      this.logger.error(`IndexManager: Failed to get stats: ${error}`);
      return;
    }
    this.updateStatusBar(`Indexed ${stats.totalFiles}/${indexableCount} files`);
  }

  private updateStatus(progress: {
    action: string;
    file: string;
    filePath: string;
    current: number;
    total: number;
  }): void {
    const text = `${progress.action} ${progress.file} [${progress.current}/${progress.total}]`;
    const fullText = `Sonar: ${progress.action} ${progress.filePath} [${progress.current}/${progress.total}]`;
    this.statusBarItem.title = fullText;

    const maxLength = this.configManager.get('statusBarMaxLength');
    let paddedText = text;
    if (maxLength > 0 && text.length > maxLength) {
      if (maxLength >= 4) {
        const halfLength = Math.floor((maxLength - 3) / 2);
        const prefix = text.slice(0, halfLength);
        const suffix = text.slice(-(maxLength - halfLength - 3));
        paddedText = prefix + '...' + suffix;
      } else {
        paddedText = text.slice(0, maxLength);
      }
    } else if (maxLength > 0) {
      paddedText = text.padEnd(maxLength);
    }
    this.statusBarItem.setText(`Sonar: ${paddedText}`);
  }

  async clearIndex(): Promise<void> {
    await this.metadataStore.clearAll();
    await this.embeddingStore.clearAll();
    await this.bm25Store.clearAll();
    await this.updateStatusBarWithFileCount();
  }

  async getStats(): Promise<{ totalDocuments: number; totalFiles: number }> {
    return await this.metadataStore.getStats();
  }

  async getIndexableFilesStats(): Promise<{
    fileCount: number;
    totalTokens: number;
    averageTokens: number;
    totalCharacters: number;
    averageCharacters: number;
    totalSize: number;
    averageSize: number;
  }> {
    const files = getFilesToIndex(this.vault, this.configManager);
    const fileCount = files.length;

    let totalTokens = 0;
    let totalCharacters = 0;
    let totalSize = 0;
    for (const file of files) {
      const content = await this.vault.cachedRead(file);
      const lines = content.split('\n');
      for (const line of lines) {
        const lineTokens = await this.getTokenizer().estimateTokens(line);
        totalTokens += lineTokens;
      }
      totalCharacters += content.length;
      totalSize += file.stat.size;
    }

    return {
      fileCount,
      totalTokens,
      averageTokens: fileCount === 0 ? 0 : Math.round(totalTokens / fileCount),
      totalCharacters,
      averageCharacters:
        fileCount === 0 ? 0 : Math.round(totalCharacters / fileCount),
      totalSize,
      averageSize: fileCount === 0 ? 0 : Math.round(totalSize / fileCount),
    };
  }
}
