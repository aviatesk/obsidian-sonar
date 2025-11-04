#!/usr/bin/env node
/**
 * Read src/generated/transformers-worker.mjs and emit as TypeScript constant
 * This allows self-deployment of Worker file on plugin load
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

async function main() {
  const workerPath = path.join(
    rootDir,
    'src/generated/transformers-worker.mjs'
  );
  const outputPath = path.join(
    rootDir,
    'src/generated/transformers-worker-inline.ts'
  );

  try {
    const workerCode = await fs.readFile(workerPath, 'utf8');
    const buildTag = new Date().toISOString();

    // Escape for template string
    const safe = workerCode
      .replace(/\\/g, '\\\\')
      .replace(/`/g, '\\`')
      .replace(/\$/g, '\\$');

    const content = `/**
 * Auto-generated file - DO NOT EDIT
 * Generated from src/generated/transformers-worker.mjs
 * Build tag: ${buildTag}
 */

export const WORKER_MJS_TEXT = \`${safe}\`;

export const WORKER_BUILD_TAG = '${buildTag}';
`;

    await fs.writeFile(outputPath, content, 'utf8');

    // eslint-disable-next-line no-undef
    console.log(
      `✓ Worker inlined successfully (${(workerCode.length / 1024).toFixed(1)}KB)`
    );
    console.log(`  Output: ${outputPath}`); // eslint-disable-line no-undef
    console.log(`  Build tag: ${buildTag}`); // eslint-disable-line no-undef
  } catch (error) {
    console.error('Failed to inline Worker:', error); // eslint-disable-line no-undef
    process.exit(1); // eslint-disable-line no-undef
  }
}

main();
