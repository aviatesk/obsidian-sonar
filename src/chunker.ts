import type { LlamaCppEmbedder } from './LlamaCppEmbedder';

export interface Chunk {
  content: string;
  headings: string[];
  startOffset: number;
}

type CountTokensFn = (text: string) => Promise<number>;

// Batch size for hybrid chunking - accumulate this many lines before tokenizing
const BATCH_SIZE = 10;

/**
 * Creates a memoized version of countTokens for use within a single chunking session.
 * Cache is local to the function scope and automatically cleaned up after chunking completes.
 */
function createMemoizedCountTokens(
  embedder: Pick<LlamaCppEmbedder, 'countTokens'>
): CountTokensFn {
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

/**
 * Creates chunks from content using a hybrid approach for performance.
 *
 * Instead of tokenizing each line individually (could be slow due to HTTP overhead),
 * this implementation:
 * 1. Accumulates lines in batches and tokenizes the whole chunk
 * 2. Only when exceeding the limit, switches to per-line mode to find exact boundary
 *
 * This reduces tokenize calls from O(lines) to O(lines/batchSize + chunks*batchSize).
 */
export async function createChunks(
  content: string,
  maxChunkSize: number,
  chunkOverlap: number,
  embedder: Pick<LlamaCppEmbedder, 'countTokens'>
): Promise<Chunk[]> {
  const countTokens = createMemoizedCountTokens(embedder);

  const trimmedContent = content.trim();
  if (!trimmedContent) {
    return [];
  }

  const trimOffset = content.indexOf(trimmedContent);
  const lines = trimmedContent.split('\n');

  // Pre-calculate offset for each line
  const lineOffsets: number[] = [];
  let offset = trimOffset;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }

  const chunks: Chunk[] = [];
  let currentLines: LineWithOffset[] = [];
  let currentTokens = 0;
  let currentHeadings: string[] = [];
  let chunkHeadings: string[] = [];
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    // Phase 1: Batch accumulation (no heading tracking here - just test if batch fits)
    const batchEnd = Math.min(lineIndex + BATCH_SIZE, lines.length);
    const batchLines: LineWithOffset[] = [];

    for (let i = lineIndex; i < batchEnd; i++) {
      batchLines.push({ text: lines[i], offset: lineOffsets[i] });
    }

    const testChunk = [...currentLines, ...batchLines];
    const testContent = testChunk.map(l => l.text).join('\n');
    const testTokens = await countTokens(testContent);

    if (testTokens <= maxChunkSize) {
      // Batch fits - now track headings and add to currentLines
      for (let i = lineIndex; i < batchEnd; i++) {
        const line = lines[i];
        updateHeadings(line, currentHeadings, h => {
          currentHeadings = h;
          chunkHeadings = [...h];
        });
      }
      currentLines = testChunk;
      currentTokens = testTokens;
      lineIndex = batchEnd;
      continue;
    }

    // Phase 2: Exceeded limit - process line by line to find exact boundary
    // Use incremental token counting to avoid re-tokenizing entire chunk
    for (let i = lineIndex; i < batchEnd; i++) {
      const line = lines[i];
      const lineOffset = lineOffsets[i];

      const lineTokens = await countTokens(line);
      const processLines: LineWithOffset[] =
        lineTokens > maxChunkSize
          ? await splitLongLine(line, lineOffset, maxChunkSize, countTokens)
          : [{ text: line, offset: lineOffset }];

      for (const processLine of processLines) {
        const processLineTokens = await countTokens(processLine.text);
        // Estimate: current + newline (1 token) + new line tokens
        const estimatedTokens =
          currentTokens + (currentLines.length > 0 ? 1 : 0) + processLineTokens;

        if (estimatedTokens > maxChunkSize && currentLines.length > 0) {
          // Save current chunk with CURRENT headings (before processing new line)
          chunks.push({
            content: currentLines.map(l => l.text).join('\n'),
            headings: chunkHeadings,
            startOffset: currentLines[0].offset,
          });

          const { lines: overlapLines, tokens: overlapTokens } =
            await calculateOverlap(
              currentLines,
              chunkOverlap,
              maxChunkSize,
              processLineTokens,
              countTokens
            );
          currentLines = overlapLines;
          currentTokens = overlapTokens;
        }

        currentLines.push(processLine);
        currentTokens += (currentLines.length > 1 ? 1 : 0) + processLineTokens;

        // Track headings AFTER adding to chunk
        updateHeadings(processLine.text, currentHeadings, h => {
          currentHeadings = h;
          chunkHeadings = [...h];
        });
      }
    }

    lineIndex = batchEnd;
  }

  if (currentLines.length > 0) {
    const finalContent = currentLines
      .map(l => l.text)
      .join('\n')
      .trim();
    if (finalContent) {
      const untrimmedContent = currentLines.map(l => l.text).join('\n');
      const trimStart = untrimmedContent.indexOf(finalContent);
      chunks.push({
        content: finalContent,
        headings: chunkHeadings,
        startOffset: currentLines[0].offset + trimStart,
      });
    }
  }

  return chunks;
}

/**
 * Update heading context based on a line.
 */
function updateHeadings(
  line: string,
  currentHeadings: string[],
  setter: (h: string[]) => void
): void {
  if (line.startsWith('#')) {
    const level = line.match(/^#+/)?.[0].length || 0;
    const heading = line.replace(/^#+\s*/, '').trim();
    if (level <= 3) {
      const newHeadings = currentHeadings.slice(0, level - 1);
      newHeadings.push(heading);
      setter(newHeadings);
    }
  }
}

interface OverlapResult {
  lines: LineWithOffset[];
  tokens: number;
}

/**
 * Calculate overlap lines for the next chunk.
 * Returns both the lines and their total token count for incremental tracking.
 */
async function calculateOverlap(
  currentLines: LineWithOffset[],
  chunkOverlap: number,
  maxChunkSize: number,
  nextLineTokens: number,
  countTokens: CountTokensFn
): Promise<OverlapResult> {
  const overlapLines: LineWithOffset[] = [];
  let overlapTokens = 0;

  for (
    let j = currentLines.length - 1;
    j >= 0 && overlapTokens < chunkOverlap;
    j--
  ) {
    const lineTokens = await countTokens(currentLines[j].text);
    if (overlapTokens + lineTokens <= chunkOverlap) {
      overlapLines.unshift(currentLines[j]);
      overlapTokens += lineTokens;
    } else {
      break;
    }
  }

  while (
    overlapLines.length > 0 &&
    overlapTokens + nextLineTokens > maxChunkSize
  ) {
    const removedLine = overlapLines.shift()!;
    const removedTokens = await countTokens(removedLine.text);
    overlapTokens -= removedTokens;
  }

  return { lines: overlapLines, tokens: overlapTokens };
}

/**
 * Splits a long line that exceeds maxChunkSize into smaller pieces.
 * Uses sentence boundaries first, then falls back to forced subdivision.
 */
async function splitLongLine(
  line: string,
  lineOffset: number,
  maxChunkSize: number,
  countTokens: CountTokensFn
): Promise<LineWithOffset[]> {
  // Step 1: Try splitting by sentence boundaries
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

  // Step 2: Force subdivide any remaining long pieces
  return await forceSubdivide(subLines, maxChunkSize, countTokens);
}

/**
 * Force subdivides lines that still exceed maxChunkSize.
 * Uses binary search to find split position, then adjusts to word boundaries.
 */
async function forceSubdivide(
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

    // Binary search to find split positions
    let pos = 0;
    while (pos < line.length) {
      let left = pos;
      let right = line.length;
      let bestSplit = pos;

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

      // Adjust to word boundary
      let adjustedSplit = bestSplit;
      if (bestSplit < line.length && bestSplit > pos) {
        const searchStart = Math.max(pos, bestSplit - 50);
        const fragment = line.slice(searchStart, bestSplit);
        const lastSpace = fragment.lastIndexOf(' ');
        if (lastSpace > 0) {
          adjustedSplit = searchStart + lastSpace + 1;
        }
      }

      // Safety: ensure progress is made to avoid infinite loop
      if (adjustedSplit <= pos) {
        // Force advance by at least one character
        adjustedSplit = Math.min(pos + 1, line.length);
      }

      const splitLine = line.slice(pos, adjustedSplit).trim();
      if (splitLine) {
        const untrimmed = line.slice(pos, adjustedSplit);
        const trimStart = untrimmed.indexOf(splitLine);
        result.push({
          text: splitLine,
          offset: lineOffset + pos + trimStart,
        });
      }

      pos = adjustedSplit;
    }
  }

  return result;
}
