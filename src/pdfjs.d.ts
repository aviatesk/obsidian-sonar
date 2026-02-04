// Type definitions for Obsidian's built-in PDF.js (window.pdfjsLib)

declare global {
  interface Window {
    pdfjsLib: PdfjsLib;
  }
}

export interface PdfjsLib {
  getDocument(src: DocumentInitParameters): PDFDocumentLoadingTask;
}

export interface DocumentInitParameters {
  data?: ArrayBuffer | Uint8Array;
  url?: string;
  verbosity?: number; // 0 = errors only, 1 = warnings, 5 = all
  cMapPacked?: boolean;
  cMapUrl?: string;
  standardFontDataUrl?: string;
}

export interface PDFDocumentLoadingTask {
  promise: Promise<PDFDocumentProxy>;
  destroy(): void;
}

export interface PDFDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<PDFPageProxy>;
  destroy(): Promise<void>;
}

export interface PDFPageProxy {
  pageNumber: number;
  getTextContent(params?: TextContentParameters): Promise<TextContent>;
}

export interface TextContentParameters {
  includeMarkedContent?: boolean;
  disableNormalization?: boolean;
}

export interface TextContent {
  items: TextItem[];
  styles: Record<string, TextStyle>;
}

export interface TextItem {
  str: string;
  dir: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
}

export interface TextStyle {
  fontFamily: string;
  ascent: number;
  descent: number;
  vertical?: boolean;
}

// Obsidian's internal PDF viewer types (not part of public API)
// These may break with Obsidian updates.

import type { View, TFile } from 'obsidian';

export interface PdfEventBus {
  on(eventName: string, listener: (data: unknown) => void): void;
  off(eventName: string, listener: (data: unknown) => void): void;
}

export interface ObsidianPdfViewer {
  eventBus: PdfEventBus;
  page: number;
  pdfDocument: PDFDocumentProxy | null;
}

export interface PdfViewerChild {
  pdfViewer: ObsidianPdfViewer;
}

export interface PdfViewerComponent {
  child: PdfViewerChild | null;
  loadFile: (file: TFile, subpath?: string) => Promise<void>;
}

export interface PdfView extends View {
  viewer: PdfViewerComponent;
  file: TFile | null;
}

export interface PageChangingEvent {
  pageNumber: number;
}
