import { VectorStore, DocumentMetadata } from './VectorStore';
import { createChunks } from './chunker';
import { TFile, Vault } from 'obsidian';
import { ConfigManager } from './ConfigManager';
import { OllamaClient } from './OllamaClient';

export interface SearchResult {
  content: string;
  score: number;
  metadata: DocumentMetadata;
}

export class EmbeddingSearch {
  private ollamaClient: OllamaClient;
  private vectorStore: VectorStore;
  private vault: Vault;
  private maxChunkSize: number;
  private chunkOverlap: number;
  private embeddingModel: string;
  private tokenizerModel?: string;

  private constructor(
    ollamaClient: OllamaClient,
    vectorStore: VectorStore,
    vault: Vault,
    maxChunkSize: number,
    chunkOverlap: number,
    embeddingModel: string,
    tokenizerModel?: string
  ) {
    this.ollamaClient = ollamaClient;
    this.vectorStore = vectorStore;
    this.vault = vault;
    this.maxChunkSize = maxChunkSize;
    this.chunkOverlap = chunkOverlap;
    this.embeddingModel = embeddingModel;
    this.tokenizerModel = tokenizerModel;
  }

  static async initialize(
    vault: Vault,
    configManager: ConfigManager
  ): Promise<EmbeddingSearch> {
    const ollamaUrl = configManager.get('ollamaUrl');
    const embeddingModel = configManager.get('embeddingModel');
    const maxChunkSize = configManager.get('maxChunkSize');
    const chunkOverlap = configManager.get('chunkOverlap');
    const tokenizerModel = configManager.get('tokenizerModel');

    const ollamaClient = new OllamaClient({
      ollamaUrl,
      model: embeddingModel,
    });

    try {
      await ollamaClient.checkModel();
      console.log(`Ollama initialized with model: ${embeddingModel}`);
    } catch (error) {
      console.error('Failed to initialize Ollama:', error);
      throw error;
    }

    const vectorStore = await VectorStore.initialize();
    const embeddingSearch = new EmbeddingSearch(
      ollamaClient,
      vectorStore,
      vault,
      maxChunkSize,
      chunkOverlap,
      embeddingModel,
      tokenizerModel
    );
    console.log('Semantic search system initialized with Ollama');
    return embeddingSearch;
  }

  async indexFile(file: TFile): Promise<number> {
    try {
      await this.vectorStore.deleteDocumentsByFile(file.path);
      const content = await this.vault.cachedRead(file);
      const chunks = await createChunks(
        content,
        this.maxChunkSize,
        this.chunkOverlap,
        this.embeddingModel,
        this.tokenizerModel
      );
      if (chunks.length === 0) {
        console.log(`No chunks created for file: ${file.path}`);
        return 0;
      }
      const chunkContents = chunks.map(c => c.content);
      const embeddings = await this.ollamaClient.getEmbeddings(chunkContents);

      // Create metadata for each chunk
      const indexedAt = Date.now();
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
      return chunks.length;
    } catch (error) {
      console.error(`Failed to index file ${file.path}:`, error);
      return 0;
    }
  }

  async search(query: string, topK: number = 5): Promise<SearchResult[]> {
    const queryEmbeddings = await this.ollamaClient.getEmbeddings([query]);
    const results = await this.vectorStore.search(queryEmbeddings[0], topK);

    // Transform results from { document, score } to { content, score, metadata }
    return results.map(result => ({
      content: result.document.content,
      score: result.score,
      metadata: result.document.metadata,
    }));
  }

  async getStats(): Promise<{ totalDocuments: number; totalFiles: number }> {
    return await this.vectorStore.getStats();
  }

  async close(): Promise<void> {
    await this.vectorStore.close();
  }

  async clearIndex(): Promise<void> {
    await this.vectorStore.clearAll();
  }

  async deleteDocumentsByFile(filePath: string): Promise<void> {
    await this.vectorStore.deleteDocumentsByFile(filePath);
  }

  async getIndexedFiles() {
    return this.vectorStore.getAllDocuments();
  }
}
