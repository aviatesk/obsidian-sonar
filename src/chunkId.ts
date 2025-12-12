/**
 * Chunk ID utilities
 *
 * Chunk IDs follow the format: "filePath#suffix"
 * - Title chunks: "filePath#title"
 * - Content chunks: "filePath#chunkIndex" (e.g., "path/to/file.md#0")
 */

const TITLE_SUFFIX = '#title';

export const ChunkId = {
  /**
   * Create a chunk ID for a title
   */
  forTitle(filePath: string): string {
    return `${filePath}${TITLE_SUFFIX}`;
  },

  /**
   * Create a chunk ID for content at the given index
   */
  forContent(filePath: string, index: number): string {
    return `${filePath}#${index}`;
  },

  /**
   * Check if a chunk ID represents a title
   */
  isTitle(id: string): boolean {
    return id.endsWith(TITLE_SUFFIX);
  },

  /**
   * Extract the file path from a chunk ID
   */
  getFilePath(id: string): string {
    const lastHashIndex = id.lastIndexOf('#');
    return id.substring(0, lastHashIndex);
  },

  /**
   * Extract the chunk index from a content chunk ID
   * Returns NaN for title chunks
   */
  getChunkIndex(id: string): number {
    const lastHashIndex = id.lastIndexOf('#');
    return parseInt(id.substring(lastHashIndex + 1), 10);
  },
};
