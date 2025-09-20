#!/usr/bin/env npx tsx

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import ora from 'ora';
import { OllamaClient } from '../src/core/ollama-client';
import { SonarTokenizer } from '../src/core/tokenizer';
import { DEFAULT_CLI_CONFIG, CLIConfig } from '../src/core/config';
import { loadConfig } from './fs-utils';

interface TestResult {
  model: string;
  filePath: string;
  originalFileSize: number;
  originalCharCount: number;
  originalTokens: number;
  actualFileSize: number;
  actualCharCount: number;
  actualTokens: number;
  truncated: boolean;
  responseTime: number;
  responseLength: number;
  extractionQuery: string;
}

async function testExtractionQuery(
  filePath: string,
  model: string,
  ollamaUrl: string,
  maxInputTokens?: number,
  tokenizerModel?: string,
  embeddingModel?: string
): Promise<TestResult> {
  const client = new OllamaClient({ ollamaUrl, model });

  // Read file content
  const fullPath = resolve(filePath);
  const originalContent = readFileSync(fullPath, 'utf-8');

  // Store original file stats
  const originalFileSize = Buffer.byteLength(originalContent, 'utf-8');
  const originalCharCount = originalContent.length;
  const originalTokens = await SonarTokenizer.estimateTokens(
    originalContent,
    embeddingModel,
    tokenizerModel
  );

  let content = originalContent;
  let truncated = false;

  // Truncate content if maxInputTokens is specified
  if (maxInputTokens && maxInputTokens > 0 && originalTokens > maxInputTokens) {
    // Binary search to find the right substring length
    let low = 0;
    let high = content.length;
    let bestLength = 0;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const substring = content.substring(0, mid);
      const tokens = await SonarTokenizer.estimateTokens(
        substring,
        embeddingModel,
        tokenizerModel
      );

      if (tokens <= maxInputTokens) {
        bestLength = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    content = content.substring(0, bestLength);
    truncated = true;
  }

  const actualFileSize = Buffer.byteLength(content, 'utf-8');
  const actualCharCount = content.length;
  const actualTokens = await SonarTokenizer.estimateTokens(
    content,
    embeddingModel,
    tokenizerModel
  );

  // Create extraction query prompt for RAG search
  const prompt = `Extract a search query from the following text for finding related documents in a RAG system.
Requirements:
1. Write in the same language as the input text (do not translate)
2. Start with ONE concise sentence summarizing the main topic or question (max 50 tokens)
3. Follow with relevant keywords, concepts, and entities separated by commas
4. Total output should be approximately 128 tokens
5. Focus on searchable terms that would help find similar or related documents

Text to analyze follows:
========================

${content}`;

  console.log(`📄 File: ${filePath}`);
  console.log(`📏 Size: ${(originalFileSize / 1024).toFixed(2)} KB`);
  console.log(`📝 Characters: ${originalCharCount.toLocaleString()}`);
  console.log(
    `🔢 Tokens: ${originalTokens.toLocaleString()}${truncated ? ` (truncated to ${actualTokens})` : ''}`
  );
  console.log(`🤖 Model: ${model}`);

  // Measure latency
  const spinner = ora('Processing...').start();
  const startTime = performance.now();
  let extractionQuery: string;

  try {
    extractionQuery = await client.generate(prompt);
  } catch (error) {
    spinner.fail('Failed to generate extraction query');
    throw error;
  }

  const endTime = performance.now();
  const responseTime = endTime - startTime;
  spinner.succeed(`Completed in ${(responseTime / 1000).toFixed(2)} seconds`);

  return {
    model,
    filePath,
    originalFileSize,
    originalCharCount,
    originalTokens,
    actualFileSize,
    actualCharCount,
    actualTokens,
    truncated,
    responseTime,
    responseLength: extractionQuery.length,
    extractionQuery,
  };
}

async function runTest(filePath: string, options: any) {
  const config: CLIConfig = await loadConfig(DEFAULT_CLI_CONFIG);
  const model = options.summaryModel || config.summaryModel;
  const ollamaUrl = options.url || config.ollamaUrl;
  const maxInputTokens = options.tokens ? parseInt(options.tokens) : undefined;
  const tokenizerModel = options.tokenizerModel || config.tokenizerModel;
  const embeddingModel = config.embeddingModel;

  console.log('\n🚀 Starting Extraction Query Latency Test\n');
  console.log('='.repeat(60));

  try {
    const result = await testExtractionQuery(
      filePath,
      model,
      ollamaUrl,
      maxInputTokens,
      tokenizerModel,
      embeddingModel
    );

    console.log('\n' + '='.repeat(60));
    console.log('\n📊 Performance Metrics:\n');
    console.log(
      `⏱️  Response Time: ${(result.responseTime / 1000).toFixed(2)} seconds`
    );
    console.log(
      `📏 Input Size: ${(result.actualFileSize / 1024).toFixed(2)} KB (${result.actualCharCount.toLocaleString()} chars, ${result.actualTokens.toLocaleString()} tokens)`
    );
    console.log(`📝 Output Length: ${result.responseLength} characters`);
    console.log(`⚡ Processing Speed:`);
    console.log(
      `   • ${(result.actualCharCount / (result.responseTime / 1000)).toFixed(0)} chars/sec`
    );
    console.log(
      `   • ${(result.actualFileSize / result.responseTime).toFixed(2)} KB/sec`
    );
    console.log(
      `   • ${Math.round(result.actualTokens / (result.responseTime / 1000))} tokens/sec`
    );

    console.log('\n🔍 Extraction Query:');
    console.log('-'.repeat(40));
    console.log(result.extractionQuery);
    console.log('-'.repeat(40));
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

async function runBenchmark(filePath: string, options: any) {
  const iterations = parseInt(options.iterations || '3');
  const config: CLIConfig = await loadConfig(DEFAULT_CLI_CONFIG);
  const model = options.summaryModel || config.summaryModel;
  const ollamaUrl = options.url || config.ollamaUrl;
  const maxInputTokens = options.tokens ? parseInt(options.tokens) : undefined;
  const tokenizerModel = options.tokenizerModel || config.tokenizerModel;
  const embeddingModel = config.embeddingModel;

  console.log(`\n🔄 Running ${iterations} iterations for benchmarking...\n`);

  const results: number[] = [];

  for (let i = 0; i < iterations; i++) {
    console.log(`\n--- Iteration ${i + 1}/${iterations} ---`);
    try {
      const result = await testExtractionQuery(
        filePath,
        model,
        ollamaUrl,
        maxInputTokens,
        tokenizerModel,
        embeddingModel
      );
      results.push(result.responseTime);
      console.log(
        `✅ Completed in ${(result.responseTime / 1000).toFixed(2)}s`
      );
    } catch (error) {
      console.error(`❌ Iteration ${i + 1} failed:`, error);
    }
  }

  if (results.length === 0) {
    console.error('❌ All iterations failed');
    process.exit(1);
  }

  // Calculate statistics
  const avg = results.reduce((a, b) => a + b, 0) / results.length;
  const min = Math.min(...results);
  const max = Math.max(...results);
  const variance =
    results.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) /
    results.length;
  const stdDev = Math.sqrt(variance);

  console.log('\n' + '='.repeat(60));
  console.log('\n📊 Benchmark Statistics:\n');
  console.log(`• Successful runs: ${results.length}/${iterations}`);
  console.log(`• Average: ${(avg / 1000).toFixed(3)}s`);
  console.log(`• Min: ${(min / 1000).toFixed(3)}s`);
  console.log(`• Max: ${(max / 1000).toFixed(3)}s`);
  console.log(`• Std Dev: ${(stdDev / 1000).toFixed(3)}s`);
  console.log(`• Range: ${((max - min) / 1000).toFixed(3)}s`);
}

const program = new Command();

program
  .name('extraction-latency')
  .description('Test Ollama model latency for RAG extraction query generation')
  .version('1.0.0');

program
  .command('test <file>')
  .description('Test extraction query generation latency for a single file')
  .option(
    '-s, --summary-model <model>',
    `Ollama summary model to use (default: from config)`
  )
  .option('-u, --url <url>', `Ollama server URL (default: from config)`)
  .option('-t, --tokens <n>', 'Maximum input tokens to send to the model')
  .option(
    '--tokenizer-model <model>',
    'Specific tokenizer model to use (default: auto-detect from model)'
  )
  .action(runTest);

program
  .command('benchmark <file>')
  .description('Run multiple iterations and calculate statistics')
  .option('-i, --iterations <n>', 'Number of iterations (default: 3)', '3')
  .option(
    '-s, --summary-model <model>',
    `Ollama summary model to use (default: from config)`
  )
  .option('-u, --url <url>', `Ollama server URL (default: from config)`)
  .option('-t, --tokens <n>', 'Maximum input tokens to send to the model')
  .option(
    '--tokenizer-model <model>',
    'Specific tokenizer model to use (default: auto-detect from model)'
  )
  .action(runBenchmark);

// Show help if no arguments
if (process.argv.length === 2) {
  program.help();
}

program.parse();

export type { TestResult };
export { testExtractionQuery };
