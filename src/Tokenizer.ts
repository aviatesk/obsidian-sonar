import { AutoTokenizer, PreTrainedTokenizer } from '@huggingface/transformers';
import { DEFAULT_COMMON_CONFIG } from './config';
import type { Logger } from './Logger';

/**
 * Map Ollama embedding model names to the correct Hugging Face repos
 * for their tokenizer/config (prefer Xenova-converted repos for transformers.js).
 */
export const TOKENIZER_MODEL_MAPPING: Record<string, string> = {
  // -------- BGE family --------
  // BGE-M3 uses an XLM-RoBERTa-style tokenizer (Xenova repo includes tokenizer.json)
  'bge-m3': 'Xenova/bge-m3',

  // English BGE v1.5 (BERT-style tokenizers)
  'bge-small': 'Xenova/bge-small-en-v1.5',
  'bge-base': 'Xenova/bge-base-en-v1.5',
  'bge-large': 'Xenova/bge-large-en-v1.5',

  // -------- MiniLM family --------
  // Ollama's "all-minilm" typically refers to L6-v2; add L12 variant explicitly if needed
  'all-minilm': 'Xenova/all-MiniLM-L6-v2',
  'all-minilm:l12-v2': 'Xenova/all-MiniLM-L12-v2',

  // -------- Nomic (Matryoshka) --------
  // Has its own tokenizer; do NOT map to bert-base-uncased
  'nomic-embed-text': 'nomic-ai/nomic-embed-text-v1.5',

  // -------- Mixedbread (MXBAI) --------
  // Uses its own tokenizer; do NOT map to MiniLM
  'mxbai-embed-large': 'mixedbread-ai/mxbai-embed-large-v1',

  // -------- Snowflake Arctic Embed (v1 & v2) --------
  // Default to "m" size unless a size tag is present
  'snowflake-arctic-embed': 'Snowflake/snowflake-arctic-embed-m',
  'snowflake-arctic-embed:m': 'Snowflake/snowflake-arctic-embed-m',
  'snowflake-arctic-embed:m-long': 'Snowflake/snowflake-arctic-embed-m', // tokenizer is the same
  'snowflake-arctic-embed:l': 'Snowflake/snowflake-arctic-embed-l',

  'snowflake-arctic-embed2': 'Snowflake/snowflake-arctic-embed-m-v2.0',
  'snowflake-arctic-embed2:m': 'Snowflake/snowflake-arctic-embed-m-v2.0',
  'snowflake-arctic-embed2:l': 'Snowflake/snowflake-arctic-embed-l-v2.0',

  // -------- E5 (English) --------
  'e5-small': 'Xenova/e5-small-v2',
  'e5-base': 'Xenova/e5-base-v2',
  'e5-large': 'Xenova/e5-large-v2',

  // -------- E5 (Multilingual) --------
  'multilingual-e5-base': 'intfloat/multilingual-e5-base',
  'multilingual-e5-large': 'intfloat/multilingual-e5-large',
  'multilingual-e5-large-instruct': 'intfloat/multilingual-e5-large-instruct',

  // -------- GTE family --------
  'gte-small': 'Xenova/gte-small',
  'gte-base': 'Xenova/gte-base',
  'gte-large': 'Xenova/gte-large',

  // -------- Jina v2 --------
  'jina-embeddings-v2-base-en': 'jinaai/jina-embeddings-v2-base-en',
  'jina-embeddings-v2-base-de': 'jinaai/jina-embeddings-v2-base-de',
  'jina-embeddings-v2-base-zh': 'jinaai/jina-embeddings-v2-base-zh',
  'jina-embeddings-v2-base-es': 'jinaai/jina-embeddings-v2-base-es',
  'jina-embeddings-v2-base-code': 'jinaai/jina-embeddings-v2-base-code',

  // -------- EmbeddingGemma --------
  embeddinggemma: 'onnx-community/embeddinggemma-300m-ONNX',
  'embeddinggemma:300m': 'onnx-community/embeddinggemma-300m-ONNX',
};

/**
 * Transformers.js based tokenizer for accurate token counting
 */
export class Tokenizer {
  private tokenizer: PreTrainedTokenizer;
  private logger: Logger;

  private constructor(tokenizer: PreTrainedTokenizer, logger: Logger) {
    this.tokenizer = tokenizer;
    this.logger = logger;
  }

  static async initialize(
    model: string,
    logger: Logger,
    tokenizerModel?: string
  ): Promise<Tokenizer> {
    const defaultModel =
      TOKENIZER_MODEL_MAPPING[
        DEFAULT_COMMON_CONFIG.embeddingModel.replace(/:[a-zA-Z0-9_-]+$/, '')
      ];
    let tokenizer: PreTrainedTokenizer;

    if (tokenizerModel) {
      try {
        logger.log(`Loading custom tokenizer model: ${tokenizerModel}`);
        tokenizer = await AutoTokenizer.from_pretrained(tokenizerModel);
        logger.log(
          `✅ Successfully loaded custom tokenizer: ${tokenizerModel}`
        );
      } catch (error) {
        logger.error(`Failed to load custom tokenizer: ${tokenizerModel}`);
        throw error;
      }
      return new Tokenizer(tokenizer, logger);
    }

    const cleanModel = model?.replace(/:[a-zA-Z0-9_-]+$/, '') || '';

    let modelName = model ? TOKENIZER_MODEL_MAPPING[model] : undefined;

    if (!modelName && cleanModel) {
      modelName = TOKENIZER_MODEL_MAPPING[cleanModel];
    }

    if (!modelName) {
      modelName = defaultModel;
      if (model && cleanModel) {
        logger.warn(
          `⚠️ No tokenizer mapping for '${model}', using default: ${defaultModel}`
        );
      }
    }

    try {
      logger.log(`Loading tokenizer for ${model || 'default'}: ${modelName}`);
      tokenizer = await AutoTokenizer.from_pretrained(modelName);
      logger.log(`✅ Successfully loaded tokenizer: ${modelName}`);
    } catch (error) {
      logger.error(`Failed to load tokenizer for ${modelName}`);
      if (modelName !== defaultModel) {
        logger.warn(
          `⚠️ Attempting fallback to default tokenizer: ${defaultModel}`
        );
        tokenizer = await AutoTokenizer.from_pretrained(defaultModel);
        logger.log(`✅ Fallback successful: using ${defaultModel}`);
      } else {
        throw error;
      }
    }

    return new Tokenizer(tokenizer, logger);
  }

  /**
   * Estimates the number of tokens in the given text.
   *
   * WARNING: For large texts (e.g., entire file contents), this method may hang
   * or perform poorly. When processing large documents, split the text by lines
   * and call this method for each line separately to avoid performance issues.
   *
   * @example
   * // Good: Process line by line for large texts
   * const lines = content.split('\n');
   * let totalTokens = 0;
   * for (const line of lines) {
   *   totalTokens += await tokenizer.estimateTokens(line);
   * }
   *
   * // Avoid: Processing entire large file at once
   * const tokens = await tokenizer.estimateTokens(largeFileContent); // May hang!
   */
  async estimateTokens(text: string): Promise<number> {
    if (!text) return 0;

    try {
      const { input_ids } = await this.tokenizer(text);
      return input_ids.size;
    } catch (error) {
      this.logger.error(`Failed to tokenize with transformers.js: ${error}`);
      throw error;
    }
  }

  /**
   * Returns token IDs for the given text, excluding special tokens.
   *
   * WARNING: For large texts, this method may hang. Process line by line instead.
   *
   * @returns Array of token IDs (as numbers)
   */
  async getTokenIds(text: string): Promise<number[]> {
    if (!text) return [];

    try {
      const { input_ids } = await this.tokenizer(text);

      // Get special token IDs for filtering
      const bosTokenId = this.tokenizer.model?.config?.bos_token_id;
      const eosTokenId = this.tokenizer.model?.config?.eos_token_id;
      const padTokenId = this.tokenizer.model?.config?.pad_token_id;

      const tokenIds: number[] = [];
      for (let i = 0; i < input_ids.size; i++) {
        const tokenId = input_ids.data[i];

        // Skip special tokens
        if (
          tokenId !== bosTokenId &&
          tokenId !== eosTokenId &&
          tokenId !== padTokenId
        ) {
          tokenIds.push(tokenId);
        }
      }

      return tokenIds;
    } catch (error) {
      this.logger.error(`Failed to tokenize with transformers.js: ${error}`);
      throw error;
    }
  }

  static formatTokenCount(count: number): string {
    return `${count} tokens`;
  }

  static formatTokenCountShort(count: number): string {
    if (count < 1000) {
      return `${count} tokens`;
    } else if (count < 10000) {
      return `${(count / 1000).toFixed(1)}k tokens`;
    } else {
      return `${(count / 1000).toFixed(0)}k tokens`;
    }
  }
}
