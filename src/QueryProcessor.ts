import type { Embedder } from './Embedder';

export interface QueryOptions {
  fileName: string;
  lineStart: number;
  lineEnd: number;
  hasSelection: boolean;
  maxTokens: number;
  embedder: Embedder;
}

export async function processQuery(
  content: string,
  options: QueryOptions
): Promise<string> {
  const fileNameTokens = await options.embedder.countTokens(options.fileName);
  const remainingTokens = Math.max(10, options.maxTokens - fileNameTokens);

  const extractedContent = options.hasSelection
    ? await extractTokenBasedContent(
        content,
        options.lineStart,
        options.lineEnd,
        remainingTokens,
        options.embedder
      )
    : await extractAroundCenter(
        content,
        options.lineStart,
        remainingTokens,
        options.embedder
      );

  return `${options.fileName}\n\n${extractedContent}`;
}

async function extractTokenBasedContent(
  content: string,
  lineStart: number,
  lineEnd: number,
  remainingTokens: number,
  embedder: Embedder
): Promise<string> {
  const lines = content.split('\n');
  let result: string[] = [];
  let currentTokens = 0;

  const startIdx = Math.max(0, lineStart);
  const endIdx = Math.min(lines.length - 1, lineEnd);

  for (let i = startIdx; i <= endIdx; i++) {
    const lineTokens = await embedder.countTokens(lines[i]);
    if (currentTokens + lineTokens <= remainingTokens) {
      result.push(lines[i]);
      currentTokens += lineTokens;
    } else {
      const remainingSpace = remainingTokens - currentTokens;
      if (remainingSpace > 10) {
        const partialLine = await truncateToTokens(
          lines[i],
          remainingSpace,
          embedder
        );
        result.push(partialLine);
      }
      break;
    }
  }

  if (result.length === 0 && startIdx <= endIdx) {
    return await truncateToTokens(lines[startIdx], remainingTokens, embedder);
  }

  return result.join('\n');
}

async function extractAroundCenter(
  content: string,
  centerLine: number,
  remainingTokens: number,
  embedder: Embedder
): Promise<string> {
  const lines = content.split('\n');
  let result: string[] = [];
  let currentTokens = 0;

  if (centerLine >= lines.length) {
    centerLine = lines.length - 1;
  }

  const centerLineTokens = await embedder.countTokens(lines[centerLine]);
  if (centerLineTokens <= remainingTokens) {
    result.push(lines[centerLine]);
    currentTokens += centerLineTokens;
  } else {
    return await truncateToTokens(lines[centerLine], remainingTokens, embedder);
  }

  let above = centerLine - 1;
  let below = centerLine + 1;

  while (
    currentTokens < remainingTokens &&
    (above >= 0 || below < lines.length)
  ) {
    if (above >= 0) {
      const lineTokens = await embedder.countTokens(lines[above]);
      if (currentTokens + lineTokens <= remainingTokens) {
        result.unshift(lines[above]);
        currentTokens += lineTokens;
        above--;
      } else {
        above = -1;
      }
    }

    if (below < lines.length && currentTokens < remainingTokens) {
      const lineTokens = await embedder.countTokens(lines[below]);
      if (currentTokens + lineTokens <= remainingTokens) {
        result.push(lines[below]);
        currentTokens += lineTokens;
        below++;
      } else {
        below = lines.length;
      }
    }
  }

  return result.join('\n');
}

async function truncateToTokens(
  text: string,
  maxTokens: number,
  embedder: Embedder
): Promise<string> {
  const words = text.split(/\s+/);
  let result: string[] = [];
  let currentTokens = 0;

  for (const word of words) {
    const wordTokens = await embedder.countTokens(word);
    if (currentTokens + wordTokens <= maxTokens) {
      result.push(word);
      currentTokens += wordTokens;
    } else {
      break;
    }
  }

  return result.join(' ');
}
