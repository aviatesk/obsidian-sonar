import js from '@eslint/js';
import typescript from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';
import unusedImports from 'eslint-plugin-unused-imports';

export default [
  // Base JavaScript recommended config
  js.configs.recommended,

  // Global ignores
  {
    ignores: ['node_modules/**', 'main.js', 'dist/**', 'build/**'],
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
];
