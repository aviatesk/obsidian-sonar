import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
  setupTestEmbedders,
  cleanupTestEmbedders,
  type TestEmbedderSetupInfo,
} from './test-helpers/embedder-setup';

let embedders: TestEmbedderSetupInfo[] = [];

beforeAll(async () => {
  embedders = await setupTestEmbedders();
}, 60000);

afterAll(async () => {
  await cleanupTestEmbedders();
});

describe('embedder backends', () => {
  it('are LlamaCpp and Transformers.js', () => {
    expect(embedders).toHaveLength(2);
    expect(embedders[0].name).toBe('llama.cpp');
    expect(embedders[1].name).toBe('Transformers.js');
  });

  it('can count tokens', async () => {
    for (const embedderInfo of embedders) {
      const embedder = embedderInfo.embedder;
      const tokens = await embedder.countTokens('hello world');
      expect(tokens).toBeGreaterThan(0);
      expect(Number.isInteger(tokens)).toBe(true);
    }
  });

  it('can get token IDs', async () => {
    for (const embedderInfo of embedders) {
      const embedder = embedderInfo.embedder;
      const tokenIds = await embedder.getTokenIds('hello world');
      expect(Array.isArray(tokenIds)).toBe(true);
      expect(tokenIds.length).toBeGreaterThan(0);
      expect(tokenIds.every(id => Number.isInteger(id))).toBe(true);
    }
  });

  it('can handle big texts', async () => {
    for (const embedderInfo of embedders) {
      const embedder = embedderInfo.embedder;
      const tokens = await embedder.countTokens('hello world\n'.repeat(10000));
      expect(tokens).toBeGreaterThan(0);
      expect(Number.isInteger(tokens)).toBe(true);

      const tokenIds = await embedder.getTokenIds(
        'hello world\n'.repeat(10000)
      );
      expect(Array.isArray(tokenIds)).toBe(true);
      expect(tokenIds.length).toBeGreaterThan(0);
      expect(tokenIds.every(id => Number.isInteger(id))).toBe(true);
    }
  }, 30000);

  it('can generate embeddings', async () => {
    for (const embedderInfo of embedders) {
      const embedder = embedderInfo.embedder;
      const embeddings = await embedder.getEmbeddings(['hello world']);
      expect(embeddings.length).toBe(1);
      expect(embeddings[0].length).toBeGreaterThan(1);
    }
  });

  it('can generate batch embeddings', async () => {
    for (const embedderInfo of embedders) {
      const embedder = embedderInfo.embedder;
      const embeddings = await embedder.getEmbeddings([
        'I love',
        'Julia programming language',
      ]);
      expect(embeddings.length).toBe(2);
      embeddings.forEach(emb => expect(emb.length).toBeGreaterThan(1));
    }
  });
});
