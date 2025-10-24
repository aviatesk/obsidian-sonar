/**
 * Tokenizer for BM25 full-text search
 * Supports mixed Japanese/English text
 */

export interface TokenizeOptions {
  toLowerCase?: boolean;
  includeUnigrams?: boolean;
}

const DEFAULT_OPTIONS: TokenizeOptions = {
  toLowerCase: true,
  includeUnigrams: true,
};

export class BM25Tokenizer {
  /**
   * Tokenizes text for BM25 indexing and search
   * - English/alphanumeric: word-based tokenization
   * - Japanese: bigram + unigram
   * - Dates/numbers: preserved as-is
   */
  tokenize(text: string, options?: TokenizeOptions): string[] {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const tokens: string[] = [];

    let normalizedText = text;
    if (opts.toLowerCase) {
      normalizedText = text.toLowerCase();
    }

    // Split by character type and extract segments
    const segments = this.segmentText(normalizedText);

    for (const segment of segments) {
      if (this.isAlphanumeric(segment)) {
        // English/alphanumeric: split by whitespace and punctuation
        const words = segment.split(/[\s\p{P}]+/u).filter(w => w.length > 0);
        tokens.push(...words);
      } else if (this.isJapanese(segment)) {
        // Japanese: bigram + unigram
        const bigramTokens = this.generateBigrams(segment);
        tokens.push(...bigramTokens);

        if (opts.includeUnigrams) {
          const unigramTokens = this.generateUnigrams(segment);
          tokens.push(...unigramTokens);
        }
      }
    }

    return tokens;
  }

  /**
   * Segments text into alphanumeric and Japanese blocks
   */
  private segmentText(text: string): string[] {
    const segments: string[] = [];
    let currentSegment = '';
    let currentType: 'alphanumeric' | 'japanese' | null = null;

    for (const char of text) {
      const charType = this.getCharType(char);

      if (charType === 'other') {
        // Punctuation/whitespace: flush current segment
        if (currentSegment) {
          segments.push(currentSegment);
          currentSegment = '';
          currentType = null;
        }
        continue;
      }

      if (currentType === null || currentType === charType) {
        // Continue current segment
        currentSegment += char;
        currentType = charType;
      } else {
        // Type changed: flush and start new segment
        if (currentSegment) {
          segments.push(currentSegment);
        }
        currentSegment = char;
        currentType = charType;
      }
    }

    if (currentSegment) {
      segments.push(currentSegment);
    }

    return segments;
  }

  private getCharType(char: string): 'alphanumeric' | 'japanese' | 'other' {
    const code = char.charCodeAt(0);

    // Alphanumeric (ASCII letters, numbers, hyphen for dates)
    if (
      (code >= 0x30 && code <= 0x39) || // 0-9
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a) || // a-z
      code === 0x2d // hyphen
    ) {
      return 'alphanumeric';
    }

    // Japanese (Hiragana, Katakana, Kanji)
    if (
      (code >= 0x3040 && code <= 0x309f) || // Hiragana
      (code >= 0x30a0 && code <= 0x30ff) || // Katakana
      (code >= 0x4e00 && code <= 0x9faf) // CJK Unified Ideographs
    ) {
      return 'japanese';
    }

    return 'other';
  }

  private isAlphanumeric(text: string): boolean {
    return text.length > 0 && this.getCharType(text[0]) === 'alphanumeric';
  }

  private isJapanese(text: string): boolean {
    return text.length > 0 && this.getCharType(text[0]) === 'japanese';
  }

  private generateBigrams(text: string): string[] {
    const bigrams: string[] = [];
    for (let i = 0; i < text.length - 1; i++) {
      bigrams.push(text.slice(i, i + 2));
    }
    return bigrams;
  }

  private generateUnigrams(text: string): string[] {
    return Array.from(text);
  }

  /**
   * Calculates term frequency in a document
   */
  calculateTermFrequency(tokens: string[]): Map<string, number> {
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }
    return tf;
  }
}
