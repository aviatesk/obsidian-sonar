import { Tokenizer } from './Tokenizer';
import { OllamaClient } from './OllamaClient';
import type { Logger } from './Logger';

export interface QueryOptions {
  fileName: string;
  lineStart: number;
  lineEnd: number;
  hasSelection: boolean;
  maxTokens: number;
  tokenizer: Tokenizer;
}

export async function processQuery(
  content: string,
  options: QueryOptions
): Promise<string> {
  const fileNameTokens = await options.tokenizer.estimateTokens(
    options.fileName
  );
  const remainingTokens = Math.max(10, options.maxTokens - fileNameTokens);

  const extractedContent = options.hasSelection
    ? await extractTokenBasedContent(
        content,
        options.lineStart,
        options.lineEnd,
        remainingTokens,
        options.tokenizer
      )
    : await extractAroundCenter(
        content,
        options.lineStart,
        remainingTokens,
        options.tokenizer
      );

  return `${options.fileName}\n\n${extractedContent}`;
}

async function extractTokenBasedContent(
  content: string,
  lineStart: number,
  lineEnd: number,
  remainingTokens: number,
  tokenizer: Tokenizer
): Promise<string> {
  const lines = content.split('\n');
  let result: string[] = [];
  let currentTokens = 0;

  const startIdx = Math.max(0, lineStart);
  const endIdx = Math.min(lines.length - 1, lineEnd);

  for (let i = startIdx; i <= endIdx; i++) {
    const lineTokens = await tokenizer.estimateTokens(lines[i]);
    if (currentTokens + lineTokens <= remainingTokens) {
      result.push(lines[i]);
      currentTokens += lineTokens;
    } else {
      const remainingSpace = remainingTokens - currentTokens;
      if (remainingSpace > 10) {
        const partialLine = await truncateToTokens(
          lines[i],
          remainingSpace,
          tokenizer
        );
        result.push(partialLine);
      }
      break;
    }
  }

  if (result.length === 0 && startIdx <= endIdx) {
    return await truncateToTokens(lines[startIdx], remainingTokens, tokenizer);
  }

  return result.join('\n');
}

async function extractAroundCenter(
  content: string,
  centerLine: number,
  remainingTokens: number,
  tokenizer: Tokenizer
): Promise<string> {
  const lines = content.split('\n');
  let result: string[] = [];
  let currentTokens = 0;

  if (centerLine >= lines.length) {
    centerLine = lines.length - 1;
  }

  const centerLineTokens = await tokenizer.estimateTokens(lines[centerLine]);
  if (centerLineTokens <= remainingTokens) {
    result.push(lines[centerLine]);
    currentTokens += centerLineTokens;
  } else {
    return await truncateToTokens(
      lines[centerLine],
      remainingTokens,
      tokenizer
    );
  }

  let above = centerLine - 1;
  let below = centerLine + 1;

  while (
    currentTokens < remainingTokens &&
    (above >= 0 || below < lines.length)
  ) {
    if (above >= 0) {
      const lineTokens = await tokenizer.estimateTokens(lines[above]);
      if (currentTokens + lineTokens <= remainingTokens) {
        result.unshift(lines[above]);
        currentTokens += lineTokens;
        above--;
      } else {
        above = -1;
      }
    }

    if (below < lines.length && currentTokens < remainingTokens) {
      const lineTokens = await tokenizer.estimateTokens(lines[below]);
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
  tokenizer: Tokenizer
): Promise<string> {
  const words = text.split(/\s+/);
  let result: string[] = [];
  let currentTokens = 0;

  for (const word of words) {
    const wordTokens = await tokenizer.estimateTokens(word);
    if (currentTokens + wordTokens <= maxTokens) {
      result.push(word);
      currentTokens += wordTokens;
    } else {
      break;
    }
  }

  return result.join(' ');
}

export async function extractWithLLM(
  input: string,
  maxTokens: number,
  ollamaUrl: string,
  summaryModel: string,
  logger: Logger
): Promise<string> {
  const ollamaClient = new OllamaClient({
    ollamaUrl,
    model: summaryModel,
  });

  const summaryTokens = Math.max(20, Math.floor(maxTokens * 0.4));
  const keywordTokens = maxTokens - summaryTokens;

  const prompt = `Extract a search query from the following text for finding related documents in a RAG system.
Requirements:
1. Write in the same language as the input text (do not translate)
2. Start with ONE concise sentence summarizing the main topic or question (max ${summaryTokens} tokens)
3. Follow with relevant keywords, concepts, and entities separated by commas (max ${keywordTokens} tokens)
4. Total output should be approximately ${maxTokens} tokens
5. Focus on searchable terms that would help find similar or related documents

Text to analyze follows:
========================

${input}`;

  try {
    const extractionQuery = await ollamaClient.generate(prompt);
    return extractionQuery.trim();
  } catch (err) {
    logger.error(`LLM extraction generation failed: ${err}`);
    return input;
  }
}
