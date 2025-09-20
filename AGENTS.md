# Development guide

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

## Prerequisites

- Node.js 18+
- Ollama running locally (`ollama serve`)
- BGE-M3 model installed (`ollama pull bge-m3`)

## Install

```bash
npm install
```

## Build

```bash
npm run build         # Quick build with type checking (`skipLibCheck` enabled)
```

(Creates `main.js` for Obsidian plugin only).

## Code quality fixes

```bash
npm run format        # Auto-format code with Prettier
npm run lint          # Auto-fix ESLint errors
```

## Code quality checks

```bash
npm run check         # Comprehensive check: format + lint + strict type checking
npm run format:check  # Auto-format code with Prettier -- included in `npm run check`
npm run lint:check    # Check for ESLint errors -- included in `npm run check`
npx tsc --noEmit      # Strict type checking (no `skipLibCheck`) -- included in `npm run check`
```

## Deploy to local vaults

```bash
npm run deploy
# or
./deploy.sh
```

Deploys built plugin to configured vaults (see `deploy.sh` for vault paths).

## Testing with the Obsidian plugin

- Manual install for testing: copy `main.js`, `manifest.json`, `styles.css` (if
  any) to:
  ```
  <Vault>/.obsidian/plugins/sonar/
  ```
- Reload Obsidian and enable the plugin in **Settings → Community plugins**.

## Tests with CLI Commands

The behavior of these CLI commands is configured by `config.json` unless options
are explicitly specified. For testing, make sure to provide explicit options
when running tests.

### Index documents

```bash
# Index current directory
npm run sonar:index

# Index specific directory
npm run sonar:index /path/to/documents

# With options
npm run sonar:index /path/to/docs --model bge-m3:latest --db ./db/sonar-index.json
```

The default indexing (`npm run sonar:index`) may target a folder containing
numerous files. Indexing such folders may time some time and may not be suitable
for testing, so for simple functionality verification, create a test folder and
explicitly specify it for testing.

### Search

```bash
npm run sonar:search "your query here"

# With options
npm run sonar:search "query" --top 10 --db ./db/sonar-index.json
```

### View statistics

```bash
npm run sonar:stats
```

### Configuration

```bash
npm run sonar:config
```

### Tokenizer testing

```bash
# Test tokenizer
npm run tokenizer:test

# Benchmark tokenizer performance
npm run tokenizer:benchmark

# List available models
npm run tokenizer:models
```

### Extraction testing

```bash
npm run extraction
```

## Development

### General guidelines

- **Make sure to run the code quality checks after making changes**
  - During development: Run `npm run build` to verify compilation succeeds
  - Before finalizing/committing: Run `npm run check` for comprehensive
    validation. This runs format check, ESLint (0 warnings) and strict
    TypeScript type checking (no `skipLibCheck`)
  - To fix issues: Use `npm run format` to auto-format code and `npm run lint`
    for auto-fixable lint errors
- After writing or modifying code, run `npm run format` to ensure consistent
  formatting
  - TypeScript files: maximum line length 80 characters
  - Markdown files: maximum line length 80 characters
- Do not commit build artifacts: Never commit `node_modules/`, `main.js`, or
  other generated files to version control.
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
- Keep `main.ts` minimal: Focus only on plugin lifecycle (onload, onunload,
  addCommand calls). Delegate all feature logic to separate modules.
- Split large files: If any file exceeds ~200-300 lines, consider breaking it
  into smaller, focused modules.
- Use clear module boundaries: Each file should have a single, well-defined
  responsibility.
- Prefer `async/await` over promise chains; handle errors gracefully.
- Generally, **efforts to maintain backward compatibility are not necessary
  unless explicitly requested by users**. For example, when renaming field names
  in data structures, you can simply perform the rename.

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
- Add commands with stable IDs (don't rename once released).
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
