import { AutoTokenizer, PreTrainedTokenizer } from '@huggingface/transformers';

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
};

/**
 * Callback for displaying notifications when console is not enough (e.g., in Obsidian)
 */
export type FallbackNotification = (
  message: string,
  type: 'info' | 'warning' | 'error'
) => void;

/**
 * Transformers.js based tokenizer for accurate token counting
 */
export class Tokenizer {
  private static tokenizers: Map<string, PreTrainedTokenizer> = new Map();
  private static defaultModel = 'Xenova/bert-base-uncased';
  private static fallbackNotification: FallbackNotification | undefined;

  /**
   * Set fallback notification for environments where console is not enough (e.g., Obsidian)
   */
  static setFallbackNotification(callback: FallbackNotification): void {
    this.fallbackNotification = callback;
  }

  /**
   * Send notification (uses fallback if available, otherwise console)
   */
  private static notify(
    message: string,
    type: 'info' | 'warning' | 'error' = 'info'
  ): void {
    if (this.fallbackNotification) {
      this.fallbackNotification(message, type);
    } else {
      switch (type) {
        case 'error':
          console.error(message);
          break;
        case 'warning':
          console.warn(message);
          break;
        default:
          console.log(message);
      }
    }
  }

  /**
   * Get or create a tokenizer instance
   */
  private static async getTokenizer(
    model?: string,
    tokenizerModel?: string
  ): Promise<PreTrainedTokenizer> {
    // If explicit tokenizer model is specified, use it directly
    if (tokenizerModel) {
      try {
        this.notify(
          `Loading custom tokenizer model: ${tokenizerModel}`,
          'info'
        );
        const tokenizer = await AutoTokenizer.from_pretrained(tokenizerModel);
        this.tokenizers.set(tokenizerModel, tokenizer);
        this.notify(
          `✅ Successfully loaded custom tokenizer: ${tokenizerModel}`,
          'info'
        );
      } catch (error) {
        this.notify(
          `Failed to load custom tokenizer: ${tokenizerModel}`,
          'error'
        );
        throw error;
      }
      return this.tokenizers.get(tokenizerModel)!;
    }

    // Remove common tags like :latest, :q4_0, :q8_0, etc.
    const cleanModel = model?.replace(/:[a-zA-Z0-9_-]+$/, '') || '';

    // First try with full model name (in case it has specific tags we care about)
    let modelName = model ? TOKENIZER_MODEL_MAPPING[model] : undefined;

    // If not found, try with cleaned model name
    if (!modelName && cleanModel) {
      modelName = TOKENIZER_MODEL_MAPPING[cleanModel];
    }

    // If still not found, use default
    if (!modelName) {
      modelName = this.defaultModel;
      if (model && cleanModel) {
        this.notify(
          `⚠️ No tokenizer mapping for '${model}', using default: ${this.defaultModel}`,
          'warning'
        );
      }
    }

    if (!this.tokenizers.has(modelName)) {
      try {
        this.notify(
          `Loading tokenizer for ${model || 'default'}: ${modelName}`,
          'info'
        );
        const tokenizer = await AutoTokenizer.from_pretrained(modelName);
        this.tokenizers.set(modelName, tokenizer);
        this.notify(`✅ Successfully loaded tokenizer: ${modelName}`, 'info');
      } catch (error) {
        this.notify(`Failed to load tokenizer for ${modelName}`, 'error');
        if (modelName !== this.defaultModel) {
          this.notify(
            `⚠️ Attempting fallback to default tokenizer: ${this.defaultModel}`,
            'warning'
          );
          const defaultTokenizer = await AutoTokenizer.from_pretrained(
            this.defaultModel
          );
          this.tokenizers.set(modelName, defaultTokenizer);
          this.notify(
            `✅ Fallback successful: using ${this.defaultModel}`,
            'info'
          );
        } else {
          throw error;
        }
      }
    }

    return this.tokenizers.get(modelName)!;
  }

  /**
   * Estimate token count for a given text using transformers.js
   */
  static async estimateTokens(
    text: string,
    model?: string,
    tokenizerModel?: string
  ): Promise<number> {
    if (!text) return 0;

    try {
      const tokenizer = await this.getTokenizer(model, tokenizerModel);
      const { input_ids } = await tokenizer(text);
      return input_ids.size;
    } catch (error) {
      console.error('Failed to tokenize with transformers.js:', error);
      throw error;
    }
  }

  /**
   * Format token count for display
   */
  static formatTokenCount(count: number): string {
    return `${count} tokens`;
  }

  /**
   * Get a short format for status bar
   */
  static formatTokenCountShort(count: number): string {
    if (count < 1000) {
      return `${count} tokens`;
    } else if (count < 10000) {
      return `${(count / 1000).toFixed(1)}k tokens`;
    } else {
      return `${(count / 1000).toFixed(0)}k tokens`;
    }
  }

  /**
   * Initialize tokenizer with a specific model (preload)
   */
  static async initialize(
    model?: string,
    tokenizerModel?: string
  ): Promise<void> {
    await this.getTokenizer(model, tokenizerModel);
  }
}
