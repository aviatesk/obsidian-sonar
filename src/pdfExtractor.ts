import type { PdfjsLib, PDFDocumentProxy } from './pdfjs.d';
import { formatDuration } from './utils';

interface PdfLogger {
  log(msg: string, ...data: unknown[]): void;
}

const LOG_PREFIX = '[Sonar.PDF]';

export interface PdfPage {
  pageNumber: number;
  rawText: string;
  normalizedText: string;
  startOffset: number;
}

export interface PdfExtractResult {
  pages: PdfPage[];
  fullText: string;
  rawFullText: string;
}

// Testable entry point - accepts dependencies
export async function extractTextFromBuffer(
  buffer: ArrayBuffer,
  pdfjsLib: PdfjsLib,
  options?: {
    cMapUrl?: string;
    standardFontDataUrl?: string;
    logger?: PdfLogger;
  }
): Promise<PdfExtractResult> {
  const startTime = Date.now();
  const logger = options?.logger;

  logger?.log(`${LOG_PREFIX} Extracting text...`);

  const loadingTask = pdfjsLib.getDocument({
    data: buffer,
    verbosity: 0, // Suppress warnings (0 = errors only)
    cMapPacked: true,
    cMapUrl: options?.cMapUrl ?? '/lib/pdfjs/cmaps/',
    standardFontDataUrl:
      options?.standardFontDataUrl ?? '/lib/pdfjs/standard_fonts/',
  });

  const doc = await loadingTask.promise;

  try {
    const result = await extractTextFromDocument(doc);
    const duration = formatDuration(Date.now() - startTime);
    logger?.log(
      `${LOG_PREFIX} Extracted ${result.fullText.length} characters from ${result.pages.length} pages in ${duration}`
    );
    return result;
  } finally {
    await doc.destroy();
  }
}

export async function extractTextFromDocument(
  doc: PDFDocumentProxy
): Promise<PdfExtractResult> {
  const pages: PdfPage[] = [];
  let currentOffset = 0;

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const textContent = await page.getTextContent();

    const textParts: string[] = [];
    for (const item of textContent.items) {
      // pdfjs-dist uses slightly different types, so we check for 'str' property
      if ('str' in item && item.str) {
        textParts.push(item.str);
        if ('hasEOL' in item && item.hasEOL) {
          textParts.push('\n');
        }
      }
    }
    const rawText = textParts.join('');
    const normalizedText = normalizeText(rawText);

    pages.push({
      pageNumber: pageNum,
      rawText,
      normalizedText,
      startOffset: currentOffset,
    });

    currentOffset += normalizedText.length + 1; // +1 for page separator
  }

  const rawFullText = pages.map(p => p.rawText).join('\n');
  const fullText = pages.map(p => p.normalizedText).join('\n');

  return { pages, fullText, rawFullText };
}

export function normalizeText(text: string): string {
  // Unicode normalization (NFKC)
  let normalized = text.normalize('NFKC');

  // Normalize whitespace: convert various whitespace characters to regular space
  normalized = normalized.replace(/[\t\r\f\v]+/g, ' ');

  // Collapse multiple spaces into one
  normalized = normalized.replace(/ {2,}/g, ' ');

  // Normalize line breaks: collapse multiple newlines into at most two
  normalized = normalized.replace(/\n{3,}/g, '\n\n');

  // Remove leading/trailing whitespace from each line
  normalized = normalized
    .split('\n')
    .map(line => line.trim())
    .join('\n');

  // Remove leading/trailing whitespace from entire text
  normalized = normalized.trim();

  return normalized;
}

export function findPageForOffset(
  pages: PdfPage[],
  offset: number
): number | undefined {
  for (let i = pages.length - 1; i >= 0; i--) {
    if (offset >= pages[i].startOffset) {
      return pages[i].pageNumber;
    }
  }
  return undefined;
}
