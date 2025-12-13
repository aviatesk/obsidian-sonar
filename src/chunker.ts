import type { Embedder } from './Embedder';

export interface Chunk {
  content: string;
  headings: string[];
  startOffset: number;
}

/**
 * Creates a memoized version of countTokens for use within a single chunking session.
 * Cache is local to the function scope and automatically cleaned up after chunking completes.
 */
function createMemoizedCountTokens(
  embedder: Pick<Embedder, 'countTokens'>
): (text: string) => Promise<number> {
  const cache = new Map<string, number>();
  return async (text: string): Promise<number> => {
    const cached = cache.get(text);
    if (cached !== undefined) {
      return cached;
    }
    const count = await embedder.countTokens(text);
    cache.set(text, count);
    return count;
  };
}

interface LineWithOffset {
  text: string;
  offset: number;
}

export async function createChunks(
  content: string,
  maxChunkSize: number,
  chunkOverlap: number,
  embedder: Pick<Embedder, 'countTokens'>
): Promise<Chunk[]> {
  const countTokens = createMemoizedCountTokens(embedder);

  // Calculate trim offset (leading whitespace removed)
  const trimmedContent = content.trim();
  const trimOffset = content.indexOf(trimmedContent);

  const chunks: Chunk[] = [];
  const lines = trimmedContent.split('\n');

  // Pre-calculate offset for each line (relative to original content)
  const lineOffsets: number[] = [];
  let offset = trimOffset;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1; // +1 for '\n'
  }

  let currentChunk: LineWithOffset[] = [];
  let currentTokens = 0;
  let currentHeadings: string[] = [];
  let chunkHeadings: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineOffset = lineOffsets[i];
    const lineTokens = await countTokens(line);

    // Check for heading and update context
    if (line.startsWith('#')) {
      const level = line.match(/^#+/)?.[0].length || 0;
      const heading = line.replace(/^#+\s*/, '').trim();

      if (level <= 3) {
        currentHeadings = currentHeadings.slice(0, level - 1);
        currentHeadings.push(heading);
        chunkHeadings = [...currentHeadings];
      }
    }

    // Split long lines that exceed maxChunkSize
    const processLines: LineWithOffset[] =
      lineTokens > maxChunkSize
        ? await splitLongLineWithOffset(
            line,
            lineOffset,
            maxChunkSize,
            countTokens
          )
        : [{ text: line, offset: lineOffset }];

    // Process each sub-line (or the original line if not split)
    for (const processLine of processLines) {
      const processLineTokens = await countTokens(processLine.text);

      // Assertion: splitLongLine should ensure no line exceeds maxChunkSize
      if (processLineTokens > maxChunkSize) {
        throw new Error(
          `Line after splitting still exceeds maxChunkSize: ${processLineTokens} > ${maxChunkSize}`
        );
      }

      if (
        currentTokens + processLineTokens > maxChunkSize &&
        currentChunk.length > 0
      ) {
        // Assertion: Ensure chunk doesn't exceed maxChunkSize before saving
        if (currentTokens > maxChunkSize) {
          throw new Error(
            `Chunk exceeds maxChunkSize: ${currentTokens} > ${maxChunkSize}`
          );
        }

        chunks.push({
          content: currentChunk.map(l => l.text).join('\n'),
          headings: chunkHeadings,
          startOffset: currentChunk[0].offset,
        });

        const overlapLines: LineWithOffset[] = [];
        let overlapTokens = 0;
        for (
          let j = currentChunk.length - 1;
          j >= 0 && overlapTokens < chunkOverlap;
          j--
        ) {
          const lineOverlapTokens = await countTokens(currentChunk[j].text);
          if (overlapTokens + lineOverlapTokens <= chunkOverlap) {
            overlapLines.unshift(currentChunk[j]);
            overlapTokens += lineOverlapTokens;
          } else {
            // Stop if a line doesn't fit - don't skip to earlier lines
            // This ensures overlap remains contiguous
            break;
          }
        }

        // Reduce overlap if adding the new line would exceed maxChunkSize
        while (
          overlapLines.length > 0 &&
          overlapTokens + processLineTokens > maxChunkSize
        ) {
          const removedLine = overlapLines.shift()!;
          const removedTokens = await countTokens(removedLine.text);
          overlapTokens -= removedTokens;
        }

        currentChunk = overlapLines;
        currentTokens = overlapTokens;
      }

      currentChunk.push(processLine);
      currentTokens += processLineTokens;
    }
  }

  const finalChunkContent = currentChunk
    .map(l => l.text)
    .join('\n')
    .trim();
  if (finalChunkContent) {
    // Assertion: Ensure final chunk doesn't exceed maxChunkSize
    if (currentTokens > maxChunkSize) {
      throw new Error(
        `Final chunk exceeds maxChunkSize: ${currentTokens} > ${maxChunkSize}`
      );
    }

    // Calculate the actual start offset after trim
    const untrimmedContent = currentChunk.map(l => l.text).join('\n');
    const trimmedStart = untrimmedContent.indexOf(finalChunkContent);
    const startOffset = currentChunk[0].offset + trimmedStart;

    chunks.push({
      content: finalChunkContent,
      headings: chunkHeadings,
      startOffset,
    });
  }

  return chunks;
}

type CountTokensFn = (text: string) => Promise<number>;

/**
 * Splits a long line that exceeds maxChunkSize into smaller sub-lines with offset tracking
 * Uses sentence boundaries first, then falls back to forced subdivision
 */
async function splitLongLineWithOffset(
  line: string,
  lineOffset: number,
  maxChunkSize: number,
  countTokens: CountTokensFn
): Promise<LineWithOffset[]> {
  // Step 1: Try splitting by sentence boundaries
  // Match sentence-ending punctuation: . ! ? 。！？
  const sentenceParts = line.split(/([。.!?！？]+)/);
  const subLines: LineWithOffset[] = [];
  let current = '';
  let currentOffset = lineOffset;

  for (const part of sentenceParts) {
    const testLine = current + part;
    const tokens = await countTokens(testLine);

    if (tokens > maxChunkSize && current) {
      const trimmed = current.trim();
      const trimStart = current.indexOf(trimmed);
      subLines.push({
        text: trimmed,
        offset: currentOffset + trimStart,
      });
      currentOffset += current.length;
      current = part;
    } else {
      current = testLine;
    }
  }

  if (current) {
    const trimmed = current.trim();
    const trimStart = current.indexOf(trimmed);
    subLines.push({
      text: trimmed,
      offset: currentOffset + trimStart,
    });
  }

  // Step 2: If any sub-line still exceeds maxChunkSize, force subdivide
  return await forceSubdivideWithOffset(subLines, maxChunkSize, countTokens);
}

/**
 * Force subdivides lines that still exceed maxChunkSize after sentence splitting
 * Uses binary search to find approximate split position, then adjusts to word boundaries
 */
async function forceSubdivideWithOffset(
  lines: LineWithOffset[],
  maxChunkSize: number,
  countTokens: CountTokensFn
): Promise<LineWithOffset[]> {
  const result: LineWithOffset[] = [];

  for (const { text: line, offset: lineOffset } of lines) {
    const tokens = await countTokens(line);
    if (tokens <= maxChunkSize) {
      result.push({ text: line, offset: lineOffset });
      continue;
    }

    // Binary search to find approximate split position, then adjust to word boundary
    let pos = 0;
    while (pos < line.length) {
      let left = pos;
      let right = line.length;
      let bestSplit = pos;

      // Binary search
      while (left < right) {
        const mid = Math.floor((left + right + 1) / 2);
        const substring = line.slice(pos, mid);
        const subTokens = await countTokens(substring);

        if (subTokens <= maxChunkSize) {
          bestSplit = mid;
          left = mid;
        } else {
          right = mid - 1;
        }
      }

      // Adjust to word boundary (search backwards for space)
      let adjustedSplit = bestSplit;
      if (bestSplit < line.length) {
        const searchStart = Math.max(pos, bestSplit - 50);
        const fragment = line.slice(searchStart, bestSplit);
        const lastSpace = fragment.lastIndexOf(' ');

        if (lastSpace > 0) {
          adjustedSplit = searchStart + lastSpace + 1;
        }
      }

      const splitLine = line.slice(pos, adjustedSplit).trim();
      if (splitLine) {
        // Assertion: Verify the split line doesn't exceed maxChunkSize
        const splitTokens = await countTokens(splitLine);
        if (splitTokens > maxChunkSize) {
          throw new Error(
            `Force-subdivided line exceeds maxChunkSize: ${splitTokens} > ${maxChunkSize}`
          );
        }
        // Calculate offset: pos is relative to line start, add trim adjustment
        const untrimmed = line.slice(pos, adjustedSplit);
        const trimStart = untrimmed.indexOf(splitLine);
        result.push({
          text: splitLine,
          offset: lineOffset + pos + trimStart,
        });
      }
      pos = adjustedSplit;

      // Safety check to avoid infinite loop
      if (pos === bestSplit && bestSplit >= line.length) {
        break;
      }
    }
  }

  return result;
}
