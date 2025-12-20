import { describe, it, expect } from 'vitest';
import {
  reciprocalRankFusion,
  fuseFileResults,
  combineSearchResults,
  aggregateChunksToFiles,
  mergeAndDeduplicateChunks,
} from './SearchResultFusion';
import type { ChunkResult, SearchResult } from './SearchManager';
import type { ChunkMetadata } from './MetadataStore';
import { ChunkId } from './chunkId';

function createSearchResult(
  filePath: string,
  score: number,
  title?: string
): SearchResult {
  const metadata: ChunkMetadata = {
    id: ChunkId.forContent(filePath, 0),
    filePath,
    title: title || filePath,
    content: `Content of ${filePath}`,
    headings: [],
    mtime: Date.now(),
    size: 100,
    indexedAt: Date.now(),
  };
  return {
    filePath,
    title: title || filePath,
    score,
    topChunk: { content: metadata.content, score, metadata },
    chunkCount: 1,
    fileSize: 100,
  };
}

function createChunkResult(
  filePath: string,
  chunkIndex: number,
  score: number,
  title?: string
): ChunkResult {
  return {
    chunkId: ChunkId.forContent(filePath, chunkIndex),
    filePath,
    chunkIndex,
    content: `Chunk ${chunkIndex} of ${filePath}`,
    score,
    metadata: {
      id: ChunkId.forContent(filePath, chunkIndex),
      filePath,
      title: title || filePath,
      content: `Chunk ${chunkIndex} of ${filePath}`,
      headings: [],
      mtime: Date.now(),
      size: 100,
      indexedAt: Date.now(),
    },
  };
}

describe('aggregateChunksToFiles', () => {
  // max_p uses only the highest scoring chunk
  const defaultAggOptions = { method: 'max_p' as const };

  it('returns empty array for empty input', () => {
    const result = aggregateChunksToFiles([], defaultAggOptions);
    expect(result).toEqual([]);
  });

  it('groups chunks by filePath', () => {
    const chunks = [
      createChunkResult('a.md', 0, 0.9),
      createChunkResult('a.md', 1, 0.7),
      createChunkResult('b.md', 0, 0.8),
    ];

    const result = aggregateChunksToFiles(chunks, defaultAggOptions);
    expect(result.length).toBe(2);
    const filePaths = result.map(r => r.filePath).sort();
    expect(filePaths).toEqual(['a.md', 'b.md']);
  });

  it('selects highest-scoring chunk as topChunk', () => {
    const chunks = [
      createChunkResult('a.md', 0, 0.5),
      createChunkResult('a.md', 1, 0.9), // Best chunk
      createChunkResult('a.md', 2, 0.7),
    ];

    const result = aggregateChunksToFiles(chunks, defaultAggOptions);
    expect(result[0].topChunk.score).toBe(0.9);
    expect(result[0].topChunk.content).toBe('Chunk 1 of a.md');
  });

  it('counts chunks per file correctly', () => {
    const chunks = [
      createChunkResult('a.md', 0, 0.9),
      createChunkResult('a.md', 1, 0.7),
      createChunkResult('a.md', 2, 0.5),
      createChunkResult('b.md', 0, 0.8),
    ];
    const result = aggregateChunksToFiles(chunks, defaultAggOptions);
    const aResult = result.find(r => r.filePath === 'a.md')!;
    const bResult = result.find(r => r.filePath === 'b.md')!;
    expect(aResult.chunkCount).toBe(3);
    expect(bResult.chunkCount).toBe(1);
  });

  it('uses max_p aggregation (returns highest chunk score)', () => {
    const chunks = [
      createChunkResult('a.md', 0, 0.9),
      createChunkResult('a.md', 1, 0.7),
    ];
    const result = aggregateChunksToFiles(chunks, { method: 'max_p' });
    expect(result[0].score).toBe(0.9);
  });

  it('uses top_m_sum aggregation (sums top M chunks)', () => {
    const chunks = [
      createChunkResult('a.md', 0, 0.5),
      createChunkResult('a.md', 1, 0.3),
      createChunkResult('a.md', 2, 0.1),
    ];
    // With m=2, should sum top 2: 0.5 + 0.3 = 0.8
    const result = aggregateChunksToFiles(chunks, {
      method: 'top_m_sum',
      m: 2,
    });
    expect(result[0].score).toBe(0.8);
  });

  it('uses top_m_avg aggregation (averages top M chunks)', () => {
    const chunks = [
      createChunkResult('a.md', 0, 0.8),
      createChunkResult('a.md', 1, 0.4),
      createChunkResult('a.md', 2, 0.2),
    ];
    // With m=2, should average top 2: (0.8 + 0.4) / 2 = 0.6
    const result = aggregateChunksToFiles(chunks, {
      method: 'top_m_avg',
      m: 2,
    });
    expect(result[0].score).toBeCloseTo(0.6, 10);
  });

  it('sorts results by aggregated score descending', () => {
    const chunks = [
      createChunkResult('low.md', 0, 0.3),
      createChunkResult('high.md', 0, 0.9),
      createChunkResult('mid.md', 0, 0.6),
    ];
    const result = aggregateChunksToFiles(chunks, defaultAggOptions);
    expect(result[0].filePath).toBe('high.md');
    expect(result[1].filePath).toBe('mid.md');
    expect(result[2].filePath).toBe('low.md');
  });

  it('preserves metadata from top chunk', () => {
    const chunks = [createChunkResult('a.md', 0, 0.9, 'My Title')];
    const result = aggregateChunksToFiles(chunks, defaultAggOptions);
    expect(result[0].title).toBe('My Title');
    expect(result[0].fileSize).toBe(100);
  });
});

describe('mergeAndDeduplicateChunks', () => {
  it('returns empty array when all inputs are empty', () => {
    const result = mergeAndDeduplicateChunks([], []);
    expect(result).toEqual([]);
  });

  it('merges chunks from multiple sources', () => {
    const embedding = [createChunkResult('a.md', 0, 0.9)];
    const bm25 = [createChunkResult('b.md', 0, 0.8)];
    const result = mergeAndDeduplicateChunks(embedding, bm25);
    expect(result.length).toBe(2);
    const chunkIds = result.map(c => c.chunkId).sort();
    expect(chunkIds).toContain('a.md#0');
    expect(chunkIds).toContain('b.md#0');
  });

  it('deduplicates by chunkId, keeping first occurrence', () => {
    const embedding = [createChunkResult('a.md', 0, 0.9)];
    const bm25 = [createChunkResult('a.md', 0, 0.7)]; // Same chunkId
    const result = mergeAndDeduplicateChunks(embedding, bm25);
    expect(result.length).toBe(1);
  });

  it('handles multiple chunks per file', () => {
    const embedding = [
      createChunkResult('a.md', 0, 0.9),
      createChunkResult('a.md', 1, 0.7),
    ];
    const bm25 = [
      createChunkResult('a.md', 0, 0.6), // Duplicate of embedding chunk 0
      createChunkResult('a.md', 2, 0.8),
    ];
    const result = mergeAndDeduplicateChunks(embedding, bm25);
    expect(result.length).toBe(3); // chunks 0, 1, 2
    const chunk0 = result.find(c => c.chunkIndex === 0);
    expect(chunk0?.score).toBe(0.9); // First occurrence from embedding
  });

  it('works with single array input', () => {
    const chunks = [
      createChunkResult('a.md', 0, 0.9),
      createChunkResult('b.md', 0, 0.8),
    ];
    const result = mergeAndDeduplicateChunks(chunks);
    expect(result.length).toBe(2);
  });
});

describe('reciprocalRankFusion', () => {
  it('returns empty map when both inputs are empty', () => {
    const result = reciprocalRankFusion([], [], 0.6, 0.4);
    expect(result.size).toBe(0);
  });

  it('includes files from both sources', () => {
    const embedding = [createSearchResult('a.md', 0.9)];
    const bm25 = [createSearchResult('b.md', 0.8)];
    const result = reciprocalRankFusion(embedding, bm25, 0.6, 0.4);
    expect(result.has('a.md')).toBe(true);
    expect(result.has('b.md')).toBe(true);
  });

  it('ranks file in both sources higher than file in one source', () => {
    // a.md appears in both, b.md only in embedding
    const embedding = [
      createSearchResult('a.md', 0.9),
      createSearchResult('b.md', 0.8),
    ];
    const bm25 = [createSearchResult('a.md', 0.9)];
    const result = reciprocalRankFusion(embedding, bm25, 0.5, 0.5);
    expect(result.get('a.md')!).toBeGreaterThan(result.get('b.md')!);
  });

  it('higher weight source has more influence on final ranking', () => {
    // a.md: rank 1 in embedding, rank 2 in BM25
    // b.md: rank 2 in embedding, rank 1 in BM25
    const embedding = [
      createSearchResult('a.md', 0.9),
      createSearchResult('b.md', 0.8),
    ];
    const bm25 = [
      createSearchResult('b.md', 0.9),
      createSearchResult('a.md', 0.8),
    ];
    // With higher embedding weight, a.md should rank higher
    const embeddingHeavy = reciprocalRankFusion(embedding, bm25, 0.8, 0.2);
    expect(embeddingHeavy.get('a.md')!).toBeGreaterThan(
      embeddingHeavy.get('b.md')!
    );
    // With higher BM25 weight, b.md should rank higher
    const bm25Heavy = reciprocalRankFusion(embedding, bm25, 0.2, 0.8);
    expect(bm25Heavy.get('b.md')!).toBeGreaterThan(bm25Heavy.get('a.md')!);
  });
});

describe('fuseFileResults', () => {
  it('returns empty array when both inputs are empty', () => {
    const result = fuseFileResults([], [], 0.6, 0.4);
    expect(result).toEqual([]);
  });

  it('prefers embedding topChunk when file exists in both sources', () => {
    const embedding = [createSearchResult('a.md', 0.9, 'Embedding Title')];
    const bm25 = [createSearchResult('a.md', 0.8, 'BM25 Title')];
    const result = fuseFileResults(embedding, bm25, 0.6, 0.4);

    expect(result[0].title).toBe('Embedding Title');
  });

  it('uses BM25 topChunk when file only exists in BM25', () => {
    const embedding: SearchResult[] = [];
    const bm25 = [createSearchResult('a.md', 0.8, 'BM25 Title')];
    const result = fuseFileResults(embedding, bm25, 0.6, 0.4);

    expect(result[0].title).toBe('BM25 Title');
  });

  it('returns scores normalized to [0, 1]', () => {
    const embedding = [
      createSearchResult('a.md', 0.9),
      createSearchResult('b.md', 0.7),
    ];
    const bm25 = [
      createSearchResult('c.md', 0.9),
      createSearchResult('d.md', 0.7),
    ];
    const result = fuseFileResults(embedding, bm25, 0.6, 0.4);
    result.forEach(r => {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    });
  });

  it('sorts results by fused score descending', () => {
    // a.md: rank 1 in both (highest RRF)
    // b.md: rank 2 in embedding only
    // c.md: rank 2 in BM25 only
    const embedding = [
      createSearchResult('a.md', 0.9),
      createSearchResult('b.md', 0.8),
    ];
    const bm25 = [
      createSearchResult('a.md', 0.9),
      createSearchResult('c.md', 0.8),
    ];
    const result = fuseFileResults(embedding, bm25, 0.6, 0.4);
    expect(result.length).toBe(3);
    expect(result[0].filePath).toBe('a.md'); // In both, rank 1
    // b.md and c.md order depends on weights (0.6 vs 0.4)
    expect(result[1].filePath).toBe('b.md'); // Higher weight source
    expect(result[2].filePath).toBe('c.md');
  });

  it('handles asymmetric results: BM25 returns more files than embedding', () => {
    // Embedding finds 2 files, BM25 finds 5 files
    // overlap.md is in both (should rank highest)
    const embedding = [
      createSearchResult('overlap.md', 0.95),
      createSearchResult('semantic-only.md', 0.85),
    ];
    const bm25 = [
      createSearchResult('keyword1.md', 0.9),
      createSearchResult('overlap.md', 0.85),
      createSearchResult('keyword2.md', 0.8),
      createSearchResult('keyword3.md', 0.7),
      createSearchResult('keyword4.md', 0.6),
    ];
    const result = fuseFileResults(embedding, bm25, 0.6, 0.4);
    // Should include all unique files
    expect(result.length).toBe(6);
    // overlap.md should rank first (in both sources)
    expect(result[0].filePath).toBe('overlap.md');
    // Verify all files are present
    const filePaths = result.map(r => r.filePath);
    expect(filePaths).toContain('semantic-only.md');
    expect(filePaths).toContain('keyword1.md');
    expect(filePaths).toContain('keyword2.md');
    expect(filePaths).toContain('keyword3.md');
    expect(filePaths).toContain('keyword4.md');
  });

  it('handles asymmetric results: embedding returns more files than BM25', () => {
    // Embedding finds 5 files, BM25 finds 2 files
    const embedding = [
      createSearchResult('semantic1.md', 0.95),
      createSearchResult('overlap.md', 0.9),
      createSearchResult('semantic2.md', 0.85),
      createSearchResult('semantic3.md', 0.8),
      createSearchResult('semantic4.md', 0.75),
    ];
    const bm25 = [
      createSearchResult('overlap.md', 0.9),
      createSearchResult('keyword-only.md', 0.8),
    ];
    const result = fuseFileResults(embedding, bm25, 0.6, 0.4);
    expect(result.length).toBe(6);
    // overlap.md appears in both sources, getting contributions from both
    // RRF(overlap) = 0.6/62 + 0.4/61 > RRF(semantic1) = 0.6/61
    // Being in both sources outweighs higher rank in one source
    expect(result[0].filePath).toBe('overlap.md');
    const filePaths = result.map(r => r.filePath);
    expect(filePaths).toContain('semantic1.md');
    expect(filePaths).toContain('keyword-only.md');
  });

  it('handles completely disjoint results', () => {
    // No overlap between embedding and BM25
    const embedding = [
      createSearchResult('semantic1.md', 0.9),
      createSearchResult('semantic2.md', 0.8),
    ];
    const bm25 = [
      createSearchResult('keyword1.md', 0.9),
      createSearchResult('keyword2.md', 0.8),
    ];
    const result = fuseFileResults(embedding, bm25, 0.6, 0.4);
    expect(result.length).toBe(4);
    // With 0.6/0.4 weights:
    // semantic1: 0.6/61, semantic2: 0.6/62
    // keyword1: 0.4/61, keyword2: 0.4/62
    // Order: semantic1 > semantic2 > keyword1 > keyword2
    expect(result[0].filePath).toBe('semantic1.md');
    expect(result[1].filePath).toBe('semantic2.md');
    expect(result[2].filePath).toBe('keyword1.md');
    expect(result[3].filePath).toBe('keyword2.md');
  });

  it('handles reversed rankings between sources', () => {
    // Same files but completely opposite rankings
    const embedding = [
      createSearchResult('a.md', 0.9),
      createSearchResult('b.md', 0.8),
      createSearchResult('c.md', 0.7),
    ];
    const bm25 = [
      createSearchResult('c.md', 0.9),
      createSearchResult('b.md', 0.8),
      createSearchResult('a.md', 0.7),
    ];

    // With equal weights, all three have similar RRF scores:
    // a: 0.5/61 + 0.5/63, b: 0.5/62 + 0.5/62, c: 0.5/63 + 0.5/61
    // a ≈ c > b (items at extreme ranks in opposite sources tie)
    const equalWeight = fuseFileResults(embedding, bm25, 0.5, 0.5);
    // b.md should be last (worst combined rank)
    expect(equalWeight[2].filePath).toBe('b.md');
    // With embedding-heavy weights, embedding order should dominate
    const embeddingHeavy = fuseFileResults(embedding, bm25, 0.9, 0.1);
    expect(embeddingHeavy[0].filePath).toBe('a.md');
    // With BM25-heavy weights, BM25 order should dominate
    const bm25Heavy = fuseFileResults(embedding, bm25, 0.1, 0.9);
    expect(bm25Heavy[0].filePath).toBe('c.md');
  });
});

describe('combineSearchResults', () => {
  it('returns empty array when both inputs are empty', () => {
    const result = combineSearchResults([], [], 0.3, 0.7, 10);
    expect(result).toEqual([]);
  });

  it('calculates weighted average of title and content scores', () => {
    const title = [createSearchResult('a.md', 0.8)];
    const content = [createSearchResult('a.md', 0.6)];
    // titleWeight=0.3, contentWeight=0.7
    // Expected: (0.3*0.8 + 0.7*0.6) / 1.0 = 0.24 + 0.42 = 0.66
    const result = combineSearchResults(title, content, 0.3, 0.7, 10);
    expect(result[0].score).toBeCloseTo(0.66, 5);
  });

  it('handles file only in title results (content score = 0)', () => {
    const title = [createSearchResult('a.md', 0.8)];
    const content: SearchResult[] = [];
    // titleWeight=0.3, contentWeight=0.7
    // Expected: (0.3*0.8 + 0.7*0) / 1.0 = 0.24
    const result = combineSearchResults(title, content, 0.3, 0.7, 10);
    expect(result[0].score).toBeCloseTo(0.24, 5);
  });

  it('handles file only in content results (title score = 0)', () => {
    const title: SearchResult[] = [];
    const content = [createSearchResult('a.md', 0.6)];
    // titleWeight=0.3, contentWeight=0.7
    // Expected: (0.3*0 + 0.7*0.6) / 1.0 = 0.42
    const result = combineSearchResults(title, content, 0.3, 0.7, 10);
    expect(result[0].score).toBeCloseTo(0.42, 5);
  });

  it('prioritizes content topChunk over title topChunk', () => {
    const title = [createSearchResult('a.md', 0.8, 'Title Result')];
    const content = [createSearchResult('a.md', 0.6, 'Content Result')];
    const result = combineSearchResults(title, content, 0.3, 0.7, 10);
    expect(result[0].title).toBe('Content Result');
  });

  it('falls back to title topChunk when content not available', () => {
    const title = [createSearchResult('a.md', 0.8, 'Title Result')];
    const content: SearchResult[] = [];
    const result = combineSearchResults(title, content, 0.3, 0.7, 10);
    expect(result[0].title).toBe('Title Result');
  });

  it('respects topK limit', () => {
    const title = [
      createSearchResult('a.md', 0.9),
      createSearchResult('b.md', 0.8),
      createSearchResult('c.md', 0.7),
    ];
    const result = combineSearchResults(title, [], 1.0, 0.0, 2);
    expect(result.length).toBe(2);
    expect(result[0].filePath).toBe('a.md');
    expect(result[1].filePath).toBe('b.md');
  });

  it('sorts by combined score descending', () => {
    // a.md: title=0.9, content=0.1 → (0.5*0.9 + 0.5*0.1) = 0.5
    // b.md: title=0.1, content=0.9 → (0.5*0.1 + 0.5*0.9) = 0.5
    // c.md: title=0.8, content=0.8 → (0.5*0.8 + 0.5*0.8) = 0.8
    const title = [
      createSearchResult('a.md', 0.9),
      createSearchResult('b.md', 0.1),
      createSearchResult('c.md', 0.8),
    ];
    const content = [
      createSearchResult('a.md', 0.1),
      createSearchResult('b.md', 0.9),
      createSearchResult('c.md', 0.8),
    ];
    const result = combineSearchResults(title, content, 0.5, 0.5, 10);
    expect(result[0].filePath).toBe('c.md'); // Highest combined: 0.8
  });
});
