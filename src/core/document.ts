/**
 * Common document interfaces used across CLI and Obsidian implementations
 */

/**
 * Metadata associated with a document chunk
 */
export interface DocumentMetadata {
  filePath: string;
  title: string;
  headings: string[];
  chunkIndex: number;
  totalChunks: number;
  timestamp?: number; // Optional for backward compatibility
}

/**
 * An indexed document chunk with its content and metadata
 */
export interface IndexedDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata: DocumentMetadata;
}

/**
 * Search result with similarity score
 */
export interface SearchResult {
  document: IndexedDocument;
  score: number;
}
