# Development guide

This repository contains an Obsidian plugin for semantic search using local
embeddings.

## Prerequisites & installation

See [README.md](./README.md#requirements) for prerequisites and installation
instructions.

## Build

```bash
npm run build         # Quick build with type checking (`skipLibCheck` enabled)
```

## Code quality checks

```bash
npm run check         # Comprehensive check: format + lint + strict type checking
npm run check:format  # Check formatting -- included in `npm run check`
npm run check:lint    # Check for ESLint errors -- included in `npm run check`
npm run check:svelte  # Svelte check -- included in `npm run check`
npm run check:tsc     # Strict type checking (no `skipLibCheck`) -- included in `npm run check`
```

## Code quality fixes

```bash
npm run fix           # Auto-format + auto-fix linting (combined)
npm run fix:format    # Auto-format code with Prettier -- included in `npm run fix`
npm run fix:lint      # Auto-fix ESLint errors -- included in `npm run fix`
```

## Testing

Currently, there are no agent-executable tests available, as testing typically
requires manual intervention. Instead, it is recommended to statically ensure
that the code works by following these steps:

1. Run `npm run build` to verify that the build completes without issues
2. Run `npm run check` to verify that there are no errors in the code
3. Run `npm run fix` to adjust code style

## Development

### General guidelines

- **Make sure to run the code quality checks after making changes**
  - During development: Run `npm run build` to verify compilation succeeds
  - Before finalizing/committing: Run `npm run check` for comprehensive
    validation. This runs format check, ESLint (0 warnings) and strict
    TypeScript type checking (no `skipLibCheck`)
  - To fix issues: Use `npm run fix` to auto-format and fix linting in one
    command
- Keep the plugin small. Avoid large dependencies. Prefer browser-compatible
  packages.
- Avoid Node/Electron APIs where possible.

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
- **When writing documentation, avoid excessive decoration**. For example, avoid
  scattering emojis or overusing `**` bold formatting. Use these only where
  truly necessary.
- **Use backticks for code references**: When writing comments, commit messages,
  or documentation, wrap code-related terms in backticks (e.g., `functionName`,
  `variableName`, `file.ts`) to distinguish them from regular text.
- **Commit messages**:
  - Do not include the "Generated with
    [Claude Code](https://claude.com/claude-code)" footer in commit messages for
    this project. Keep commit messages focused and concise.
  - When writing commit messages, follow the format `component: Brief summary`
    for the title. In the body of the commit message, provide a brief prose
    summary of the purpose of the changes made. Also, ensure that the maximum
    line length never exceeds 72 characters. When referencing external GitHub
    PRs or issues, use proper GitHub interlinking format (e.g., `owner/repo#123`
    for PRs/issues).
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

### Commands & settings

- Any user-facing commands should be added via `this.addCommand(...)`.
- If the plugin has configuration, provide a settings tab and sensible defaults.
- Persist settings using `this.loadData()` / `this.saveData()`.
- Use stable command IDs; avoid renaming once released.

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

### Agent do/don't

**Do**:

- **Always verify code quality before finalizing changes:**
  - During development: Use `npm run build` for quick compilation checks
  - Before completing work: Run `npm run check` for comprehensive validation
- Provide defaults and validation in settings.
- Write idempotent code paths so `reload`/`unload` doesn't leak listeners or
  intervals.
- Use `this.register*` helpers for everything that needs cleanup, e.g.:
  ```ts
  this.registerEvent(
    this.app.workspace.on('file-open', f => {
      /* ... */
    })
  );
  this.registerDomEvent(window, 'resize', () => {
    /* ... */
  });
  this.registerInterval(
    window.setInterval(() => {
      /* ... */
    }, 1000)
  );
  ```

**Don't**:

- Introduce network calls without an obvious user-facing reason and
  documentation.
- Ship features that require cloud services without clear disclosure and
  explicit opt-in.
- Store or transmit vault contents unless essential and consented.

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

Follow Obsidian's **Developer Policies** and **Plugin Guidelines**. In
particular:

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

### Mobile

- Where feasible, test on iOS and Android.
- Don't assume desktop-only behavior unless `isDesktopOnly` in `manifest.json`
  is `true`.
- Avoid large in-memory structures; be mindful of memory and storage
  constraints.

## References

- Obsidian sample plugin: <https://github.com/obsidianmd/obsidian-sample-plugin>
- API documentation: <https://docs.obsidian.md>
- Developer policies: <https://docs.obsidian.md/Developer+policies>
- Plugin guidelines:
  <https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines>
- Style guide: <https://help.obsidian.md/style-guide>
