#!/usr/bin/env node
import { Command } from 'commander';
import { SonarTokenizer, TOKENIZER_MODEL_MAPPING } from '../src/core/tokenizer';
import { DEFAULT_CLI_CONFIG, CLIConfig } from '../src/core/config';
import { loadConfig } from './fs-utils';
import * as fs from 'fs';
import * as path from 'path';

const program = new Command();

program
  .name('tokenizer')
  .description('Tokenizer testing and analysis tool for Local RAG')
  .version('1.0.0');

program
  .command('test <filepath>')
  .description('Test tokenizer with a specific file')
  .option('-m, --model <model>', 'Model to test (default: from config)')
  .option('-v, --verbose', 'Show detailed output including text preview')
  .option(
    '-l, --lines <n>',
    'Number of lines to preview in verbose mode',
    parseInt,
    10
  )
  .action(async (filepath, options) => {
    try {
      const config: CLIConfig = await loadConfig(DEFAULT_CLI_CONFIG);
      const fullPath = path.resolve(filepath);

      if (!fs.existsSync(fullPath)) {
        console.error(`❌ File not found: ${fullPath}`);
        process.exit(1);
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      const fileName = path.basename(filepath);
      const model = options.model || config.embeddingModel;

      console.log('🧪 Testing tokenizer with file:', fileName);
      console.log(`📊 Model: ${model}`);
      console.log(`📄 File size: ${(content.length / 1024).toFixed(2)} KB\n`);

      try {
        await SonarTokenizer.initialize(model);

        const tokens = await SonarTokenizer.estimateTokens(content, model);

        console.log(`✅ Tokens: ${tokens}`);
        console.log(
          `📈 Ratio: ${(content.length / tokens).toFixed(2)} chars/token`
        );

        if (options.verbose) {
          const lines = content.split('\n');
          const previewLines = lines.slice(0, options.lines).join('\n');
          console.log(`\n📝 Preview (first ${options.lines} lines):`);
          console.log('---');
          console.log(
            previewLines.substring(0, 500) +
              (previewLines.length > 500 ? '...' : '')
          );
          console.log('---');

          // Analyze line-by-line token distribution
          console.log('\n📈 Token distribution (first 10 lines):');
          for (let i = 0; i < Math.min(10, lines.length); i++) {
            const lineTokens = await SonarTokenizer.estimateTokens(
              lines[i],
              model
            );
            const linePreview =
              lines[i].substring(0, 50) + (lines[i].length > 50 ? '...' : '');
            console.log(
              `  Line ${i + 1}: ${lineTokens} tokens - "${linePreview}"`
            );
          }
        }
      } catch (error) {
        console.error(`❌ Error with model ${model}:`, error);
        process.exit(1);
      }
    } catch (error) {
      console.error('❌ Error:', error);
      process.exit(1);
    }
  });

program
  .command('count <text>')
  .description('Count tokens in the provided text')
  .option(
    '-m, --model <model>',
    'Model to use for tokenization (default: from config)'
  )
  .action(async (text, options) => {
    try {
      const config: CLIConfig = await loadConfig(DEFAULT_CLI_CONFIG);
      const model = options.model || config.embeddingModel;

      console.log(`\n📝 Counting tokens for provided text...`);
      console.log(`Model: ${model}\n`);

      await SonarTokenizer.initialize(model, config.tokenizerModel);
      const tokens = await SonarTokenizer.estimateTokens(
        text,
        model,
        config.tokenizerModel
      );

      console.log(
        `Text (${text.length} chars): "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`
      );
      console.log(`\n📊 Token count: ${tokens}`);
      console.log(
        `   Formatted: ${SonarTokenizer.formatTokenCountShort(tokens)}`
      );

      // Comparison mode removed since heuristic is no longer available
    } catch (error) {
      console.error('❌ Error:', error);
      process.exit(1);
    }
  });

program
  .command('file <filepath>')
  .description('Count tokens in a file')
  .option(
    '-m, --model <model>',
    'Model to use for tokenization (default: from config)'
  )
  .option(
    '-c, --chunks <size>',
    'Show chunk breakdown with specified max chunk size',
    parseInt
  )
  .action(async (filepath, options) => {
    try {
      const config: CLIConfig = await loadConfig(DEFAULT_CLI_CONFIG);
      const model = options.model || config.embeddingModel;
      const fullPath = path.resolve(filepath);

      if (!fs.existsSync(fullPath)) {
        console.error(`❌ File not found: ${fullPath}`);
        process.exit(1);
      }

      const content = fs.readFileSync(fullPath, 'utf-8');

      console.log(`\n📄 Analyzing file: ${filepath}`);
      console.log(`Model: ${model}\n`);

      await SonarTokenizer.initialize(model, config.tokenizerModel);
      const totalTokens = await SonarTokenizer.estimateTokens(
        content,
        model,
        config.tokenizerModel
      );

      console.log(`File size: ${(content.length / 1024).toFixed(2)} KB`);
      console.log(`Total tokens: ${totalTokens}`);
      console.log(
        `Ratio: ${(content.length / totalTokens).toFixed(2)} chars/token`
      );

      if (options.chunks) {
        console.log(
          `\n📦 Chunk analysis (max ${options.chunks} tokens per chunk):`
        );

        const lines = content.split('\n');
        let currentChunk = [];
        let currentTokens = 0;
        let chunkCount = 0;

        for (const line of lines) {
          const lineTokens = await SonarTokenizer.estimateTokens(
            line,
            model,
            config.tokenizerModel
          );

          if (
            currentTokens + lineTokens > options.chunks &&
            currentChunk.length > 0
          ) {
            chunkCount++;
            console.log(
              `  Chunk ${chunkCount}: ${currentTokens} tokens (${currentChunk.length} lines)`
            );
            currentChunk = [line];
            currentTokens = lineTokens;
          } else {
            currentChunk.push(line);
            currentTokens += lineTokens;
          }
        }

        if (currentChunk.length > 0) {
          chunkCount++;
          console.log(
            `  Chunk ${chunkCount}: ${currentTokens} tokens (${currentChunk.length} lines)`
          );
        }

        console.log(`\nTotal chunks: ${chunkCount}`);
        console.log(
          `Average tokens per chunk: ${Math.round(totalTokens / chunkCount)}`
        );
      }
    } catch (error) {
      console.error('❌ Error:', error);
      process.exit(1);
    }
  });

program
  .command('benchmark')
  .description('Run performance benchmarks')
  .option(
    '-s, --size <size>',
    'Text size for benchmark (small/medium/large)',
    'medium'
  )
  .option('-i, --iterations <n>', 'Number of iterations', parseInt, 100)
  .action(async options => {
    console.log(`\n⚡ Running performance benchmark...`);
    console.log(`Size: ${options.size}, Iterations: ${options.iterations}\n`);

    const textSizes = {
      small: 'The quick brown fox jumps over the lazy dog.',
      medium:
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20),
      large: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(
        200
      ),
    };

    const text =
      textSizes[options.size as keyof typeof textSizes] || textSizes.medium;
    console.log(`Text length: ${text.length} characters\n`);

    try {
      // Initialize tokenizer
      await SonarTokenizer.initialize('nomic-embed-text');

      // Benchmark transformer tokenization
      console.log('🤖 Transformer tokenization:');
      const transformerStart = Date.now();
      let transformerTokens = 0;
      for (let i = 0; i < options.iterations; i++) {
        transformerTokens = await SonarTokenizer.estimateTokens(text);
      }
      const transformerTime = Date.now() - transformerStart;
      console.log(
        `  Time: ${transformerTime}ms for ${options.iterations} iterations`
      );
      console.log(
        `  Avg: ${(transformerTime / options.iterations).toFixed(3)}ms per operation`
      );
      console.log(`  Result: ${transformerTokens} tokens`);

      // Performance comparison with heuristic removed
    } catch (error) {
      console.error('❌ Error:', error);
      process.exit(1);
    }
  });

program
  .command('models')
  .description('List available models and their mappings')
  .action(async () => {
    const config: CLIConfig = await loadConfig(DEFAULT_CLI_CONFIG);
    console.log('\n📦 Available Embedding Models:\n');

    console.log('Ollama Model          → Hugging Face Model');
    console.log('─'.repeat(60));

    for (const [ollama, huggingface] of Object.entries(
      TOKENIZER_MODEL_MAPPING
    )) {
      const ollamaPadded = ollama.padEnd(20);
      const isDefault =
        ollama === config.embeddingModel.replace(':latest', '')
          ? ' (default)'
          : '';
      console.log(`${ollamaPadded} → ${huggingface}${isDefault}`);
    }

    console.log(
      '\n💡 Tip: Use any of these Ollama model names with the --model option'
    );
  });

program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
