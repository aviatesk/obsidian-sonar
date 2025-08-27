import { ObsidianEmbedder } from './embedder';
import { ObsidianVectorStore } from './vectorStore';
import { ObsidianChunker } from './chunker';
import { SearchCoordinator, SearchResult } from './core/search';
import { TFile, Vault } from 'obsidian';
import { ConfigManager } from './ConfigManager';
import { getIndexableFiles } from './fileFilters';

export class ObsidianEmbeddingSearch {
  private embedder: ObsidianEmbedder;
  private vectorStore: ObsidianVectorStore;
  private chunker: ObsidianChunker;
  private searchCoordinator: SearchCoordinator;
  private vault: Vault;
  private configManager: ConfigManager;

  private constructor(
    embedder: ObsidianEmbedder,
    vectorStore: ObsidianVectorStore,
    chunker: ObsidianChunker,
    searchCoordinator: SearchCoordinator,
    vault: Vault,
    configManager: ConfigManager
  ) {
    this.embedder = embedder;
    this.vectorStore = vectorStore;
    this.chunker = chunker;
    this.searchCoordinator = searchCoordinator;
    this.vault = vault;
    this.configManager = configManager;
  }

  static async initialize(
    vault: Vault,
    configManager: ConfigManager
  ): Promise<ObsidianEmbeddingSearch> {
    const ollamaUrl = configManager.get('ollamaUrl');
    const embeddingModel = configManager.get('embeddingModel');
    const maxChunkSize = configManager.get('maxChunkSize');
    const chunkOverlap = configManager.get('chunkOverlap');
    const tokenizerModel = configManager.get('tokenizerModel');

    const embedder = await ObsidianEmbedder.initialize(
      ollamaUrl,
      embeddingModel
    );
    const vectorStore = await ObsidianVectorStore.initialize();
    const embeddingSearch = new ObsidianEmbeddingSearch(
      embedder,
      vectorStore,
      new ObsidianChunker(
        maxChunkSize,
        chunkOverlap,
        embeddingModel,
        tokenizerModel
      ),
      new SearchCoordinator(embedder, vectorStore),
      vault,
      configManager
    );
    console.log('Semantic search system initialized with Ollama');
    return embeddingSearch;
  }

  async indexFile(file: TFile): Promise<number> {
    try {
      await this.vectorStore.deleteDocumentsByFile(file.path);
      const content = await this.vault.cachedRead(file);
      const chunks = await this.chunker.chunk(content, {
        filePath: file.path,
        title: file.basename,
      });
      if (chunks.length === 0) {
        console.log(`No chunks created for file: ${file.path}`);
        return 0;
      }
      const embeddings = await this.embedder.embed(chunks.map(c => c.content));
      for (let i = 0; i < chunks.length; i++) {
        await this.vectorStore.addDocument(
          chunks[i].content,
          embeddings[i],
          chunks[i].metadata
        );
      }
      return chunks.length;
    } catch (error) {
      console.error(`Failed to index file ${file.path}:`, error);
      return 0;
    }
  }

  async search(query: string, topK: number = 5): Promise<SearchResult[]> {
    return await this.searchCoordinator.search(query, topK);
  }

  async getStats(): Promise<{ totalDocuments: number; totalFiles: number }> {
    return await this.vectorStore.getStats();
  }

  async getIndexableFilesCount(): Promise<number> {
    const files = getIndexableFiles(
      this.vault.getMarkdownFiles(),
      this.configManager
    );
    return files.length;
  }

  async close(): Promise<void> {
    await this.vectorStore.close();
  }

  /**
   * Get the search coordinator for advanced search operations
   */
  getSearchCoordinator(): SearchCoordinator {
    return this.searchCoordinator;
  }

  async clearIndex(): Promise<void> {
    await this.vectorStore.clearAll();
  }

  async deleteDocumentsByFile(filePath: string): Promise<void> {
    await this.vectorStore.deleteDocumentsByFile(filePath);
  }

  async getIndexedFiles(): Promise<Set<string>> {
    const allDocs = await this.vectorStore.getAllDocuments();
    const filesSet = new Set<string>();
    for (const doc of allDocs) {
      if (doc.metadata && doc.metadata.filePath) {
        filesSet.add(doc.metadata.filePath);
      }
    }
    return filesSet;
  }
}
