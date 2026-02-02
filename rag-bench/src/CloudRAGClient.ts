/**
 * Cloud RAG client using OpenAI API.
 *
 * Configuration:
 * - Embedding: text-embedding-3-large
 * - Search: Vector similarity only (no BM25, no reranking)
 * - Generation: gpt-4.1-mini
 *
 * This represents a typical cloud RAG setup for comparison with Sonar.
 */

import { requestUrl } from 'obsidian';
import { WithLogging } from '../../src/WithLogging';
import type { ConfigManager } from '../../src/ConfigManager';

const OPENAI_EMBEDDING_URL = 'https://api.openai.com/v1/embeddings';
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const EMBEDDING_MODEL = 'text-embedding-3-large';
const CHAT_MODEL = 'gpt-4.1-mini';

// Chunking parameters (character-based, ~1875 tokens max)
const MAX_CHUNK_CHARS = 7500;
const CHUNK_OVERLAP_CHARS = 500;

interface EmbeddingResponse {
  data: { embedding: number[]; index: number }[];
  usage: { prompt_tokens: number; total_tokens: number };
}

interface ChatResponse {
  choices: { message: { content: string } }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface CloudDocument {
  docId: string;
  title: string;
  content: string;
}

interface CloudChunk {
  chunkId: string;
  docId: string;
  title: string;
  content: string;
  embedding?: number[];
}

export interface CloudSearchResult {
  docId: string;
  title: string;
  content: string;
  score: number;
}

interface IndexedCorpus {
  chunks: Map<string, CloudChunk>;
  documents: Map<string, CloudDocument>;
}

export class CloudRAGClient extends WithLogging {
  protected readonly componentName = 'CloudRAGClient';

  private apiKey: string;
  private embeddingUsage = { promptTokens: 0, totalTokens: 0 };
  private chatUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  constructor(
    protected configManager: ConfigManager,
    apiKey: string
  ) {
    super();
    this.apiKey = apiKey;
  }

  /**
   * Get embeddings for a batch of texts using OpenAI API.
   *
   * Includes retry logic with exponential backoff for rate limit errors (429).
   */
  async getEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const maxRetries = 5;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let response;
      try {
        response = await requestUrl({
          url: OPENAI_EMBEDDING_URL,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: EMBEDDING_MODEL,
            input: texts,
          }),
        });
      } catch (error) {
        // requestUrl throws on non-2xx status codes
        const errorMessage = String(error);
        if (errorMessage.includes('429')) {
          const backoffMs = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
          this.warn(
            `Rate limited, retrying in ${(backoffMs / 1000).toFixed(1)}s ` +
              `(attempt ${attempt + 1}/${maxRetries})`
          );
          await this.sleep(backoffMs);
          lastError = error instanceof Error ? error : new Error(errorMessage);
          continue;
        }
        throw error;
      }

      if (response.status === 429) {
        const backoffMs = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
        this.warn(
          `Rate limited, retrying in ${(backoffMs / 1000).toFixed(1)}s ` +
            `(attempt ${attempt + 1}/${maxRetries})`
        );
        await this.sleep(backoffMs);
        lastError = new Error(`Rate limited: ${response.status}`);
        continue;
      }

      if (response.status !== 200) {
        throw new Error(
          `OpenAI Embedding API error: ${response.status} ${response.text}`
        );
      }

      const data = response.json as EmbeddingResponse;
      this.embeddingUsage.promptTokens += data.usage.prompt_tokens;
      this.embeddingUsage.totalTokens += data.usage.total_tokens;

      const embeddings = new Array<number[]>(texts.length);
      for (const item of data.data) {
        embeddings[item.index] = item.embedding;
      }

      return embeddings;
    }

    throw lastError ?? new Error('Max retries exceeded for embedding request');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Chunk a document into smaller pieces for embedding.
   */
  private chunkDocument(doc: CloudDocument): CloudChunk[] {
    const chunks: CloudChunk[] = [];
    const text = `${doc.title}\n\n${doc.content}`;

    // If text is short enough, return as single chunk
    if (text.length <= MAX_CHUNK_CHARS) {
      chunks.push({
        chunkId: `${doc.docId}:0`,
        docId: doc.docId,
        title: doc.title,
        content: text,
      });
      return chunks;
    }

    // Split into chunks with overlap
    let start = 0;
    let chunkIndex = 0;

    while (start < text.length) {
      let end = start + MAX_CHUNK_CHARS;

      // Try to break at a sentence or paragraph boundary
      if (end < text.length) {
        const searchStart = Math.max(start + MAX_CHUNK_CHARS - 200, start);
        const searchRegion = text.slice(searchStart, end);

        // Look for paragraph break first, then sentence break
        const paragraphBreak = searchRegion.lastIndexOf('\n\n');
        const sentenceBreak = Math.max(
          searchRegion.lastIndexOf('. '),
          searchRegion.lastIndexOf('.\n')
        );

        if (paragraphBreak > 0) {
          end = searchStart + paragraphBreak + 2;
        } else if (sentenceBreak > 0) {
          end = searchStart + sentenceBreak + 2;
        }
      }

      const chunkContent = text.slice(start, end).trim();
      if (chunkContent.length > 0) {
        chunks.push({
          chunkId: `${doc.docId}:${chunkIndex}`,
          docId: doc.docId,
          title: doc.title,
          content: chunkContent,
        });
        chunkIndex++;
      }

      // Move start with overlap
      start = end - CHUNK_OVERLAP_CHARS;
      if (start >= text.length) break;
    }

    return chunks;
  }

  /**
   * Index corpus documents by chunking and generating embeddings.
   *
   * Processes in batches to avoid API limits.
   */
  async indexCorpus(
    documents: CloudDocument[],
    batchSize: number = 100,
    onProgress?: (indexed: number, total: number) => void
  ): Promise<IndexedCorpus> {
    // Chunk all documents
    const allChunks: CloudChunk[] = [];
    const documentMap = new Map<string, CloudDocument>();

    for (const doc of documents) {
      documentMap.set(doc.docId, doc);
      const chunks = this.chunkDocument(doc);
      allChunks.push(...chunks);
    }

    this.log(
      `Chunked ${documents.length} documents into ${allChunks.length} chunks`
    );

    // Generate embeddings in batches
    const chunkMap = new Map<string, CloudChunk>();

    for (let i = 0; i < allChunks.length; i += batchSize) {
      const batch = allChunks.slice(i, i + batchSize);
      const texts = batch.map(c => c.content);

      const embeddings = await this.getEmbeddings(texts);

      for (let j = 0; j < batch.length; j++) {
        const chunk = { ...batch[j], embedding: embeddings[j] };
        chunkMap.set(chunk.chunkId, chunk);
      }

      if (onProgress) {
        onProgress(Math.min(i + batchSize, allChunks.length), allChunks.length);
      }
    }

    return { chunks: chunkMap, documents: documentMap };
  }

  /**
   * Search corpus using vector similarity over chunks.
   *
   * Aggregates by document (max score per doc), no reranking.
   */
  async search(
    query: string,
    corpus: IndexedCorpus,
    topK: number
  ): Promise<CloudSearchResult[]> {
    const [queryEmbedding] = await this.getEmbeddings([query]);

    // Score all chunks
    const chunkScores: { chunkId: string; docId: string; score: number }[] = [];

    for (const [chunkId, chunk] of corpus.chunks) {
      if (!chunk.embedding) continue;
      const score = this.cosineSimilarity(queryEmbedding, chunk.embedding);
      chunkScores.push({ chunkId, docId: chunk.docId, score });
    }

    // Aggregate by document (take max score per doc)
    const docScores = new Map<string, number>();
    for (const { docId, score } of chunkScores) {
      const current = docScores.get(docId) ?? -Infinity;
      if (score > current) {
        docScores.set(docId, score);
      }
    }

    // Sort and get top documents
    const sortedDocs = Array.from(docScores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK);

    return sortedDocs.map(([docId, score]) => {
      const doc = corpus.documents.get(docId)!;
      return {
        docId,
        title: doc.title,
        content: doc.content,
        score,
      };
    });
  }

  /**
   * Generate answer using gpt-4.1-mini.
   */
  async generateAnswer(question: string, context: string): Promise<string> {
    const systemPrompt = `You are a helpful assistant that answers questions based on the provided context.
Answer the question directly and concisely. If the context doesn't contain enough information to answer the question, say "I don't know".
Do not make up information that is not in the context.`;

    const userPrompt = `Context:
${context}

Question: ${question}

Answer:`;

    const response = await requestUrl({
      url: OPENAI_CHAT_URL,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 256,
        temperature: 0,
      }),
    });

    if (response.status !== 200) {
      throw new Error(
        `OpenAI Chat API error: ${response.status} ${response.text}`
      );
    }

    const data = response.json as ChatResponse;
    this.chatUsage.promptTokens += data.usage.prompt_tokens;
    this.chatUsage.completionTokens += data.usage.completion_tokens;
    this.chatUsage.totalTokens += data.usage.total_tokens;

    return data.choices[0]?.message?.content?.trim() || '';
  }

  /**
   * Build context string from search results.
   */
  buildContext(results: CloudSearchResult[], maxChars: number = 32000): string {
    if (results.length === 0) {
      return 'No relevant information found.';
    }

    const parts: string[] = [];
    let totalChars = 0;

    for (const r of results) {
      const part = `[${r.title}]\n${r.content}`;
      if (totalChars + part.length > maxChars) {
        break;
      }
      parts.push(part);
      totalChars += part.length;
    }

    return parts.join('\n\n');
  }

  /**
   * Get accumulated API usage for cost estimation.
   */
  getUsage(): {
    embedding: { promptTokens: number; totalTokens: number };
    chat: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    estimatedCostUsd: number;
  } {
    // Pricing as of 2025 (approximate)
    // text-embedding-3-large: $0.13 / 1M tokens
    // gpt-4.1-mini: ~$0.10 / 1M input, ~$0.40 / 1M output (estimated)
    const embeddingCost = (this.embeddingUsage.totalTokens / 1_000_000) * 0.13;
    const chatInputCost = (this.chatUsage.promptTokens / 1_000_000) * 0.1;
    const chatOutputCost = (this.chatUsage.completionTokens / 1_000_000) * 0.4;

    return {
      embedding: this.embeddingUsage,
      chat: this.chatUsage,
      estimatedCostUsd: embeddingCost + chatInputCost + chatOutputCost,
    };
  }

  /**
   * Reset usage counters.
   */
  resetUsage(): void {
    this.embeddingUsage = { promptTokens: 0, totalTokens: 0 };
    this.chatUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude > 0 ? dotProduct / magnitude : 0;
  }
}
