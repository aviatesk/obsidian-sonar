import { Tokenizer } from './Tokenizer';
import { OllamaClient } from './OllamaClient';

export interface QueryOptions {
  fileName: string;
  cursorLine: number;
  followCursor: boolean;
  withExtraction: boolean;
  maxTokens: number;
  embeddingModel: string;
  tokenizerModel: string | undefined;
  ollamaUrl: string;
  summaryModel: string;
  tokenizer: Tokenizer;
}

/**
 * Unified query processor with static functions
 */
export class QueryProcessor {
  static async process(
    content: string,
    options: QueryOptions
  ): Promise<string> {
    const fileNameTokens = await options.tokenizer.estimateTokens(
      options.fileName
    );
    const remainingTokens = Math.max(10, options.maxTokens - fileNameTokens);

    // Extract content based on followCursor setting
    let extractedContent: string;
    if (options.followCursor) {
      extractedContent = await QueryProcessor.extractTokenBasedContent(
        content,
        options.cursorLine,
        remainingTokens,
        false,
        options.tokenizer
      );
    } else {
      extractedContent = await QueryProcessor.extractTokenBasedContent(
        content,
        0,
        remainingTokens,
        true,
        options.tokenizer
      );
    }

    // Combine filename and content
    let query = `${options.fileName}\n\n${extractedContent}`;

    // Apply LLM extraction if requested
    if (options.withExtraction) {
      query = await QueryProcessor.generateLLMExtraction(
        query,
        options.ollamaUrl,
        options.summaryModel
      );
    }

    return query;
  }

  private static async extractTokenBasedContent(
    content: string,
    startLine: number,
    remainingTokens: number,
    expandFromStart: boolean,
    tokenizer: Tokenizer
  ): Promise<string> {
    const lines = content.split('\n');

    if (expandFromStart) {
      // Extract from the beginning of the file
      let result: string[] = [];
      let currentTokens = 0;

      for (
        let i = 0;
        i < lines.length && currentTokens < remainingTokens;
        i++
      ) {
        const lineTokens = await tokenizer.estimateTokens(lines[i]);
        if (currentTokens + lineTokens <= remainingTokens) {
          result.push(lines[i]);
          currentTokens += lineTokens;
        } else {
          // Add partial line if it fits
          const remainingSpace = remainingTokens - currentTokens;
          if (remainingSpace > 10) {
            const partialLine = await QueryProcessor.truncateToTokens(
              lines[i],
              remainingSpace,
              tokenizer
            );
            result.push(partialLine);
          }
          break;
        }
      }
      return result.join('\n');
    } else {
      // Extract around cursor position
      let result: string[] = [];
      let currentTokens = 0;

      // Start from cursor line
      if (startLine < lines.length) {
        const cursorLineTokens = await tokenizer.estimateTokens(
          lines[startLine]
        );
        if (cursorLineTokens <= remainingTokens) {
          result.push(lines[startLine]);
          currentTokens += cursorLineTokens;
        } else {
          return await QueryProcessor.truncateToTokens(
            lines[startLine],
            remainingTokens,
            tokenizer
          );
        }
      }

      // Expand equally above and below
      let above = startLine - 1;
      let below = startLine + 1;

      while (
        currentTokens < remainingTokens &&
        (above >= 0 || below < lines.length)
      ) {
        // Try to add line above
        if (above >= 0) {
          const lineTokens = await tokenizer.estimateTokens(lines[above]);
          if (currentTokens + lineTokens <= remainingTokens) {
            result.unshift(lines[above]);
            currentTokens += lineTokens;
            above--;
          } else {
            above = -1; // Stop expanding above
          }
        }

        // Try to add line below
        if (below < lines.length && currentTokens < remainingTokens) {
          const lineTokens = await tokenizer.estimateTokens(lines[below]);
          if (currentTokens + lineTokens <= remainingTokens) {
            result.push(lines[below]);
            currentTokens += lineTokens;
            below++;
          } else {
            below = lines.length; // Stop expanding below
          }
        }
      }

      return result.join('\n');
    }
  }

  private static async truncateToTokens(
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

  private static async generateLLMExtraction(
    input: string,
    ollamaUrl: string,
    summaryModel: string
  ): Promise<string> {
    const ollamaClient = new OllamaClient({
      ollamaUrl,
      model: summaryModel,
    });

    const prompt = `Extract a search query from the following text for finding related documents in a RAG system.
Requirements:
1. Write in the same language as the input text (do not translate)
2. Start with ONE concise sentence summarizing the main topic or question (max 50 tokens)
3. Follow with relevant keywords, concepts, and entities separated by commas
4. Total output should be approximately 128 tokens
5. Focus on searchable terms that would help find similar or related documents

Text to analyze follows:
========================

${input}`;

    try {
      const extractionQuery = await ollamaClient.generate(prompt);
      return extractionQuery.trim();
    } catch (error) {
      console.error('LLM extraction generation failed:', error);
      return input;
    }
  }
}
