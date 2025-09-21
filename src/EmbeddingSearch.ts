import { VectorStore, DocumentMetadata } from './VectorStore';
import { Chunker } from './Chunker';
import { TFile, Vault } from 'obsidian';
import { ConfigManager } from './ConfigManager';
import { getIndexableFiles } from './fileFilters';
import { OllamaClient } from './OllamaClient';

export interface SearchResult {
  content: string;
  score: number;
  metadata: DocumentMetadata;
}

export class EmbeddingSearch {
  private ollamaClient: OllamaClient;
  private vectorStore: VectorStore;
  private chunker: Chunker;
  private vault: Vault;
  private configManager: ConfigManager;

  private constructor(
    ollamaClient: OllamaClient,
    vectorStore: VectorStore,
    chunker: Chunker,
    vault: Vault,
    configManager: ConfigManager
  ) {
    this.ollamaClient = ollamaClient;
    this.vectorStore = vectorStore;
    this.chunker = chunker;
    this.vault = vault;
    this.configManager = configManager;
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
      new Chunker(maxChunkSize, chunkOverlap, embeddingModel, tokenizerModel),
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
      const embeddings = await this.ollamaClient.getEmbeddings(
        chunks.map(c => c.content)
      );
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
