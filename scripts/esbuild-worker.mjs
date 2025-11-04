#!/usr/bin/env node
/**
 * Separate build for Transformers.js Worker
 * Creates a single ESM bundle for Module Worker
 * Worker is inlined into main.js via emit-worker-inline.mjs
 */
import esbuild from 'esbuild';

const prod = process.argv[2] === 'production';

await esbuild.build({
  entryPoints: ['src/transformers-worker.entry.ts'],
  outfile: 'src/generated/transformers-worker.mjs',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  splitting: false,
  mainFields: ['browser', 'module', 'main'],
  conditions: ['browser', 'module', 'import'],
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env': '{}',
    process: 'undefined',
    global: 'globalThis',
    module: 'undefined',
    exports: 'undefined',
  },
  treeShaking: true,
  minify: prod,
  logLevel: 'info',
});

console.log('✓ Worker built successfully');
