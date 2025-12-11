// Intl.Segmenter is available in modern browsers and Node.js 16+
interface SegmentData {
  segment: string;
  index: number;
  input: string;
  isWordLike?: boolean;
}

interface IntlSegmenter {
  segment(input: string): Iterable<SegmentData>;
}

interface IntlSegmenterConstructor {
  new (
    locales?: string | string[],
    options?: { granularity?: 'grapheme' | 'word' | 'sentence' }
  ): IntlSegmenter;
}

/**
 * Tokenizer using built-in Intl.Segmenter API
 * Uses ICU library for word segmentation - zero additional dependencies
 */
export class IntlSegmenterTokenizer {
  private segmenter: IntlSegmenter;

  constructor(locale: string = 'ja') {
    const SegmenterClass = (
      Intl as unknown as { Segmenter: IntlSegmenterConstructor }
    ).Segmenter;
    this.segmenter = new SegmenterClass(locale, { granularity: 'word' });
  }

  tokenize(text: string): string[] {
    const normalizedText = text.toLowerCase();
    const segments = [...this.segmenter.segment(normalizedText)];

    return segments
      .filter(segment => segment.isWordLike)
      .map(segment => segment.segment);
  }
}
