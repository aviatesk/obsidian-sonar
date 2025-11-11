import type { Embedder } from './Embedder';

export interface Chunk {
  content: string;
  headings: string[];
}

export async function createChunks(
  content: string,
  maxChunkSize: number,
  chunkOverlap: number,
  embedder: Embedder
): Promise<Chunk[]> {
  let text = content.trim();

  const chunks: Chunk[] = [];
  const lines = text.split('\n');
  let currentChunk: string[] = [];
  let currentTokens = 0;
  let currentHeadings: string[] = [];
  let chunkHeadings: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineTokens = await embedder.countTokens(line);

    if (line.startsWith('#')) {
      const level = line.match(/^#+/)?.[0].length || 0;
      const heading = line.replace(/^#+\s*/, '').trim();

      if (level <= 3) {
        currentHeadings = currentHeadings.slice(0, level - 1);
        currentHeadings.push(heading);
        chunkHeadings = [...currentHeadings];
      }
    }

    if (currentTokens + lineTokens > maxChunkSize && currentChunk.length > 0) {
      chunks.push({
        content: currentChunk.join('\n'),
        headings: chunkHeadings,
      });

      const overlapLines: string[] = [];
      let overlapTokens = 0;
      for (
        let j = currentChunk.length - 1;
        j >= 0 && overlapTokens < chunkOverlap;
        j--
      ) {
        const lineOverlapTokens = await embedder.countTokens(currentChunk[j]);
        if (overlapTokens + lineOverlapTokens <= chunkOverlap) {
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

  const finalChunkContent = currentChunk.join('\n').trim();
  if (finalChunkContent) {
    chunks.push({
      content: finalChunkContent,
      headings: chunkHeadings,
    });
  }

  return chunks;
}
