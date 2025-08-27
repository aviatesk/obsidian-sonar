import { createChunks as createChunksShared } from './core/chunking';

export interface Chunk {
  content: string;
  metadata: {
    filePath: string;
    title: string;
    headings: string[];
    startLine?: number;
    endLine?: number;
    chunkIndex?: number;
    totalChunks?: number;
  };
}

export class ObsidianChunker {
  private maxChunkSize: number;
  private chunkOverlap: number;
  private embeddingModel?: string;
  private tokenizerModel?: string;

  constructor(
    maxChunkSize: number,
    chunkOverlap: number,
    embeddingModel?: string,
    tokenizerModel?: string
  ) {
    this.maxChunkSize = maxChunkSize;
    this.chunkOverlap = chunkOverlap;
    this.embeddingModel = embeddingModel;
    this.tokenizerModel = tokenizerModel;
  }

  async chunk(
    content: string,
    metadata: { filePath: string; title: string }
  ): Promise<Chunk[]> {
    // Use the shared chunking function
    const config = {
      maxChunkSize: this.maxChunkSize,
      chunkOverlap: this.chunkOverlap,
    };

    const chunks = await createChunksShared(
      content,
      metadata.filePath,
      config,
      this.embeddingModel,
      this.tokenizerModel
    );

    // Convert to the expected format and add chunk indices
    return chunks.map((chunk: any, index: number) => ({
      content: chunk.content,
      metadata: {
        ...chunk.metadata,
        title: metadata.title,
        chunkIndex: index,
        totalChunks: chunks.length,
      },
    }));
  }
}
