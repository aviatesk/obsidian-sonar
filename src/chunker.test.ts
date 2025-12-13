import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createChunks } from './chunker';
import {
  setupTestEmbedders,
  cleanupTestEmbedders,
  type TestEmbedderSetupInfo,
  type TestEmbedder,
} from './test-helpers/embedder-setup';

const EMBEDDER_NAMES = ['llama.cpp', 'Transformers.js'] as const;

let embedderInfos: TestEmbedderSetupInfo[] = [];

beforeAll(async () => {
  embedderInfos = await setupTestEmbedders();
}, 60000);

afterAll(async () => {
  await cleanupTestEmbedders();
});

/**
 * Helper: Assert all chunks respect maxChunkSize constraint
 */
async function assertMaxChunkSize(
  chunks: Array<{ content: string }>,
  maxChunkSize: number,
  embedder: TestEmbedder
): Promise<void> {
  for (let i = 0; i < chunks.length; i++) {
    const tokens = await embedder.countTokens(chunks[i].content);
    expect(tokens).toBeLessThanOrEqual(maxChunkSize);
  }
}

/**
 * Helper: Assert content is preserved across chunks
 */
function assertContentPreserved(
  chunks: Array<{ content: string }>,
  expectedPhrases: string[]
): void {
  const combined = chunks.map(c => c.content).join(' ');
  for (const phrase of expectedPhrases) {
    expect(combined).toContain(phrase);
  }
}

for (const name of EMBEDDER_NAMES) {
  describe(`[backend: ${name}]`, () => {
    const getEmbedder = (): TestEmbedder =>
      embedderInfos.find(info => info.name === name)!.embedder;

    describe('createChunks', () => {
      describe('maxChunkSize constraints', () => {
        it('splits long content into multiple chunks', async () => {
          const embedder = getEmbedder();

          const content = `This is a very long sentence with many words that should be split into multiple chunks. \
This is another sentence with more words to ensure proper splitting behavior works as expected. \
Additional content to make this even longer and force more chunking behavior to occur.`;

          const maxChunkSize = 30;
          const chunks = await createChunks(
            content,
            maxChunkSize,
            10,
            embedder
          );

          expect(chunks.length).toBeGreaterThan(1);
          await assertMaxChunkSize(chunks, maxChunkSize, embedder);
        });

        it('enforces maxChunkSize when splitting by sentence boundaries', async () => {
          const embedder = getEmbedder();

          const content = `First sentence here with some additional words to make it longer. \
Second sentence follows with even more words to ensure proper length. \
Third sentence comes next and continues the pattern of longer text. \
Fourth sentence adds more content. \
Fifth and final sentence completes the test.`;

          const maxChunkSize = 15;
          const chunks = await createChunks(content, maxChunkSize, 3, embedder);

          expect(chunks.length).toBeGreaterThan(1);
          await assertMaxChunkSize(chunks, maxChunkSize, embedder);
          assertContentPreserved(chunks, ['First sentence', 'final sentence']);
        });

        it('enforces maxChunkSize when splitting by word boundaries', async () => {
          const embedder = getEmbedder();

          const content =
            'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12';

          const maxChunkSize = 5;
          const chunks = await createChunks(content, maxChunkSize, 1, embedder);

          expect(chunks.length).toBeGreaterThan(2);
          await assertMaxChunkSize(chunks, maxChunkSize, embedder);
          assertContentPreserved(chunks, ['word1', 'word12']);
        });

        it('enforces maxChunkSize with Japanese punctuation', async () => {
          const embedder = getEmbedder();

          const content =
            'これは長い文章です。もう一つの文章もあります。さらに別の文章が続きます。最後の文章を追加します。';

          const maxChunkSize = 15;
          const chunks = await createChunks(content, maxChunkSize, 3, embedder);

          expect(chunks.length).toBeGreaterThan(1);
          await assertMaxChunkSize(chunks, maxChunkSize, embedder);
          assertContentPreserved(chunks, [
            'これは長い文章です',
            '最後の文章を追加します',
          ]);
        });
      });

      describe('chunk overlap', () => {
        it('creates overlap between consecutive chunks when overlap > 0', async () => {
          const embedder = getEmbedder();

          // Longer content to ensure multiple chunks across different tokenizers
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
          await assertMaxChunkSize(chunks, maxChunkSize, embedder);
          expect(chunks[0].content).toContain('alpha');
          expect(chunks[chunks.length - 1].content).toContain('conclusion');

          // Verify overlap between first two chunks
          const firstWords = chunks[0].content.split(/\s+/).filter(w => w);
          const secondWords = chunks[1].content.split(/\s+/).filter(w => w);
          const overlappingWords = firstWords.filter(word =>
            secondWords.includes(word)
          );
          expect(overlappingWords.length).toBeGreaterThan(0);
        });

        it('creates chunks without overlap when chunkOverlap = 0', async () => {
          const embedder = getEmbedder();

          // Longer content to ensure multiple chunks
          const content = `line one here with content
line two here with content
line three here with content
line four here with content
line five here with content`;

          const chunks = await createChunks(content, 8, 0, embedder);

          expect(chunks.length).toBeGreaterThan(1);
          await assertMaxChunkSize(chunks, 8, embedder);

          // With no overlap, consecutive chunks should not share content
          const firstLines = chunks[0].content.split('\n');
          const secondLines = chunks[1].content.split('\n');
          const hasOverlap = firstLines.some(line =>
            secondLines.includes(line)
          );
          expect(hasOverlap).toBe(false);
        });

        it('reduces overlap when overlap + new line would exceed maxChunkSize', async () => {
          const embedder = getEmbedder();

          // Multiple short lines followed by a longer line
          // This forces overlap reduction to keep maxChunkSize constraint
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

          await assertMaxChunkSize(chunks, maxChunkSize, embedder);

          // Verify overlap reduction occurred
          // Find overlapping content between first and second chunk
          const firstLines = chunks[0].content.split('\n');
          const secondLines = chunks[1].content.split('\n');
          const overlapLines = secondLines.filter(line =>
            firstLines.includes(line)
          );

          expect(overlapLines.length).toBeGreaterThan(0);

          // Calculate actual overlap tokens
          const actualOverlapTokens = await embedder.countTokens(
            overlapLines.join('\n')
          );

          // Actual overlap should be less than requested chunkOverlap
          // because overlap was reduced to fit maxChunkSize
          expect(actualOverlapTokens).toBeLessThan(chunkOverlap);
        });

        it('ensures overlap is contiguous (does not skip lines)', async () => {
          const embedder = getEmbedder();

          // Pattern: [small, big, small] lines
          // If overlap selection skipped non-fitting lines, it would select
          // line1 and line3 (non-contiguous). Correct behavior: only line3.
          const line1 = 'a b'; // ~2 tokens
          const line2 = 'x '.repeat(20).trim(); // ~20 tokens (large)
          const line3 = 'c d'; // ~2 tokens
          const line4 = 'e f g h i j k'; // triggers chunk split
          const content = `${line1}\n${line2}\n${line3}\n${line4}`;

          const maxChunkSize = 25;
          const chunkOverlap = 5; // line1 + line3 would fit, but line2 is between
          const chunks = await createChunks(
            content,
            maxChunkSize,
            chunkOverlap,
            embedder
          );

          expect(chunks.length).toBeGreaterThan(1);

          // Second chunk should NOT contain line1 (would indicate non-contiguous overlap)
          const secondChunk = chunks[1];
          expect(secondChunk.content).not.toContain('a b');

          // // Verify startOffset is correct (contiguous overlap ensures this works)
          // const sliced = content.slice(secondChunk.startOffset);
          // expect(sliced.startsWith(secondChunk.content)).toBe(true);
        });
      });

      describe('edge cases', () => {
        it('returns empty array for empty content', async () => {
          const embedder = getEmbedder();
          const chunks = await createChunks('', 50, 10, embedder);
          expect(chunks).toHaveLength(0);
        });

        it('returns empty array for whitespace-only content', async () => {
          const embedder = getEmbedder();
          const chunks = await createChunks('   \n  \n  ', 50, 10, embedder);
          expect(chunks).toHaveLength(0);
        });

        it('returns empty array for newlines-only content', async () => {
          const embedder = getEmbedder();
          const chunks = await createChunks('\n\n\n', 50, 10, embedder);
          expect(chunks).toHaveLength(0);
        });

        it('creates single chunk for single character', async () => {
          const embedder = getEmbedder();
          const chunks = await createChunks('a', 50, 10, embedder);
          expect(chunks).toHaveLength(1);
          expect(chunks[0].content).toBe('a');
        });

        it('creates single chunk for single word', async () => {
          const embedder = getEmbedder();
          const chunks = await createChunks('hello', 50, 10, embedder);
          expect(chunks).toHaveLength(1);
          expect(chunks[0].content).toBe('hello');
        });
      });

      describe('basic behavior', () => {
        it('creates single chunk for short content', async () => {
          const embedder = getEmbedder();
          const content = 'This is a short text for testing';
          const chunks = await createChunks(content, 50, 10, embedder);

          expect(chunks).toHaveLength(1);
          expect(chunks[0].content).toBe(content);
        });

        it('preserves line breaks in chunks', async () => {
          const embedder = getEmbedder();
          const content = `line one
line two`;

          const chunks = await createChunks(content, 50, 10, embedder);

          expect(chunks[0].content).toContain('\n');
        });

        it('splits at various punctuation marks', async () => {
          const embedder = getEmbedder();
          const content =
            'First question? Answer follows! Statement here. Another one.';

          const chunks = await createChunks(content, 10, 3, embedder);

          expect(chunks.length).toBeGreaterThan(1);
          assertContentPreserved(chunks, ['question', 'Another one']);
        });
      });

      describe('heading tracking', () => {
        it('tracks heading hierarchy in all chunks', async () => {
          const embedder = getEmbedder();
          const content = `# Main Title
Some content here
## Subsection
More content`;

          const chunks = await createChunks(content, 50, 10, embedder);

          // All chunks must have headings array
          chunks.forEach(chunk => {
            expect(chunk).toHaveProperty('headings');
            expect(Array.isArray(chunk.headings)).toBe(true);
          });

          // First chunk should contain the main title in headings
          expect(chunks[0].headings).toContain('Main Title');
        });

        it('maintains correct heading hierarchy across chunk boundaries', async () => {
          const embedder = getEmbedder();
          const content = `# H1
## H2
### H3
content under H3
## Another H2
content under Another H2`;

          const maxChunkSize = 20;
          const chunks = await createChunks(content, maxChunkSize, 5, embedder);

          expect(chunks.length).toBeGreaterThan(1);

          // First chunk should have H1 in headings
          expect(chunks[0].headings).toContain('H1');

          // Find chunk containing "content under Another H2"
          const anotherH2Chunk = chunks.find(c =>
            c.content.includes('content under Another H2')
          );

          // This chunk MUST exist, otherwise the test data is wrong
          expect(anotherH2Chunk).toBeDefined();

          if (anotherH2Chunk) {
            // Should have H1 and "Another H2" in hierarchy
            expect(anotherH2Chunk.headings).toContain('H1');
            expect(anotherH2Chunk.headings).toContain('Another H2');

            // Should NOT have the old H2/H3 from earlier in the document
            expect(anotherH2Chunk.headings).not.toContain('H2');
            expect(anotherH2Chunk.headings).not.toContain('H3');
          }
        });

        it('ignores headings deeper than level 3', async () => {
          const embedder = getEmbedder();
          const content = `# H1
## H2
### H3
#### H4
content under H4`;

          const chunks = await createChunks(content, 50, 10, embedder);

          // Should track H1, H2, H3 but not H4
          expect(chunks[0].headings).toContain('H1');
          expect(chunks[0].headings).toContain('H2');
          expect(chunks[0].headings).toContain('H3');
          expect(chunks[0].headings).not.toContain('H4');
        });

        it('handles document with only headings (no content)', async () => {
          const embedder = getEmbedder();
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
          const embedder = getEmbedder();
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
          const embedder = getEmbedder();
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

          // First chunk should contain "first"
          expect(chunks[0].content).toContain('first');

          // Last chunk should contain "eighth"
          expect(chunks[chunks.length - 1].content).toContain('eighth');

          // Verify order: find indices of lines in chunks
          const secondIndex = chunks.findIndex(c =>
            c.content.includes('second')
          );
          const fifthIndex = chunks.findIndex(c => c.content.includes('fifth'));
          const seventhIndex = chunks.findIndex(c =>
            c.content.includes('seventh')
          );

          expect(secondIndex).toBeGreaterThan(-1);
          expect(fifthIndex).toBeGreaterThan(-1);
          expect(seventhIndex).toBeGreaterThan(-1);

          // Second should come before or at same position as fifth (due to overlap)
          expect(secondIndex).toBeLessThanOrEqual(fifthIndex);
          // Fifth should come before seventh
          expect(fifthIndex).toBeLessThanOrEqual(seventhIndex);
        });
      });

      describe('extreme cases', () => {
        it('handles very long single word by force subdivision', async () => {
          const embedder = getEmbedder();
          const longWord = 'https://example.com/' + 'x'.repeat(200);
          const content = `before ${longWord} after`;

          const maxChunkSize = 10;
          const chunks = await createChunks(content, maxChunkSize, 3, embedder);

          expect(chunks.length).toBeGreaterThan(1);
          await assertMaxChunkSize(chunks, maxChunkSize, embedder);
          // Long word is force-subdivided, so original string may not be preserved
          // Check that beginning and end are present
          assertContentPreserved(chunks, ['before', 'example', 'after']);
        });

        it('handles multiple consecutive empty lines', async () => {
          const embedder = getEmbedder();
          const content = `content one


content two`;

          const chunks = await createChunks(content, 50, 10, embedder);

          // Should preserve content despite empty lines
          const combined = chunks.map(c => c.content).join('\n');
          expect(combined).toContain('content one');
          expect(combined).toContain('content two');
        });
      });

      describe('startOffset tracking', () => {
        /**
         * Helper: Assert chunk content starts at its startOffset in original content
         */
        function assertStartOffset(
          content: string,
          chunk: { content: string; startOffset: number }
        ): void {
          const sliced = content.slice(chunk.startOffset);
          expect(sliced.startsWith(chunk.content)).toBe(true);
        }

        it('returns correct startOffset for single chunk', async () => {
          const embedder = getEmbedder();
          const content = 'Hello world';
          const chunks = await createChunks(content, 50, 10, embedder);

          expect(chunks).toHaveLength(1);
          expect(chunks[0].startOffset).toBe(0);
          assertStartOffset(content, chunks[0]);
        });

        it('returns correct startOffset with leading whitespace', async () => {
          const embedder = getEmbedder();
          const content = '   Hello world';
          const chunks = await createChunks(content, 50, 10, embedder);

          expect(chunks).toHaveLength(1);
          expect(chunks[0].startOffset).toBe(3); // After leading spaces
          assertStartOffset(content, chunks[0]);
        });

        it('returns correct startOffset for multiple chunks', async () => {
          const embedder = getEmbedder();
          const content = `line one
line two
line three
line four
line five
line six`;

          const chunks = await createChunks(content, 10, 0, embedder);

          expect(chunks.length).toBeGreaterThan(1);

          // Each chunk's content should be found at its startOffset
          for (const chunk of chunks) {
            assertStartOffset(content, chunk);
          }
        });

        it('returns correct startOffset with chunk overlap', async () => {
          const embedder = getEmbedder();
          const content = `alpha beta gamma
delta epsilon zeta
eta theta iota
kappa lambda mu`;

          const chunks = await createChunks(content, 12, 5, embedder);

          expect(chunks.length).toBeGreaterThan(1);

          // Each chunk's content should be found at its startOffset
          for (const chunk of chunks) {
            assertStartOffset(content, chunk);
          }
        });

        it('returns correct startOffset when splitLongLine occurs', async () => {
          const embedder = getEmbedder();
          // Long sentence that will be split by sentence boundaries
          const content =
            'First sentence here. Second sentence follows. Third sentence continues. Fourth sentence ends.';

          const maxChunkSize = 10;
          const chunks = await createChunks(content, maxChunkSize, 0, embedder);

          expect(chunks.length).toBeGreaterThan(1);

          // Each chunk's content should be found at its startOffset
          for (const chunk of chunks) {
            assertStartOffset(content, chunk);
          }
        });

        it('returns correct startOffset when forceSubdivide occurs', async () => {
          const embedder = getEmbedder();
          // Very long word that will trigger force subdivision
          const longWord = 'x'.repeat(200);
          const content = `before ${longWord} after`;

          const maxChunkSize = 10;
          const chunks = await createChunks(content, maxChunkSize, 0, embedder);

          expect(chunks.length).toBeGreaterThan(2);

          // Each chunk's content should be found at its startOffset
          for (const chunk of chunks) {
            assertStartOffset(content, chunk);
          }
        });

        it('returns correct startOffset for multiline content with splitLongLine', async () => {
          const embedder = getEmbedder();
          const content = `Short line here.
This is a very long sentence that needs to be split into multiple parts. It continues and continues.
Another short line.`;

          const maxChunkSize = 15;
          const chunks = await createChunks(content, maxChunkSize, 3, embedder);

          expect(chunks.length).toBeGreaterThan(1);

          // Each chunk's content should be found at its startOffset
          for (const chunk of chunks) {
            assertStartOffset(content, chunk);
          }
        });
      });
    });
  });
}
