import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

describe('LlamaCppEmbedder', () => {
  it('can count tokens', async () => {
    const tokens = await embedder.countTokens('hello world');
    expect(tokens).toBeGreaterThan(0);
    expect(Number.isInteger(tokens)).toBe(true);
  });

  it('can get token IDs', async () => {
    const tokenIds = await embedder.getTokenIds('hello world');
    expect(Array.isArray(tokenIds)).toBe(true);
    expect(tokenIds.length).toBeGreaterThan(0);
    expect(tokenIds.every(id => Number.isInteger(id))).toBe(true);
  });

  it('can decode token IDs back to strings', async () => {
    const text = 'hello world';
    const tokenIds = await embedder.getTokenIds(text);
    const decoded = await embedder.decodeTokenIds(tokenIds);

    expect(Array.isArray(decoded)).toBe(true);
    expect(decoded.length).toBe(tokenIds.length);
    expect(decoded.every(s => typeof s === 'string')).toBe(true);

    const joined = decoded.join('').replace(/\s+/g, ' ').trim();
    expect(joined.toLowerCase()).toContain('hello');
    expect(joined.toLowerCase()).toContain('world');
  });

  it('can handle big texts', async () => {
    const tokens = await embedder.countTokens('hello world\n'.repeat(10000));
    expect(tokens).toBeGreaterThan(0);
    expect(Number.isInteger(tokens)).toBe(true);

    const tokenIds = await embedder.getTokenIds('hello world\n'.repeat(10000));
    expect(Array.isArray(tokenIds)).toBe(true);
    expect(tokenIds.length).toBeGreaterThan(0);
    expect(tokenIds.every(id => Number.isInteger(id))).toBe(true);
  }, 30000);

  it('can generate embeddings', async () => {
    const embeddings = await embedder.getEmbeddings(['hello world']);
    expect(embeddings.length).toBe(1);
    expect(embeddings[0].length).toBeGreaterThan(1);
  });

  it('can generate batch embeddings', async () => {
    const embeddings = await embedder.getEmbeddings([
      'I love',
      'Julia programming language',
    ]);
    expect(embeddings.length).toBe(2);
    embeddings.forEach(emb => expect(emb.length).toBeGreaterThan(1));
  });
});
