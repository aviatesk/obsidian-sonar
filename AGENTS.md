# Development guide

This repository contains an Obsidian plugin for semantic search using local
embeddings.

## Prerequisites & installation

See [README.md](./README.md#requirements) for prerequisites and installation
instructions.

## Build

```bash
npm run build                 # Production build (without benchmark code)
npm run build:with-benchmark  # Development build (includes benchmark code)
```

Benchmark code is excluded from production builds to keep the plugin small. Use
`build:with-benchmark` when you need to run retrieval or RAG benchmarks.

## Code quality checks

```bash
npm run check         # Comprehensive check: format + lint + strict type checking
npm run check:format  # Check formatting -- included in `npm run check`
npm run check:lint    # Check for ESLint errors -- included in `npm run check`
npm run check:svelte  # Svelte check -- included in `npm run check`
npm run check:tsc     # Strict type checking (no `skipLibCheck`) -- included in `npm run check`
```

For Python files in `retrieval-bench/scripts/`:

```bash
uv run basedpyright   # Type checking for Python code
uv run ruff check .   # Linting for Python code (checks formatting, line length, etc.)
```

## Code quality fixes

```bash
npm run fix           # Auto-format + auto-fix linting (combined)
npm run fix:format    # Auto-format code with Prettier -- included in `npm run fix`
npm run fix:lint      # Auto-fix ESLint errors -- included in `npm run fix`
```

## Testing

This project uses Vitest as the testing framework. Test files are located in
`src/` directory alongside the source files (e.g., `src/chunker.test.ts` for
`src/chunker.ts`).

```bash
npm run test        # Run all tests once
npm run test:watch  # Run tests in watch mode
npm run test:ui     # Run tests with interactive browser UI
```

## Development

### General guidelines

- **Make sure to run the code quality checks after making changes**
  - During development: Run `npm run build` to verify compilation succeeds
  - Before finalizing/committing:
    1. Run `npm run test` to verify all tests pass
    2. Run `npm run build` to verify that the build completes without issues
    3. Run `npm run check` for comprehensive validation (format check, ESLint
       with 0 warnings, and strict TypeScript type checking without
       `skipLibCheck`)
    4. Run `npm run fix` to adjust code style if needed
  - For Python files in `retrieval-bench/scripts/`: Run `uv run basedpyright`
    and `uv run ruff check .`
- Keep the plugin small. Avoid large dependencies. Prefer browser-compatible
  packages.
- Avoid Node/Electron APIs where possible.
- **Place temporary and experimental scripts in `/experiments` directory**: All
  one-off scripts, prototypes, or experimental code should be placed under the
  `/experiments` directory. This keeps the main codebase clean and makes it
  clear which code is production vs. experimental.

### Coding style

**[!IMPORTANT]: ALWAYS REMEMBER WITH HIGH PRIORITY**

- All code, documentation and comments should be written in English
  - If instructions are given in a language other than English, you may respond
    in that language
  - But code/documentation/comments must be written in English unless explicitly
    requested in the instructions
- **Do not leave unnecessary comments in code**
  - Instead prefer self-documenting code with clear variable, function names,
    and data/control flows
- **When writing comments or documentation, avoid excessive decoration**. For
  example, avoid scattering emojis or overusing `**` bold formatting. Use these
  only where truly necessary.
- Use backticks for code references: When writing comments, commit messages, or
  documentation, wrap code-related terms in backticks (e.g., `functionName`,
  `variableName`, `file.ts`) to distinguish them from regular text.
- When writing Markdown text, use _2 whitespaces_ for indentation and try to
  keep the maximum line length under _80 characters_.
  - Additionally, prioritize simple text style and limit unnecessary decorations
    (e.g. `**`) to only truly necessary locations. This is a style that should
    generally be aimed for, but pay particular attention when writing Markdown.
  - Headers should use sentence case (only the first word capitalized), not
    title case. For example:
    - Good: `## Conclusion and alternative approaches`
    - Bad: `## Conclusion And Alternative Approaches`
- Commit messages:
  - Do not include the "Generated with
    [Claude Code](https://claude.com/claude-code)" footer in commit messages for
    this project. Keep commit messages focused and concise.
  - When writing commit messages, follow the format "component: Brief summary"
    for the title. In the body of the commit message, provide a brief prose
    summary of the purpose of the changes made. Use backticks for code elements
    (function names, variables, file paths, etc.) to improve readability. Also,
    ensure that the maximum line length never exceeds 72 characters. When
    referencing external GitHub PRs or issues, use proper GitHub interlinking
    format (e.g., "owner/repo#123" for PRs/issues).
- Keep `main.ts` minimal: Focus only on plugin lifecycle (onload, onunload,
  addCommand calls). Delegate all feature logic to separate modules.
- Split large files: If any file exceeds ~200-300 lines, consider breaking it
  into smaller, focused modules.
- Use clear module boundaries: Each file should have a single, well-defined
  responsibility.
- Prefer `async/await` over promise chains; handle errors gracefully.
- **Minimize `try/catch` scope**: Only wrap operations that can actually throw
  errors. Extract the error-prone operation and use early return:

  ```ts
  // Good: minimal try/catch scope
  let result;
  try {
    result = await dangerousOperation();
  } catch (error) {
    logger.error(`Failed: ${error}`);
    return;
  }
  safeOperation(result);

  // Bad: unnecessarily wide try/catch
  try {
    const result = await dangerousOperation();
    safeOperation(result); // Should be outside try
  } catch (error) {
    logger.error(`Failed: ${error}`);
  }
  ```

- Generally, **efforts to maintain backward compatibility are not necessary
  unless explicitly requested by users**. For example, when renaming field names
  in data structures, you can simply perform the rename.

See also [Obsidian style guide](./obsidian-style-guide.md)

### Logging guidelines

All logging uses the `WithLogging` base class (or helper methods in `main.ts`),
which automatically adds `[Sonar.ComponentName]` prefixes. Follow these message
format conventions:

#### Message format

- In-progress operations: Use present progressive (verb-ing) with ellipsis
  - Example: `Indexing 100 documents...`, `Deleting 5 embeddings...`
  - Indicates ongoing work

- Completed operations: Use past participle (verb-ed)
  - Example: `Indexed 100 documents`, `Deleted 5 embeddings`
  - Pair with the corresponding in-progress message for clarity

- State reporting: Use past participle (verb-ed)
  - Example: `Initialized with model-name`, `Detected WebGPU`,
    `WebGL not detected`

- Error messages: Use `Failed to <verb>: ${error}`
  - Example: `Failed to tokenize: ${error}`, `Failed to initialize: ${error}`
  - Include relevant context when helpful (e.g., text length, file count)

- Avoid generic standalone words like `complete` or `done`. Instead, use
  specific past participles that describe what was completed (e.g.,
  `Indexed 100 documents` instead of `Batch indexing complete`)

#### Log level

- Use `error()`: Critical failures that require user attention
  - Always pair with user-facing notification showing "check console"
  - Example: initialization failures, critical errors that stop execution
- Use `warn()`: Problems that don't stop overall execution
  - Example: fallback scenarios (WebGPU → WASM), individual failures in batch
    operations, missing hardware/features, external service failures with
    fallback
- Use `log()`: Normal operations and informational messages

### UX & copy guidelines (for UI text, commands, settings)

- Prefer sentence case for headings, buttons, and titles.
- Use clear, action-oriented imperatives in step-by-step copy.
- Use **bold** to indicate literal UI labels. Prefer "select" for interactions.
- Use arrow notation for navigation: **Settings → Community plugins**.
- Keep in-app strings short, consistent, and free of jargon.

### Performance

- Keep startup light. Defer heavy work until needed.
- Avoid long-running tasks during `onload`; use lazy initialization.
- Batch disk access and avoid excessive vault scans.
- Debounce/throttle expensive operations in response to file system events.

### Benchmark code structure

Benchmark code is separated from the main plugin to keep production builds
small. The code is conditionally compiled using the `INCLUDE_BENCHMARK`
environment variable.

```
retrieval-bench/
  src/
    BenchmarkRunner.ts   # Retrieval-only benchmarks (BM25, Vector, Hybrid)
    settings.ts          # Settings UI for retrieval benchmarks
    index.ts             # Command registration
  scripts/               # Python scripts for data processing

rag-bench/
  src/
    CragBenchmarkRunner.ts  # End-to-end RAG benchmarks (CRAG)
    settings.ts             # Settings UI for CRAG benchmarks
    index.ts                # Command registration
```

Build commands:

- `npm run build` - Production build without benchmark code
- `npm run build:with-benchmark` - Includes benchmark code
- `npm run dev:with-benchmark` - Watch mode with benchmark code

Benchmark settings in `src/config.ts` are optional fields that only appear in
development builds. The settings UI sections are conditionally loaded via
dynamic imports when `process.env.INCLUDE_BENCHMARK === 'true'`.

### Versioning & releases

- Bump `version` in `manifest.json` (SemVer) and update `versions.json` to map
  plugin version → minimum app version.
- Create a GitHub release whose tag exactly matches `manifest.json`'s `version`.
  Do not use a leading `v`.
- Attach `manifest.json`, `main.js`, and `styles.css` (if present) to the
  release as individual assets.
- After the initial release, follow the process to add/update your plugin in the
  community catalog as required.

### Security, privacy, and compliance

Follow Obsidian's Developer Policies and Plugin Guidelines. In particular:

- Default to local/offline operation. Only make network requests when essential
  to the feature.
- No hidden telemetry. If you collect optional analytics or call third-party
  services, require explicit opt-in and document clearly in `README.md` and in
  settings.
- Never execute remote code, fetch and eval scripts, or auto-update plugin code
  outside of normal releases.
- Minimize scope: read/write only what's necessary inside the vault. Do not
  access files outside the vault.
- Clearly disclose any external services used, data sent, and risks.
- Respect user privacy. Do not collect vault contents, filenames, or personal
  information unless absolutely necessary and explicitly consented.
- Avoid deceptive patterns, ads, or spammy notifications.
- Register and clean up all DOM, app, and interval listeners using the provided
  `register*` helpers so the plugin unloads safely.

# Git operations

Only perform Git operations when the user explicitly requests them. After
completing a Git operation, do not perform additional operations based on
conversational context alone. Wait for explicit instructions.

When the user provides feedback or points out issues with a commit:

- Do NOT automatically amend the commit or create a fixup commit
- Explain what could be changed, then wait for explicit instruction

## References

- Obsidian sample plugin: <https://github.com/obsidianmd/obsidian-sample-plugin>
- API documentation: <https://docs.obsidian.md>
- Developer policies: <https://docs.obsidian.md/Developer+policies>
- Plugin guidelines:
  <https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines>
- Style guide: <https://help.obsidian.md/style-guide>
