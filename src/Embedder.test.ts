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

afterAll(() => {
  cleanupTestEmbedders();
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
});
