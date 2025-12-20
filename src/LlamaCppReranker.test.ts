import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LlamaCppReranker } from './LlamaCppReranker';
import { DEFAULT_SETTINGS } from './config';
import { createMockConfigManager } from './test-helpers/mock-config-manager';

let reranker: LlamaCppReranker | null = null;

beforeAll(async () => {
  const serverPath = DEFAULT_SETTINGS.llamacppServerPath;
  const modelRepo = DEFAULT_SETTINGS.llamaRerankerModelRepo;
  const modelFile = DEFAULT_SETTINGS.llamaRerankerModelFile;
  const configManager = createMockConfigManager();

  reranker = new LlamaCppReranker(
    serverPath,
    modelRepo,
    modelFile,
    configManager
  );

  console.log(`Initializing reranker: ${modelRepo}/${modelFile}...`);
  await reranker.initialize();
  console.log('Reranker is ready');
}, 180000);

afterAll(async () => {
  if (reranker) {
    console.log('Cleaning up reranker...');
    await reranker.cleanup();
    reranker = null;
  }
});

describe('LlamaCppReranker', () => {
  it('can rerank documents', async () => {
    const query = 'What is machine learning?';
    const documents = [
      'The weather is nice today.',
      'Machine learning is a subset of artificial intelligence.',
      'I like to eat pizza.',
    ];

    const results = await reranker!.rerank(query, documents);

    expect(results).toHaveLength(3);
    expect(results[0].index).toBe(1); // ML doc should be ranked first
    expect(results[0].relevanceScore).toBeGreaterThan(
      results[1].relevanceScore
    );
    expect(results[0].relevanceScore).toBeGreaterThan(
      results[2].relevanceScore
    );
  });

  it('can limit results with topN', async () => {
    const query = 'programming languages';
    const documents = [
      'Python is a popular programming language.',
      'The sky is blue.',
      'JavaScript is used for web development.',
      'Cats are cute animals.',
    ];

    const results = await reranker!.rerank(query, documents, 2);

    expect(results).toHaveLength(2);
    // Top 2 should be programming-related documents
    const topIndices = results.map(r => r.index);
    expect(topIndices).toContain(0); // Python doc
    expect(topIndices).toContain(2); // JavaScript doc
  });

  it('returns results sorted by relevance score', async () => {
    const query = 'capital cities';
    const documents = [
      'Tokyo is the capital of Japan.',
      'I enjoy reading books.',
      'Paris is the capital of France.',
      'The ocean is vast.',
    ];

    const results = await reranker!.rerank(query, documents);

    // Verify results are sorted by relevance score (descending)
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].relevanceScore).toBeGreaterThanOrEqual(
        results[i].relevanceScore
      );
    }
  });

  it('handles single document', async () => {
    const query = 'test query';
    const documents = ['Single document for testing.'];

    const results = await reranker!.rerank(query, documents);

    expect(results).toHaveLength(1);
    expect(results[0].index).toBe(0);
    expect(typeof results[0].relevanceScore).toBe('number');
  });
});
