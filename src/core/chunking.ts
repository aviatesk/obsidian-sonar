import { createHash } from 'crypto';
import { SonarTokenizer } from './tokenizer';
import { IndexedDocument } from './document';

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
  metadata: ChunkMetadata;
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
    const lineTokens = await SonarTokenizer.estimateTokens(
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
        const lineOverlapTokens = await SonarTokenizer.estimateTokens(
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
    (await SonarTokenizer.estimateTokens(
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

function getFileName(filePath: string): string {
  const parts = filePath.split('/');
  const filename = parts[parts.length - 1];
  return filename.replace(/\.[^/.]+$/, '');
}

export function cosineSimilarity(vec1: number[], vec2: number[]): number {
  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;
  for (let i = 0; i < vec1.length; i++) {
    dotProduct += vec1[i] * vec2[i];
    norm1 += vec1[i] * vec1[i];
    norm2 += vec2[i] * vec2[i];
  }
  return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
}
