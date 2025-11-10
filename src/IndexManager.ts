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
import type { Embedder } from './Embedder';
import { BM25Store } from './BM25Store';
import {
  formatBytes,
  formatDuration,
  hasNaNEmbedding,
  countNaNValues,
} from './Utils';
import { WithLogging } from './WithLogging';

/**
 * Debounce delay for batching file operations
 * Helps group multiple operations (e.g., directory delete/rename) together
 */
const AUTO_INDEX_DEBOUNCE_MS = 1000;

interface FileOperation {
  type: 'create' | 'modify' | 'delete' | 'rename';
  file: TFile | null;
  oldPath?: string;
}

export class IndexManager extends WithLogging {
  protected readonly componentName = 'IndexManager';
  private pendingOperations: Map<string, FileOperation> = new Map();
  private eventRefs: EventRef[] = [];
  private isProcessing: boolean = false;
  private configSubscribers: Array<() => void> = [];
  private isInitialized: boolean = false;
  private previousActiveFile: TFile | null = null;
  private debouncedProcess: () => void;

  constructor(
    private metadataStore: MetadataStore,
    private embeddingStore: EmbeddingStore,
    private bm25Store: BM25Store,
    private embedder: Embedder,
    private vault: Vault,
    private workspace: Workspace,
    protected configManager: ConfigManager,
    private statusBarItem: HTMLElement
  ) {
    super();
    this.debouncedProcess = debounce(
      () => this.processPendingOperations(),
      AUTO_INDEX_DEBOUNCE_MS,
      true
    );
    this.setupConfigListeners();
    this.updateStatusBarWithFileCount();
  }

  /**
   * Initialize after layout is ready to avoid startup event spam
   */
  async onLayoutReady(): Promise<void> {
    this.isInitialized = true;

    if (this.configManager.get('autoIndex')) {
      // Sync to detect changes made while Obsidian was closed
      await this.syncIndex(true);
      this.registerEventHandlers();
      this.log('Auto-indexing enabled');
    } else {
      this.log('Auto-indexing disabled');
    }
  }

  private setupConfigListeners(): void {
    const debouncedConfigSync = debounce(
      () => {
        if (!this.isInitialized) return;
        this.log('Config changed, syncing index...');
        this.syncIndex().catch(error =>
          this.error(`Failed to sync after config change: ${error}`)
        );
      },
      5000,
      true
    );

    this.configSubscribers.push(
      this.configManager.subscribe('autoIndex', (_key, value) => {
        if (this.isInitialized) {
          if (value) {
            this.registerEventHandlers();
            this.log('Auto-indexing enabled');
          } else {
            this.unregisterEventHandlers();
            this.log('Auto-indexing disabled');
          }
        }
      })
    );

    this.configSubscribers.push(
      this.configManager.subscribe('excludedPaths', () => {
        if (!this.isInitialized) return;
        this.log('Excluded paths updated, scheduling sync...');
        debouncedConfigSync();
      })
    );

    this.configSubscribers.push(
      this.configManager.subscribe('indexPath', () => {
        if (!this.isInitialized) return;
        this.log('Index path updated, scheduling sync...');
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
    errored: number;
    skipped: number;
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

    this.log(
      `Files - New: ${newCount}, Modified: ${modifiedCount}, Deleted: ${deletedCount}, Unchanged: ${skippedCount}`
    );

    const { errored, skipped } = await this.processBatchOperations(
      operations,
      progressCallback
    );

    return {
      newCount,
      modifiedCount,
      deletedCount,
      skippedCount,
      errored,
      skipped,
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
    this.debouncedProcess();
  }

  private async processPendingOperations(): Promise<void> {
    if (this.pendingOperations.size === 0) {
      return;
    }

    if (this.isProcessing) {
      return; // Prevent concurrent processing
    }

    this.isProcessing = true;
    const operations = Array.from(this.pendingOperations.values());
    this.pendingOperations.clear();

    const { errored } = await this.processBatchOperations(operations);

    if (errored > 0) {
      new Notice(`Sonar index failed to update ${errored} files`);
    }

    this.isProcessing = false;

    await this.updateStatusBarWithFileCount();
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
  ): Promise<{ errored: number; skipped: number }> {
    if (operations.length === 0) {
      return { errored: 0, skipped: 0 };
    }

    // Performance timing
    const timings = {
      deletion: 0,
      fileRead: 0,
      chunking: 0,
      embeddingGeneration: 0,
      dbWrite: 0,
      bm25Indexing: 0,
      workerCalls: 0,
    };
    const startTotal = Date.now();

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
      const deletionStart = Date.now();
      this.log(`Deleting ${filesToDelete.length} files...`);

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

      // Delete from all stores in parallel
      await Promise.all([
        this.metadataStore.deleteDocuments(allDocIds),
        this.embeddingStore.deleteEmbeddings(allDocIds),
        this.bm25Store.deleteDocuments(allDocIds),
      ]);

      timings.deletion = Date.now() - deletionStart;
      this.log(`Deleted ${allDocIds.length} documents`);
    }

    // Filter operations that need indexing
    const indexOperations = operations.filter(
      op =>
        (op.type === 'create' ||
          op.type === 'modify' ||
          op.type === 'rename') &&
        op.file
    );

    if (indexOperations.length === 0) {
      return { errored: 0, skipped: 0 };
    }

    // Step 1: Prepare all chunks for all files
    this.log(`Preparing ${indexOperations.length} files for indexing...`);
    interface FileChunkData {
      operation: FileOperation;
      file: TFile;
      chunks: Array<{ content: string; headings: string[] }>;
      indexedAt: number;
    }

    const fileChunkDataList: FileChunkData[] = [];
    let errorCount = 0;

    for (const operation of indexOperations) {
      const file = operation.file!;

      const readStart = Date.now();
      let content;
      try {
        content = await this.vault.cachedRead(file);
      } catch (error) {
        this.warn(`Failed to read ${file.path}: ${error}`);
        errorCount++;
        continue;
      }
      timings.fileRead += Date.now() - readStart;

      const chunkStart = Date.now();
      const chunks = await createChunks(
        content,
        this.configManager.get('maxChunkSize'),
        this.configManager.get('chunkOverlap'),
        this.embedder
      );
      timings.chunking += Date.now() - chunkStart;

      fileChunkDataList.push({
        operation,
        file,
        chunks,
        indexedAt: Date.now(),
      });
    }

    // Step 2: Index all BM25 documents upfront (before embedding generation)
    this.log('Preparing BM25 documents...');
    const allBM25Documents: Array<{ docId: string; content: string }> = [];
    for (const { file, chunks } of fileChunkDataList) {
      allBM25Documents.push({
        docId: `${file.path}#title`,
        content: file.basename,
      });
      for (let i = 0; i < chunks.length; i++) {
        allBM25Documents.push({
          docId: `${file.path}#${i}`,
          content: chunks[i].content,
        });
      }
    }

    if (allBM25Documents.length > 0) {
      this.log(`Indexing ${allBM25Documents.length} BM25 documents...`);
      const bm25Start = Date.now();
      await this.bm25Store.indexDocumentBatch(allBM25Documents);
      timings.bm25Indexing = Date.now() - bm25Start;
      this.log(`Indexed ${allBM25Documents.length} BM25 documents`);
    }

    // Step 3: Process embeddings in batches
    // Prepare all texts (titles + chunks) with metadata
    interface TextItem {
      text: string;
      fileIndex: number;
      type: 'title' | 'chunk';
      chunkIndex?: number;
    }

    const allTextItems: TextItem[] = [];
    for (let fileIndex = 0; fileIndex < fileChunkDataList.length; fileIndex++) {
      const { file, chunks } = fileChunkDataList[fileIndex];

      allTextItems.push({
        text: file.basename,
        fileIndex,
        type: 'title',
      });

      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        allTextItems.push({
          text: chunks[chunkIndex].content,
          fileIndex,
          type: 'chunk',
          chunkIndex,
        });
      }
    }

    // Generate embeddings for batch -> index metadata/embeddings
    const batchSize = this.configManager.get('indexingBatchSize');
    this.log(
      `Processing ${allTextItems.length} texts in batches of ${batchSize}...`
    );
    const fileEmbeddingsMap = new Map<
      number,
      Array<{
        type: 'title' | 'chunk';
        chunkIndex?: number;
        embedding: number[];
      }>
    >();
    // Track files with NaN embeddings across all batches
    const filesWithNaN = new Set<number>();

    for (let i = 0; i < allTextItems.length; i += batchSize) {
      const batchItems = allTextItems.slice(
        i,
        Math.min(i + batchSize, allTextItems.length)
      );
      const batchTexts = batchItems.map(item => item.text);

      // Generate embeddings for this batch
      const embeddingStart = Date.now();
      const batchEmbeddings = await this.embedder.getEmbeddings(batchTexts);
      timings.embeddingGeneration += Date.now() - embeddingStart;
      timings.workerCalls++;

      // Check for NaN embeddings in this batch
      const batchFilesWithNaN = new Set<number>();
      for (let j = 0; j < batchEmbeddings.length; j++) {
        const embedding = batchEmbeddings[j];
        if (hasNaNEmbedding(embedding)) {
          const item = batchItems[j];
          const { file } = fileChunkDataList[item.fileIndex];
          const nanCount = countNaNValues(embedding);
          this.warn(
            `NaN embedding detected for ${file.path} (${item.type}${item.type === 'chunk' ? ` #${item.chunkIndex}` : ''}): ${nanCount}/${embedding.length} NaN values`
          );
          batchFilesWithNaN.add(item.fileIndex);
          filesWithNaN.add(item.fileIndex);
        }
      }

      // Associate embeddings with files (skip files with NaN from any batch)
      for (let j = 0; j < batchItems.length; j++) {
        const item = batchItems[j];
        const embedding = batchEmbeddings[j];

        // Skip files that have any NaN embeddings (from this or previous batches)
        if (filesWithNaN.has(item.fileIndex)) {
          continue;
        }

        if (!fileEmbeddingsMap.has(item.fileIndex)) {
          fileEmbeddingsMap.set(item.fileIndex, []);
        }
        fileEmbeddingsMap.get(item.fileIndex)!.push({
          type: item.type,
          chunkIndex: item.chunkIndex,
          embedding,
        });
      }

      // Remove files with NaN from the map (in case they were partially added before)
      for (const fileIndex of batchFilesWithNaN) {
        fileEmbeddingsMap.delete(fileIndex);
      }

      // Check if we can index any complete files
      const completedFileIndices: number[] = [];
      for (const [fileIndex, embeddings] of fileEmbeddingsMap.entries()) {
        const { chunks } = fileChunkDataList[fileIndex];
        const expectedCount = 1 + chunks.length; // title + chunks
        if (embeddings.length === expectedCount) {
          completedFileIndices.push(fileIndex);
        }
      }

      // Index completed files and remove from map
      if (completedFileIndices.length > 0) {
        const batchMetadata: DocumentMetadata[] = [];
        const batchEmbeddingData: Array<{ id: string; embedding: number[] }> =
          [];

        for (const fileIndex of completedFileIndices) {
          const { operation, file, chunks, indexedAt } =
            fileChunkDataList[fileIndex];
          const fileEmbeddings = fileEmbeddingsMap.get(fileIndex)!;

          // This should never throw - all embeddings are guaranteed to exist
          const indexData = this.prepareFileIndexData(
            file,
            chunks,
            fileEmbeddings,
            indexedAt
          );

          batchMetadata.push(...indexData.metadata);
          batchEmbeddingData.push(...indexData.embeddingData);

          if (progressCallback) {
            try {
              await progressCallback(
                fileIndex + 1,
                fileChunkDataList.length,
                file.path
              );
            } catch (error) {
              this.warn(`Progress callback failed for ${file.path}: ${error}`);
            }
          }

          this.updateStatus({
            action: this.getOperationAction(operation.type),
            file: file.basename,
            filePath: file.path,
            current: fileIndex + 1,
            total: fileChunkDataList.length,
          });

          this.log(`${this.getOperationAction(operation.type)} ${file.path}`);

          fileEmbeddingsMap.delete(fileIndex);
        }

        // Write this batch to stores (metadata + embeddings only)
        if (batchMetadata.length > 0) {
          const writeStart = Date.now();
          await Promise.all([
            this.metadataStore.addDocuments(batchMetadata),
            this.embeddingStore.addEmbeddings(batchEmbeddingData),
          ]);
          timings.dbWrite += Date.now() - writeStart;
        }
      }

      const progress = Math.min(i + batchSize, allTextItems.length);
      this.log(`Processed: ${progress}/${allTextItems.length} texts`);
    }

    // Count total files with NaN embeddings
    errorCount += filesWithNaN.size;
    const skippedFiles = Array.from(filesWithNaN).map(
      idx => fileChunkDataList[idx].file.path
    );

    // Log skipped files
    if (skippedFiles.length > 0) {
      this.warn(`Skipped ${skippedFiles.length} files with NaN embeddings:`);
      for (const filePath of skippedFiles) {
        this.warn(`  - ${filePath}`);
      }
    }

    // Debug assertion: all files should have been indexed
    if (fileEmbeddingsMap.size > 0) {
      const remainingFiles = Array.from(fileEmbeddingsMap.keys())
        .map(idx => fileChunkDataList[idx].file.path)
        .join(', ');
      this.error(
        `BUG: ${fileEmbeddingsMap.size} files remain in embeddings map after processing: ${remainingFiles}`
      );
      throw new Error(
        `Incomplete file indexing detected: ${fileEmbeddingsMap.size} files not indexed`
      );
    }

    const totalTime = Date.now() - startTotal;

    // Log detailed timing breakdown
    this.log('=== Performance Timing Breakdown ===');
    this.log(`Total time: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s)`);
    this.log(`  Deletion: ${timings.deletion}ms`);
    this.log(`  File read: ${timings.fileRead}ms`);
    this.log(`  Chunking: ${timings.chunking}ms`);
    this.log(
      `  Embedding generation: ${timings.embeddingGeneration}ms (${timings.workerCalls} worker calls)`
    );
    this.log(`  DB write (metadata + embeddings): ${timings.dbWrite}ms`);
    this.log(`  BM25 indexing: ${timings.bm25Indexing}ms`);
    this.log(
      `  Other/overhead: ${totalTime - (timings.deletion + timings.fileRead + timings.chunking + timings.embeddingGeneration + timings.dbWrite + timings.bm25Indexing)}ms`
    );
    this.log('====================================');

    this.log('Batch indexing complete');
    return { errored: errorCount, skipped: skippedFiles.length };
  }

  private prepareFileIndexData(
    file: TFile,
    chunks: Array<{ content: string; headings: string[] }>,
    embeddings: Array<{
      type: 'title' | 'chunk';
      chunkIndex?: number;
      embedding: number[];
    }>,
    indexedAt: number
  ): {
    metadata: DocumentMetadata[];
    embeddingData: Array<{ id: string; embedding: number[] }>;
    bm25Documents: Array<{ docId: string; content: string }>;
  } {
    const titleEmbedding = embeddings.find(e => e.type === 'title')?.embedding;
    if (!titleEmbedding) {
      throw new Error(`Title embedding not found for ${file.path}`);
    }

    if (chunks.length === 0) {
      // Empty file: index only title
      const docId = `${file.path}#0`;
      return {
        metadata: [
          {
            id: docId,
            filePath: file.path,
            title: file.basename,
            content: '',
            headings: [],
            mtime: file.stat.mtime,
            size: file.stat.size,
            indexedAt,
          },
        ],
        embeddingData: [
          { id: `${file.path}#title`, embedding: titleEmbedding },
        ],
        bm25Documents: [
          { docId: `${file.path}#title`, content: file.basename },
        ],
      };
    }

    // Non-empty file: process chunks
    const chunkContents = chunks.map(c => c.content);
    const metadata: DocumentMetadata[] = [];
    const embeddingData: Array<{ id: string; embedding: number[] }> = [];
    const bm25Documents: Array<{ docId: string; content: string }> = [];

    // Add metadata for each chunk
    for (let i = 0; i < chunks.length; i++) {
      metadata.push({
        id: `${file.path}#${i}`,
        filePath: file.path,
        title: file.basename,
        content: chunkContents[i],
        headings: chunks[i].headings,
        mtime: file.stat.mtime,
        size: file.stat.size,
        indexedAt,
      });
    }

    // Add title to BM25 and embeddings
    bm25Documents.push({ docId: `${file.path}#title`, content: file.basename });
    embeddingData.push({ id: `${file.path}#title`, embedding: titleEmbedding });

    // Add chunks to BM25 and embeddings
    for (let i = 0; i < chunks.length; i++) {
      bm25Documents.push({
        docId: `${file.path}#${i}`,
        content: chunkContents[i],
      });
    }

    for (const emb of embeddings) {
      if (emb.type === 'chunk' && emb.chunkIndex !== undefined) {
        embeddingData.push({
          id: `${file.path}#${emb.chunkIndex}`,
          embedding: emb.embedding,
        });
      }
    }

    return { metadata, embeddingData, bm25Documents };
  }

  private getOperationAction(type: FileOperation['type']): string {
    switch (type) {
      case 'create':
        return 'Indexed';
      case 'modify':
        return 'Reindexed';
      case 'delete':
        return 'Deleted';
      case 'rename':
        return 'Renamed';
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
      this.embedder
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

  private buildIndexingCompleteMessage(
    baseMessage: string,
    errored: number,
    skipped: number
  ): string {
    let message = baseMessage;
    if (errored > 0) {
      message += `, ${errored} errors`;
    }
    if (skipped > 0) {
      message += ` (${skipped} files skipped due to NaN embeddings)`;
    }
    return message;
  }

  async rebuildIndex(
    progressCallback?: (
      current: number,
      total: number,
      filePath: string
    ) => void | Promise<void>
  ): Promise<void> {
    this.log('Rebuilding index...');
    const startTime = Date.now();
    await this.clearCurrentIndex();
    const stats = await this.performSync(progressCallback);
    const duration = formatDuration(Date.now() - startTime);
    const message = this.buildIndexingCompleteMessage(
      `Rebuild complete: ${stats.newCount} files indexed in ${duration}`,
      stats.errored,
      stats.skipped
    );
    new Notice(message, 0);
    this.log(message);
    await this.updateStatusBarWithFileCount();
  }

  async syncIndex(onload: boolean = false): Promise<{
    newCount: number;
    modifiedCount: number;
    deletedCount: number;
    skippedCount: number;
    errored: number;
    skipped: number;
  }> {
    this.log('Syncing index...');
    const startTime = Date.now();
    const stats = await this.performSync();
    const duration = formatDuration(Date.now() - startTime);
    const message = this.buildIndexingCompleteMessage(
      `Sync complete: ${stats.newCount} new, ${stats.modifiedCount} modified, ${stats.deletedCount} deleted in ${duration}`,
      stats.errored,
      stats.skipped
    );
    new Notice(message, onload ? 10000 : 0);
    this.log(message);
    await this.updateStatusBarWithFileCount();
    return stats;
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
    for (const unsubscribe of this.configSubscribers) {
      unsubscribe();
    }
    this.configSubscribers = [];
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
      this.error(`Failed to get stats: ${error}`);
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

  async clearCurrentIndex(): Promise<void> {
    await this.metadataStore.clearAll();
    await this.embeddingStore.clearAll();
    await this.bm25Store.clearAll();
    await this.updateStatusBarWithFileCount();
  }

  async getStats(): Promise<{ totalDocuments: number; totalFiles: number }> {
    return await this.metadataStore.getStats();
  }

  async showIndexableFilesStats(): Promise<void> {
    const startTime = Date.now();
    try {
      const stats = await this.getIndexableFilesStats();
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
        `  Total: ${formatBytes(stats.totalSize)}`,
        `  Average: ${formatBytes(stats.averageSize)}`,
      ].join('\n');

      this.log(message);
      new Notice(message, 0);
    } catch (error) {
      this.error(`Failed to calculate statistics: ${error}`);
      new Notice('Failed to calculate statistics - check console');
    }
  }

  private async getIndexableFilesStats(): Promise<{
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
        const lineTokens = await this.embedder.countTokens(line);
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
