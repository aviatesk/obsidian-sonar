#!/usr/bin/env node

import { Command } from 'commander';
import ora from 'ora';
import os from 'os';
import path from 'path';
import {
  getMarkdownFiles,
  loadIndex,
  saveIndex,
  loadConfig,
  saveConfig,
} from './fs-utils';
import { processSequential } from './index-sequential';
import { processParallel } from './index-parallel';
import { cosineSimilarity } from '../src/core/chunking';
import { OllamaUtils } from './ollama-utils';
import { DEFAULT_CLI_CONFIG, CLIConfig } from '../src/core/config';

// Expand tilde (~) to home directory
function expandTilde(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

async function indexCommand(targetPath?: string, options?: any) {
  const config: CLIConfig = await loadConfig(DEFAULT_CLI_CONFIG);
  if (options?.model) config.embeddingModel = options.model;
  if (options?.tokenizerModel) config.tokenizerModel = options.tokenizerModel;
  if (options?.db) config.dbPath = options.db;
  if (options?.chunkSize) config.maxChunkSize = parseInt(options.chunkSize);
  if (options?.parallel) config.parallelServers = parseInt(options.parallel);

  const rawIndexPath = targetPath || config.indexPath;
  const indexPath = expandTilde(rawIndexPath);
  config.dbPath = expandTilde(config.dbPath);

  console.log('🔍 Indexing Documents for Semantic Search\n');
  console.log(`📁 Path: ${indexPath}`);
  console.log(`🤖 Model: ${config.embeddingModel}`);
  if (config.tokenizerModel) {
    console.log(`🔤 Tokenizer: ${config.tokenizerModel}`);
  }
  console.log(`💾 Database: ${config.dbPath}\n`);

  try {
    const response = await fetch(`${config.ollamaUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: config.embeddingModel }),
    });

    if (!response.ok) {
      console.error(`❌ Model ${config.embeddingModel} is not available.`);
      console.error(
        `   Please make sure Ollama is running and the model is installed.`
      );
      console.error(
        `   Run: ollama pull ${config.embeddingModel.split(':')[0]}`
      );
      process.exit(1);
    }
  } catch {
    console.error(`❌ Failed to connect to Ollama at ${config.ollamaUrl}`);
    console.error(`   Please make sure Ollama is running with: ollama serve`);
    process.exit(1);
  }

  const files = await getMarkdownFiles(indexPath);
  console.log(`📄 Found ${files.length} markdown files\n`);

  if (files.length === 0) {
    console.log('No markdown files found in the specified path.');
    return;
  }

  const spinner = ora({
    text: 'Starting indexing...',
    spinner: 'dots',
    color: 'blue',
  }).start();

  const startTime = Date.now();
  const documents: any[] = [];
  let totalChunks = 0;

  // ollama-utils instance
  const ollamaUtils = new OllamaUtils({
    ollamaUrl: config.ollamaUrl,
    embeddingModel: config.embeddingModel,
    parallelServers: config.parallelServers || 1,
    parallelPort: config.parallelPort || 11435,
  });

  try {
    let result;
    if (config.parallelServers && config.parallelServers > 1) {
      spinner.text = 'Starting parallel Ollama servers...';
      await ollamaUtils.initialize();
      spinner.text = 'Parallel indexing started...';
      result = await processParallel(
        files,
        config,
        ollamaUtils,
        totalChunks,
        startTime,
        spinner
      );
    } else {
      spinner.text = 'Sequential indexing started...';
      result = await processSequential(
        files,
        config,
        ollamaUtils,
        startTime,
        spinner
      );
    }

    documents.push(...result.documents);
    totalChunks = result.totalChunks;

    spinner.succeed(`Indexed ${totalChunks} chunks from ${files.length} files`);

    const index = {
      documents,
      metadata: {
        totalFiles: files.length,
        totalChunks,
        indexedAt: new Date().toISOString(),
        embeddingModel: config.embeddingModel,
        indexPath: indexPath,
      },
    };
    await saveIndex(index, config.dbPath);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n✅ Success!');
    console.log(
      `📊 Indexed ${totalChunks} chunks from ${files.length} files in ${duration}s`
    );
    console.log(`💾 Index saved to: ${config.dbPath}`);
  } catch (error) {
    spinner.fail('Indexing failed');
    console.error(error);
    process.exit(1);
  } finally {
    if (config.parallelServers && config.parallelServers > 1) {
      await ollamaUtils.cleanup();
    }
  }
}

async function searchCommand(query?: string, options?: any) {
  const config: CLIConfig = await loadConfig(DEFAULT_CLI_CONFIG);
  if (options?.db) config.dbPath = expandTilde(options.db);
  const dbPath = expandTilde(config.dbPath);

  if (!query) {
    console.error('❌ Query is required');
    process.exit(1);
  }

  const topK = options?.top ? parseInt(options.top) : config.defaultTopK || 5;

  console.log('🔎 Semantic Search\n');
  console.log(`📝 Query: "${query}"`);
  console.log(`🔝 Top K: ${topK}`);

  const index = await loadIndex(dbPath);
  if (!index.documents || index.documents.length === 0) {
    console.error('❌ No index found. Please run index command first.');
    process.exit(1);
  }

  console.log(`📚 Searching in ${index.documents.length} chunks...\n`);

  const spinner = ora({
    text: 'Getting query embedding...',
    spinner: 'dots',
  }).start();

  try {
    const ollamaUtils = new OllamaUtils({
      ollamaUrl: config.ollamaUrl,
      embeddingModel: config.embeddingModel,
    });
    const embeddings = await ollamaUtils.getEmbeddings([query]);
    const queryEmbedding = embeddings[0];

    spinner.succeed('Query embedding generated');

    if (!queryEmbedding) {
      throw new Error('Failed to get query embedding');
    }

    const similarities = index.documents.map(doc => ({
      ...doc,
      score: cosineSimilarity(queryEmbedding, doc.embedding),
    }));

    similarities.sort((a, b) => b.score - a.score);
    const results = similarities.slice(0, topK);

    console.log('\n📊 Results\n');
    console.log(
      '────────────────────────────────────────────────────────────\n'
    );

    results.forEach((result, idx) => {
      const maxScore = 1.0;
      const barLength = 20;
      const filled = Math.round((result.score / maxScore) * barLength);
      const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);

      console.log(`${idx + 1}. ${result.metadata.title}`);
      console.log(`   📊 Score: ${bar} ${result.score.toFixed(4)}`);
      console.log(`   📁 File: ${result.metadata.filePath}`);
      console.log(
        `   📄 Chunk: ${result.metadata.chunkIndex + 1}/${result.metadata.totalChunks}`
      );
      if (result.metadata.headings && result.metadata.headings.length > 0) {
        console.log(`   🏷️  Context: ${result.metadata.headings.join(' > ')}`);
      }
      console.log(`   📝 Preview:`);
      console.log(
        `      "${result.content.substring(0, 150).replace(/\n/g, ' ')}..."\n`
      );
    });

    console.log('────────────────────────────────────────────────────────────');
  } catch (error) {
    spinner.fail('Search failed');
    console.error(error);
    process.exit(1);
  }
}

async function statsCommand(options?: any) {
  const config: CLIConfig = await loadConfig(DEFAULT_CLI_CONFIG);
  if (options?.db) config.dbPath = expandTilde(options.db);
  const dbPath = expandTilde(config.dbPath);

  const index = await loadIndex(dbPath);
  if (!index.documents || index.documents.length === 0) {
    console.error('❌ No index found. Please run index command first.');
    process.exit(1);
  }

  console.log('📊 Index Statistics\n');
  console.log(`💾 Database: ${dbPath}`);
  console.log(`📁 Index Path: ${index.metadata?.indexPath || 'N/A'}`);
  console.log(`📄 Total Files: ${index.metadata?.totalFiles || 0}`);
  console.log(`📝 Total Chunks: ${index.metadata?.totalChunks}`);
  console.log(`📅 Indexed At: ${index.metadata?.indexedAt || 'N/A'}`);
  console.log(`🤖 Model: ${index.metadata?.embeddingModel || 'N/A'}`);
}

async function configCommand(options?: any) {
  const config: CLIConfig = await loadConfig(DEFAULT_CLI_CONFIG);

  if (options?.list) {
    console.log('📋 Current Configuration:\n');
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  if (options?.set) {
    const [key, value] = options.set.split('=');
    (config as any)[key] = value;
    await saveConfig(config);
    console.log(`✅ Updated ${key} = ${value}`);
    return;
  }

  if (options?.model) {
    config.embeddingModel = options.model;
    await saveConfig(config);
    console.log(`✅ Updated embeddingModel = ${options.model}`);
  }

  if (options?.tokenizerModel) {
    config.tokenizerModel = options.tokenizerModel;
    await saveConfig(config);
    console.log(`✅ Updated tokenizerModel = ${options.tokenizerModel}`);
  }

  if (options?.url) {
    config.ollamaUrl = options.url;
    await saveConfig(config);
    console.log(`✅ Updated ollamaUrl = ${options.url}`);
  }

  if (options?.path) {
    config.indexPath = options.path;
    await saveConfig(config);
    console.log(`✅ Updated indexPath = ${options.path}`);
  }

  if (options?.db) {
    config.dbPath = options.db;
    await saveConfig(config);
    console.log(`✅ Updated dbPath = ${options.db}`);
  }

  if (
    !options?.model &&
    !options?.tokenizerModel &&
    !options?.url &&
    !options?.path &&
    !options?.db &&
    !options?.list &&
    !options?.set
  ) {
    console.log(
      'Use --list to view current config, or provide options to update.'
    );
  }
}

const program = new Command();

program
  .name('obsidian-sonar-cli')
  .description('Semantic search CLI for Obsidian Sonar')
  .version('1.0.0');

program
  .command('index [path]')
  .description('Index markdown files in the specified path')
  .option('-m, --model <model>', 'Embedding model name')
  .option('-t, --tokenizer-model <model>', 'Tokenizer model name (optional)')
  .option('-d, --db <path>', 'Database path')
  .option('-c, --chunk-size <size>', 'Maximum chunk size')
  .option(
    '-p, --parallel <servers>',
    'Number of parallel servers (for faster indexing)'
  )
  .action(indexCommand);

program
  .command('search <query>')
  .description('Search indexed documents')
  .option('-t, --top <n>', 'Number of results to return', '5')
  .option('-d, --db <path>', 'Database path')
  .action(searchCommand);

program
  .command('stats')
  .description('Show index statistics')
  .option('-d, --db <path>', 'Database path')
  .action(statsCommand);

program
  .command('config')
  .description('Manage configuration')
  .option('-l, --list', 'List current configuration')
  .option('-m, --model <model>', 'Set embedding model')
  .option('-t, --tokenizer-model <model>', 'Set tokenizer model')
  .option('-u, --url <url>', 'Set Ollama URL')
  .option('-p, --path <path>', 'Set default index path')
  .option('-d, --db <path>', 'Set default database path')
  .option('-s, --set <key=value>', 'Set a config value')
  .action(configCommand);

program.parse();
