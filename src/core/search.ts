/**
 * Core search functionality shared between CLI and Obsidian plugin
 */

import { OllamaClient } from './ollama-client';
import { SonarTokenizer } from './tokenizer';
import { DocumentMetadata } from './document';

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
}

/**
 * Unified query processor with static functions
 */
export class QueryProcessor {
  static async process(
    content: string,
    options: QueryOptions
  ): Promise<string> {
    // Calculate tokens for filename
    const fileNameTokens = await SonarTokenizer.estimateTokens(
      options.fileName,
      options.embeddingModel,
      options.tokenizerModel
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
        options.embeddingModel,
        options.tokenizerModel
      );
    } else {
      extractedContent = await QueryProcessor.extractTokenBasedContent(
        content,
        0,
        remainingTokens,
        true,
        options.embeddingModel,
        options.tokenizerModel
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
    expandFromStart: boolean = true,
    embeddingModel: string,
    tokenizerModel: string | undefined
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
        const lineTokens = await SonarTokenizer.estimateTokens(
          lines[i],
          embeddingModel,
          tokenizerModel
        );
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
              embeddingModel,
              tokenizerModel
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
        const cursorLineTokens = await SonarTokenizer.estimateTokens(
          lines[startLine],
          embeddingModel,
          tokenizerModel
        );
        if (cursorLineTokens <= remainingTokens) {
          result.push(lines[startLine]);
          currentTokens += cursorLineTokens;
        } else {
          return await QueryProcessor.truncateToTokens(
            lines[startLine],
            remainingTokens,
            embeddingModel,
            tokenizerModel
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
          const lineTokens = await SonarTokenizer.estimateTokens(
            lines[above],
            embeddingModel,
            tokenizerModel
          );
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
          const lineTokens = await SonarTokenizer.estimateTokens(
            lines[below],
            embeddingModel,
            tokenizerModel
          );
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
    embeddingModel: string,
    tokenizerModel: string | undefined
  ): Promise<string> {
    const words = text.split(/\s+/);
    let result: string[] = [];
    let currentTokens = 0;

    for (const word of words) {
      const wordTokens = await SonarTokenizer.estimateTokens(
        word,
        embeddingModel,
        tokenizerModel
      );
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
    try {
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

      const extractionQuery = await ollamaClient.generate(prompt);
      return extractionQuery.trim();
    } catch (error) {
      console.error('LLM extraction generation failed:', error);
      // Fallback to the original input
      return input;
    }
  }
}

export interface SearchResult {
  content: string;
  score: number;
  metadata: DocumentMetadata;
}

/**
 * Search coordinator - manages the search process
 */
export class SearchCoordinator {
  constructor(
    private embedder: { embed(texts: string[]): Promise<number[][]> },
    private vectorStore: {
      search(embedding: number[], topK: number): Promise<any[]>;
    }
  ) {}

  async search(query: string, topK: number = 5): Promise<SearchResult[]> {
    const queryEmbedding = await this.embedder.embed([query]);
    const results = await this.vectorStore.search(queryEmbedding[0], topK);

    // Transform results from { document, score } to { content, score, metadata }
    return results.map(result => ({
      content: result.document.content,
      score: result.score,
      metadata: result.document.metadata,
    }));
  }
}
