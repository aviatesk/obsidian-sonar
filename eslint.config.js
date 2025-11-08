import js from '@eslint/js';
import typescript from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';
import unusedImports from 'eslint-plugin-unused-imports';
import svelte from 'eslint-plugin-svelte';
import svelteParser from 'svelte-eslint-parser';

export default [
  // Base JavaScript recommended config
  js.configs.recommended,

  // Global ignores
  {
    ignores: [
      'node_modules/**',
      'main.js',
      'src/generated/**',
      'scripts/esbuild-worker.mjs',
      'bench',
      '.venv/**',
    ],
  },

  // TypeScript configuration
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        exports: 'writable',
        module: 'writable',
        require: 'readonly',
        global: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': typescript,
      'unused-imports': unusedImports,
    },
    rules: {
      // TypeScript rules
      ...typescript.configs['eslint-recommended'].rules,
      ...typescript.configs['recommended'].rules,

      // Custom rule overrides
      '@typescript-eslint/no-unused-vars': ['error', { args: 'none' }],
      'unused-imports/no-unused-imports': 'error',

      '@typescript-eslint/no-explicit-any': 'off',

      // JavaScript rules
      'no-prototype-builtins': 'off',

      // Disable some recommended rules that conflict with TypeScript
      'no-undef': 'off',
      // 'no-unused-vars': 'off',
    },
  },

  // Svelte configuration
  ...svelte.configs['flat/recommended'],
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: typescriptParser,
        ecmaVersion: 'latest',
        sourceType: 'module',
        extraFileExtensions: ['.svelte'],
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        global: 'readonly',
      },
    },
    plugins: {
      svelte,
      '@typescript-eslint': typescript,
      'unused-imports': unusedImports,
    },
    rules: {
      // Apply TypeScript rules to Svelte files
      ...typescript.configs['recommended'].rules,

      // Svelte specific rule overrides
      '@typescript-eslint/no-unused-vars': ['error', { args: 'none' }],
      'unused-imports/no-unused-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'off',

      // Disable rules that don't work well with Svelte
      'no-undef': 'off',
      'svelte/no-at-html-tags': 'off',

      // Svelte best practices
      'svelte/no-dom-manipulating': 'warn',
      'svelte/no-store-async': 'error',
      'svelte/prefer-style-directive': 'warn',
      'svelte/require-store-reactive-access': 'warn',
      'svelte/valid-prop-names-in-kit-pages': 'error',
      'svelte/no-useless-mustaches': 'warn',
      'svelte/require-each-key': 'error',
      'svelte/prefer-svelte-reactivity': 'warn',
    },
  },
];
