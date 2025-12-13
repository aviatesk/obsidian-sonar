import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
// Use legacy build for Node.js environment (no DOM APIs required)
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  extractTextFromBuffer,
  normalizeText,
  findPageForOffset,
  type PdfExtractResult,
} from './pdfExtractor';
import type { PdfjsLib } from './pdfjs.d';

const TEST_PDF_PATH = path.join(
  __dirname,
  'test-helpers',
  'fixtures',
  'mitou.pdf'
);

const pdfjsLib = pdfjs as unknown as PdfjsLib;

describe('pdfExtractor', () => {
  describe('normalizeText', () => {
    it('normalizes Unicode (NFKC)', () => {
      // Full-width characters to half-width
      expect(normalizeText('ＡＢＣ')).toBe('ABC');
      expect(normalizeText('１２３')).toBe('123');
    });

    it('collapses multiple spaces', () => {
      expect(normalizeText('hello    world')).toBe('hello world');
      expect(normalizeText('a  b   c    d')).toBe('a b c d');
    });

    it('normalizes various whitespace to space', () => {
      expect(normalizeText('hello\tworld')).toBe('hello world');
      expect(normalizeText('hello\r\nworld')).toBe('hello\nworld');
    });

    it('collapses multiple newlines to at most two', () => {
      expect(normalizeText('a\n\n\nb')).toBe('a\n\nb');
      expect(normalizeText('a\n\n\n\n\nb')).toBe('a\n\nb');
    });

    it('trims whitespace from each line', () => {
      expect(normalizeText('  hello  \n  world  ')).toBe('hello\nworld');
    });

    it('trims leading/trailing whitespace from entire text', () => {
      expect(normalizeText('  hello world  ')).toBe('hello world');
      expect(normalizeText('\n\nhello\n\n')).toBe('hello');
    });

    it('handles empty string', () => {
      expect(normalizeText('')).toBe('');
    });

    it('handles string with only whitespace', () => {
      expect(normalizeText('   \n\n\t  ')).toBe('');
    });
  });

  describe('extractTextFromBuffer', () => {
    let pdfBuffer: ArrayBuffer;
    let extractResult: PdfExtractResult;

    beforeAll(async () => {
      const fileBuffer = fs.readFileSync(TEST_PDF_PATH);
      pdfBuffer = fileBuffer.buffer.slice(
        fileBuffer.byteOffset,
        fileBuffer.byteOffset + fileBuffer.byteLength
      );

      extractResult = await extractTextFromBuffer(pdfBuffer, pdfjsLib, {
        cMapUrl: undefined,
        standardFontDataUrl: undefined,
      });
    });

    it('extracts page numbers correctly', () => {
      for (let i = 0; i < extractResult.pages.length; i++) {
        expect(extractResult.pages[i].pageNumber).toBe(i + 1);
      }
    });

    it('offsets work correctly with findPageForOffset', () => {
      for (const page of extractResult.pages) {
        // Offset at page start should map to that page
        expect(findPageForOffset(extractResult.pages, page.startOffset)).toBe(
          page.pageNumber
        );
        // Offset in middle of page should also map to that page
        if (page.normalizedText.length > 1) {
          const midOffset =
            page.startOffset + Math.floor(page.normalizedText.length / 2);
          expect(findPageForOffset(extractResult.pages, midOffset)).toBe(
            page.pageNumber
          );
        }
      }
    });

    it('extracts expected content (target 成果報告会 on page 14)', () => {
      const page14 = extractResult.pages.find(p => p.pageNumber === 14);
      expect(page14).toBeDefined();
      expect(page14!.normalizedText).toContain('成果報告会');
    });
  });
});
