# Development Guide

## Prerequisites

- Node.js 18+
- Ollama running locally (`ollama serve`)
- BGE-M3 model installed (`ollama pull bge-m3`)

## Installation

```bash
npm install
```

## Build

```bash
npm run build
```

(Creates `main.js` for Obsidian plugin only).

## Type checking

```bash
npx tsc --noEmit
```

## Tests with CLI Commands

### Index documents

```bash
# Index current directory
npm run rag:index

# Index specific directory
npm run rag:index /path/to/documents

# With options
npm run rag:index /path/to/docs --model bge-m3:latest --db ./my-index.json
```

The default indexing (`npm run rag:index`) may target a folder containing
numerous files. Indexing such folders may time some time and may not be suitable
for testing, so for simple functionality verification, create a test folder and
explicitly specify it for testing.

### Search

```bash
npm run rag:search "your query here"

# With options
npm run rag:search "query" --top 10 --db ./my-index.json
```

### View statistics

```bash
npm run rag:stats
```

### Configuration

```bash
npm run rag:config
```

## General Development Guidelines

This repository contains two applications:

- **Obsidian plugin** (`./src`): Main application for Obsidian integration
- **CLI application** (`./cli`): Command-line tool primarily for testing the
  Obsidian plugin

Since the CLI app serves as a testing tool for the Obsidian plugin, both
applications should share common routines and implementations wherever possible.
This ensures:

- Consistency in behavior between the plugin and CLI
- Easier maintenance and debugging
- More reliable testing of core functionality

When implementing new features, prioritize creating shared modules in
`./src/core` that can be used by both applications rather than duplicating code.

## Code style guidelines

- All code, documentation and comments should be written in English
  - If instructions are given in a language other than English, you may respond
    in that language
  - But code/documentation/comments must be written in English unless explicitly
    requested in the instructions
- **DO NOT LEAVE UNNECESSARY COMMENTS IN CODE**
  - Instead prefer self-documenting code with clear variable, function names,
    and data/control flows
- After writing or modifying code, run `npm run format` to ensure consistent
  formatting
  - TypeScript files: maximum line length 80 characters
  - Markdown files: maximum line length 80 characters
- Generally, **efforts to maintain backward compatibility are not necessary
  unless explicitly requested by users**. For example, when renaming field names
  in data structures, you can simply perform the rename.
