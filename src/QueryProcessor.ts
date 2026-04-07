import type { LlamaCppEmbedder } from './LlamaCppEmbedder';

export interface QueryOptions {
  title?: string;
  lineStart: number;
  lineEnd: number;
  hasSelection: boolean;
  selectedText?: string;
  maxTokens: number;
  embedder: LlamaCppEmbedder;
}

export async function processQuery(
  content: string,
  options: QueryOptions
): Promise<string> {
  const titleTokens = options.title
    ? await options.embedder.countTokens(options.title)
    : 0;
  const remainingTokens = Math.max(10, options.maxTokens - titleTokens);

  let extractedContent: string;
  if (options.selectedText) {
    const SAFETY_MARGIN = 16;
    const hardLimit = options.embedder.contextSize;
    const selectionMax =
      hardLimit !== null
        ? Math.max(remainingTokens, hardLimit - titleTokens - SAFETY_MARGIN)
        : remainingTokens;
    const selectionTokens = await options.embedder.countTokens(
      options.selectedText
    );
    if (selectionTokens <= selectionMax) {
      extractedContent = options.selectedText;
    } else {
      const wordTruncated = await truncateToTokens(
        options.selectedText,
        selectionMax,
        options.embedder
      );
      extractedContent = wordTruncated
        ? wordTruncated
        : await truncateToTokensByChars(
            options.selectedText,
            selectionMax,
            options.embedder
          );
    }
  } else if (options.hasSelection) {
    extractedContent = await extractTokenBasedContent(
      content,
      options.lineStart,
      options.lineEnd,
      remainingTokens,
      options.embedder
    );
  } else {
    extractedContent = await extractAroundCenter(
      content,
      options.lineStart,
      remainingTokens,
      options.embedder
    );
  }

  return options.title
    ? `${options.title}\n\n${extractedContent}`
    : extractedContent;
}

async function extractTokenBasedContent(
  content: string,
  lineStart: number,
  lineEnd: number,
  remainingTokens: number,
  embedder: LlamaCppEmbedder
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
  embedder: LlamaCppEmbedder
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
  embedder: LlamaCppEmbedder
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

export interface TokenCounter {
  countTokens(text: string): Promise<number>;
}

export async function truncateTextToTokens(
  text: string,
  maxTokens: number,
  counter: TokenCounter
): Promise<string> {
  let lo = 0;
  let hi = text.length;
  let best = '';
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = text.slice(0, mid);
    const tokens = await counter.countTokens(candidate);
    if (tokens <= maxTokens) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

async function truncateToTokensByChars(
  text: string,
  maxTokens: number,
  embedder: LlamaCppEmbedder
): Promise<string> {
  return truncateTextToTokens(text, maxTokens, embedder);
}
