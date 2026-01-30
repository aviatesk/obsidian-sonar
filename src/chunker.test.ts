import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createChunks } from './chunker';
import type { LlamaCppEmbedder } from './LlamaCppEmbedder';
import {
  setupTestEmbedder,
  cleanupTestEmbedder,
} from './test-helpers/embedder-setup';

let embedder: LlamaCppEmbedder;

beforeAll(async () => {
  embedder = await setupTestEmbedder();
}, 60000);

afterAll(async () => {
  await cleanupTestEmbedder();
});

async function assertMaxChunkSize(
  chunks: Array<{ content: string }>,
  maxChunkSize: number
): Promise<void> {
  for (let i = 0; i < chunks.length; i++) {
    const tokens = await embedder.countTokens(chunks[i].content);
    expect(tokens).toBeLessThanOrEqual(maxChunkSize);
  }
}

function assertContentPreserved(
  chunks: Array<{ content: string }>,
  expectedPhrases: string[]
): void {
  const combined = chunks.map(c => c.content).join(' ');
  for (const phrase of expectedPhrases) {
    expect(combined).toContain(phrase);
  }
}

describe('createChunks', () => {
  describe('maxChunkSize constraints', () => {
    it('splits long content into multiple chunks', async () => {
      const content = `This is a very long sentence with many words that should be split into multiple chunks. \
This is another sentence with more words to ensure proper splitting behavior works as expected. \
Additional content to make this even longer and force more chunking behavior to occur.`;

      const maxChunkSize = 30;
      const chunks = await createChunks(content, maxChunkSize, 10, embedder);

      expect(chunks.length).toBeGreaterThan(1);
      await assertMaxChunkSize(chunks, maxChunkSize);
    });

    it('enforces maxChunkSize when splitting by sentence boundaries', async () => {
      const content = `First sentence here with some additional words to make it longer. \
Second sentence follows with even more words to ensure proper length. \
Third sentence comes next and continues the pattern of longer text. \
Fourth sentence adds more content. \
Fifth and final sentence completes the test.`;

      const maxChunkSize = 15;
      const chunks = await createChunks(content, maxChunkSize, 3, embedder);

      expect(chunks.length).toBeGreaterThan(1);
      await assertMaxChunkSize(chunks, maxChunkSize);
      assertContentPreserved(chunks, ['First sentence', 'final sentence']);
    });

    it('enforces maxChunkSize when splitting by word boundaries', async () => {
      const content =
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12';

      const maxChunkSize = 5;
      const chunks = await createChunks(content, maxChunkSize, 1, embedder);

      expect(chunks.length).toBeGreaterThan(2);
      await assertMaxChunkSize(chunks, maxChunkSize);
      assertContentPreserved(chunks, ['word1', 'word12']);
    });

    it('enforces maxChunkSize with Japanese punctuation', async () => {
      const content =
        'これは長い文章です。もう一つの文章もあります。さらに別の文章が続きます。最後の文章を追加します。';

      const maxChunkSize = 15;
      const chunks = await createChunks(content, maxChunkSize, 3, embedder);

      expect(chunks.length).toBeGreaterThan(1);
      await assertMaxChunkSize(chunks, maxChunkSize);
      assertContentPreserved(chunks, [
        'これは長い文章です',
        '最後の文章を追加します',
      ]);
    });
  });

  describe('chunk overlap', () => {
    it('creates overlap between consecutive chunks when overlap > 0', async () => {
      const content = `alpha beta gamma delta
epsilon zeta eta theta
iota kappa lambda mu
nu xi omicron pi rho
sigma tau upsilon phi
chi psi omega final
alpha2 beta2 gamma2 delta2
epsilon2 zeta2 eta2 theta2
iota2 kappa2 lambda2 mu2
nu2 xi2 omicron2 pi2
rho2 sigma2 tau2 upsilon2
phi2 chi2 psi2 omega2
lastword verylast ending conclusion`;

      const maxChunkSize = 20;
      const chunkOverlap = 8;
      const chunks = await createChunks(
        content,
        maxChunkSize,
        chunkOverlap,
        embedder
      );

      expect(chunks.length).toBeGreaterThan(1);
      await assertMaxChunkSize(chunks, maxChunkSize);
      expect(chunks[0].content).toContain('alpha');
      expect(chunks[chunks.length - 1].content).toContain('conclusion');

      const firstWords = chunks[0].content.split(/\s+/).filter(w => w);
      const secondWords = chunks[1].content.split(/\s+/).filter(w => w);
      const overlappingWords = firstWords.filter(word =>
        secondWords.includes(word)
      );
      expect(overlappingWords.length).toBeGreaterThan(0);
    });

    it('creates chunks without overlap when chunkOverlap = 0', async () => {
      const content = `line one here with content
line two here with content
line three here with content
line four here with content
line five here with content`;

      const chunks = await createChunks(content, 8, 0, embedder);

      expect(chunks.length).toBeGreaterThan(1);
      await assertMaxChunkSize(chunks, 8);

      const firstLines = chunks[0].content.split('\n');
      const secondLines = chunks[1].content.split('\n');
      const hasOverlap = firstLines.some(line => secondLines.includes(line));
      expect(hasOverlap).toBe(false);
    });

    it('reduces overlap when overlap + new line would exceed maxChunkSize', async () => {
      const line1 = 'a b';
      const line2 = 'c d';
      const line3 = 'e f';
      const line4 = 'g h i j k l m n';
      const content = `${line1}\n${line2}\n${line3}\n${line4}`;

      const maxChunkSize = 10;
      const chunkOverlap = 4;
      const chunks = await createChunks(
        content,
        maxChunkSize,
        chunkOverlap,
        embedder
      );

      expect(chunks.length).toBe(2);
      await assertMaxChunkSize(chunks, maxChunkSize);

      const firstLines = chunks[0].content.split('\n');
      const secondLines = chunks[1].content.split('\n');
      const overlapLines = secondLines.filter(line =>
        firstLines.includes(line)
      );

      expect(overlapLines.length).toBeGreaterThan(0);

      const actualOverlapTokens = await embedder.countTokens(
        overlapLines.join('\n')
      );
      expect(actualOverlapTokens).toBeLessThan(chunkOverlap);
    });

    it('ensures overlap is contiguous (does not skip lines)', async () => {
      const line1 = 'a b';
      const line2 = 'x '.repeat(20).trim();
      const line3 = 'c d';
      const line4 = 'e f g h i j k';
      const content = `${line1}\n${line2}\n${line3}\n${line4}`;

      const maxChunkSize = 25;
      const chunkOverlap = 5;
      const chunks = await createChunks(
        content,
        maxChunkSize,
        chunkOverlap,
        embedder
      );

      expect(chunks.length).toBeGreaterThan(1);

      const secondChunk = chunks[1];
      expect(secondChunk.content).not.toContain('a b');
    });
  });

  describe('edge cases', () => {
    it('returns empty array for empty content', async () => {
      const chunks = await createChunks('', 50, 10, embedder);
      expect(chunks).toHaveLength(0);
    });

    it('returns empty array for whitespace-only content', async () => {
      const chunks = await createChunks('   \n  \n  ', 50, 10, embedder);
      expect(chunks).toHaveLength(0);
    });

    it('returns empty array for newlines-only content', async () => {
      const chunks = await createChunks('\n\n\n', 50, 10, embedder);
      expect(chunks).toHaveLength(0);
    });

    it('creates single chunk for single character', async () => {
      const chunks = await createChunks('a', 50, 10, embedder);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe('a');
    });

    it('creates single chunk for single word', async () => {
      const chunks = await createChunks('hello', 50, 10, embedder);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe('hello');
    });
  });

  describe('basic behavior', () => {
    it('creates single chunk for short content', async () => {
      const content = 'This is a short text for testing';
      const chunks = await createChunks(content, 50, 10, embedder);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe(content);
    });

    it('preserves line breaks in chunks', async () => {
      const content = `line one
line two`;

      const chunks = await createChunks(content, 50, 10, embedder);

      expect(chunks[0].content).toContain('\n');
    });

    it('splits at various punctuation marks', async () => {
      const content =
        'First question? Answer follows! Statement here. Another one.';

      const chunks = await createChunks(content, 10, 3, embedder);

      expect(chunks.length).toBeGreaterThan(1);
      assertContentPreserved(chunks, ['question', 'Another one']);
    });
  });

  describe('heading tracking', () => {
    it('tracks heading hierarchy in all chunks', async () => {
      const content = `# Main Title
Some content here
## Subsection
More content`;

      const chunks = await createChunks(content, 50, 10, embedder);

      chunks.forEach(chunk => {
        expect(chunk).toHaveProperty('headings');
        expect(Array.isArray(chunk.headings)).toBe(true);
      });

      expect(chunks[0].headings).toContain('Main Title');
    });

    it('maintains correct heading hierarchy across chunk boundaries', async () => {
      const content = `# H1
## H2
### H3
content under H3
## Another H2
content under Another H2`;

      const maxChunkSize = 20;
      const chunks = await createChunks(content, maxChunkSize, 5, embedder);

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].headings).toContain('H1');

      const anotherH2Chunk = chunks.find(c =>
        c.content.includes('content under Another H2')
      );

      expect(anotherH2Chunk).toBeDefined();

      if (anotherH2Chunk) {
        expect(anotherH2Chunk.headings).toContain('H1');
        expect(anotherH2Chunk.headings).toContain('Another H2');
        expect(anotherH2Chunk.headings).not.toContain('H2');
        expect(anotherH2Chunk.headings).not.toContain('H3');
      }
    });

    it('ignores headings deeper than level 3', async () => {
      const content = `# H1
## H2
### H3
#### H4
content under H4`;

      const chunks = await createChunks(content, 50, 10, embedder);

      expect(chunks[0].headings).toContain('H1');
      expect(chunks[0].headings).toContain('H2');
      expect(chunks[0].headings).toContain('H3');
      expect(chunks[0].headings).not.toContain('H4');
    });

    it('handles document with only headings (no content)', async () => {
      const content = `# H1
## H2
### H3`;

      const chunks = await createChunks(content, 50, 10, embedder);

      expect(chunks.length).toBeGreaterThan(0);
      chunks.forEach(chunk => {
        expect(Array.isArray(chunk.headings)).toBe(true);
      });
    });
  });

  describe('content preservation', () => {
    it('preserves all content phrases across chunks', async () => {
      const content = `line one
line two
line three
line four`;

      const chunks = await createChunks(content, 10, 3, embedder);

      assertContentPreserved(chunks, [
        'line one',
        'line two',
        'line three',
        'line four',
      ]);
    });

    it('maintains chunk order', async () => {
      const content = `first line here
second line here
third line here
fourth line here
fifth line here
sixth line here
seventh line here
eighth line here`;

      const chunks = await createChunks(content, 10, 2, embedder);

      expect(chunks.length).toBeGreaterThan(2);
      expect(chunks[0].content).toContain('first');
      expect(chunks[chunks.length - 1].content).toContain('eighth');

      const secondIndex = chunks.findIndex(c => c.content.includes('second'));
      const fifthIndex = chunks.findIndex(c => c.content.includes('fifth'));
      const seventhIndex = chunks.findIndex(c => c.content.includes('seventh'));

      expect(secondIndex).toBeGreaterThan(-1);
      expect(fifthIndex).toBeGreaterThan(-1);
      expect(seventhIndex).toBeGreaterThan(-1);
      expect(secondIndex).toBeLessThanOrEqual(fifthIndex);
      expect(fifthIndex).toBeLessThanOrEqual(seventhIndex);
    });
  });

  describe('extreme cases', () => {
    it('handles very long single word by force subdivision', async () => {
      const longWord = 'https://example.com/' + 'x'.repeat(200);
      const content = `before ${longWord} after`;

      const maxChunkSize = 10;
      const chunks = await createChunks(content, maxChunkSize, 3, embedder);

      expect(chunks.length).toBeGreaterThan(1);
      await assertMaxChunkSize(chunks, maxChunkSize);
      assertContentPreserved(chunks, ['before', 'example', 'after']);
    });

    it('handles multiple consecutive empty lines', async () => {
      const content = `content one


content two`;

      const chunks = await createChunks(content, 50, 10, embedder);

      const combined = chunks.map(c => c.content).join('\n');
      expect(combined).toContain('content one');
      expect(combined).toContain('content two');
    });
  });

  describe('startOffset tracking', () => {
    function assertStartOffset(
      content: string,
      chunk: { content: string; startOffset: number }
    ): void {
      const sliced = content.slice(chunk.startOffset);
      expect(sliced.startsWith(chunk.content)).toBe(true);
    }

    it('returns correct startOffset for single chunk', async () => {
      const content = 'Hello world';
      const chunks = await createChunks(content, 50, 10, embedder);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].startOffset).toBe(0);
      assertStartOffset(content, chunks[0]);
    });

    it('returns correct startOffset with leading whitespace', async () => {
      const content = '   Hello world';
      const chunks = await createChunks(content, 50, 10, embedder);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].startOffset).toBe(3);
      assertStartOffset(content, chunks[0]);
    });

    it('returns correct startOffset for multiple chunks', async () => {
      const content = `line one
line two
line three
line four
line five
line six`;

      const chunks = await createChunks(content, 10, 0, embedder);

      expect(chunks.length).toBeGreaterThan(1);

      for (const chunk of chunks) {
        assertStartOffset(content, chunk);
      }
    });

    it('returns correct startOffset with chunk overlap', async () => {
      const content = `alpha beta gamma
delta epsilon zeta
eta theta iota
kappa lambda mu`;

      const chunks = await createChunks(content, 12, 5, embedder);

      expect(chunks.length).toBeGreaterThan(1);

      for (const chunk of chunks) {
        assertStartOffset(content, chunk);
      }
    });

    it('returns correct startOffset when splitLongLine occurs', async () => {
      const content =
        'First sentence here. Second sentence follows. Third sentence continues. Fourth sentence ends.';

      const maxChunkSize = 10;
      const chunks = await createChunks(content, maxChunkSize, 0, embedder);

      expect(chunks.length).toBeGreaterThan(1);

      for (const chunk of chunks) {
        assertStartOffset(content, chunk);
      }
    });

    it('returns correct startOffset when forceSubdivide occurs', async () => {
      const longWord = 'x'.repeat(200);
      const content = `before ${longWord} after`;

      const maxChunkSize = 10;
      const chunks = await createChunks(content, maxChunkSize, 0, embedder);

      expect(chunks.length).toBeGreaterThan(2);

      for (const chunk of chunks) {
        assertStartOffset(content, chunk);
      }
    });

    it('returns correct startOffset for multiline content with splitLongLine', async () => {
      const content = `Short line here.
This is a very long sentence that needs to be split into multiple parts. It continues and continues.
Another short line.`;

      const maxChunkSize = 15;
      const chunks = await createChunks(content, maxChunkSize, 3, embedder);

      expect(chunks.length).toBeGreaterThan(1);

      for (const chunk of chunks) {
        assertStartOffset(content, chunk);
      }
    });
  });
});
