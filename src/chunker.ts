import { createHash } from 'crypto';
import { Tokenizer } from './Tokenizer';
import { IndexedDocument } from './VectorStore';

export interface ChunkConfig {
  maxChunkSize: number; // tokens
  chunkOverlap: number; // tokens
}

export interface ChunkMetadata {
  filePath: string;
  title: string;
  headings: string[];
}

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

function getFileName(filePath: string): string {
  const parts = filePath.split('/');
  const filename = parts[parts.length - 1];
  return filename.replace(/\.[^/.]+$/, '');
}

export async function createChunks(
  content: string,
  filePath: string,
  config: ChunkConfig,
  embeddingModel?: string,
  tokenizerModel?: string
): Promise<Chunk[]> {
  let text = content.trim();

  const chunks: Chunk[] = [];
  const lines = text.split('\n');
  let currentChunk: string[] = [];
  let currentTokens = 0;
  let currentHeadings: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineTokens = await Tokenizer.estimateTokens(
      line,
      embeddingModel,
      tokenizerModel
    );

    // Update headings if this is a heading line
    if (line.startsWith('#')) {
      const level = line.match(/^#+/)?.[0].length || 0;
      const heading = line.replace(/^#+\s*/, '').trim();

      if (level <= 3) {
        currentHeadings = currentHeadings.slice(0, level - 1);
        currentHeadings.push(heading);
      }
    }

    // Check if we need to create a new chunk
    if (
      currentTokens + lineTokens > config.maxChunkSize &&
      currentChunk.length > 0
    ) {
      chunks.push({
        content: currentChunk.join('\n'),
        metadata: {
          filePath: filePath,
          title: getFileName(filePath),
          headings: [...currentHeadings],
        },
      });

      // Handle overlap (keep last N tokens worth of lines)
      const overlapLines: string[] = [];
      let overlapTokens = 0;
      for (
        let j = currentChunk.length - 1;
        j >= 0 && overlapTokens < config.chunkOverlap;
        j--
      ) {
        const lineOverlapTokens = await Tokenizer.estimateTokens(
          currentChunk[j],
          embeddingModel,
          tokenizerModel
        );
        if (overlapTokens + lineOverlapTokens <= config.chunkOverlap) {
          overlapLines.unshift(currentChunk[j]);
          overlapTokens += lineOverlapTokens;
        }
      }

      currentChunk = overlapLines;
      currentTokens = overlapTokens;
    }

    currentChunk.push(line);
    currentTokens += lineTokens;
  }

  // Add the last chunk if it's substantial (more than ~10 tokens)
  const finalChunkContent = currentChunk.join('\n').trim();
  if (
    finalChunkContent &&
    (await Tokenizer.estimateTokens(
      finalChunkContent,
      embeddingModel,
      tokenizerModel
    )) > 10
  ) {
    chunks.push({
      content: finalChunkContent,
      metadata: {
        filePath: filePath,
        title: getFileName(filePath),
        headings: [...currentHeadings],
      },
    });
  }

  return chunks;
}

export function generateDocumentId(
  filePath: string,
  chunkIndex: number
): string {
  return createHash('md5')
    .update(filePath + chunkIndex)
    .digest('hex');
}

export function createIndexedDocument(
  chunk: Chunk,
  embedding: number[],
  filePath: string,
  chunkIndex: number,
  totalChunks: number
): IndexedDocument {
  return {
    id: generateDocumentId(filePath, chunkIndex),
    content: chunk.content,
    embedding: embedding,
    metadata: {
      ...chunk.metadata,
      chunkIndex: chunkIndex,
      totalChunks: totalChunks,
    },
  };
}

export class Chunker {
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
    const config = {
      maxChunkSize: this.maxChunkSize,
      chunkOverlap: this.chunkOverlap,
    };

    const chunks = await createChunks(
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
