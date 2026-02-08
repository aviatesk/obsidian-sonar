# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## Unreleased

Diff:
[`0.1.5...HEAD`](https://github.com/aviatesk/obsidian-sonar/compare/0.1.5...HEAD)

### Added

- Vault context file support: specify a markdown file in settings to provide
  context about your vault (structure, conventions, preferences) to the chat
  assistant via the system prompt.
- Related Notes View now follows audio playback position. As audio plays, the
  view automatically updates based on the transcription segment at the current
  timestamp, similar to how PDF page following works.
- The chat `search_vault` tool exposes `exclude_folder` so the model can exclude
  specific folders from results.

## 0.1.5

Diff:
[`0.1.4...0.1.5`](https://github.com/aviatesk/obsidian-sonar/compare/0.1.4...0.1.5)

### Changed

- Added folder auto-suggest to the "Extension tools folder" path setting.
- Replaced the "Excluded paths" textarea with a list UI where each entry has a
  remove button and new paths can be added via folder auto-suggest input.
- Setting UI text is now copyable.

## 0.1.4

Diff:
[`0.1.3...0.1.4`](https://github.com/aviatesk/obsidian-sonar/compare/0.1.3...0.1.4)

### Added

- Related Notes View now follows the current page when viewing PDFs. Scrolling
  to a different page automatically updates the related notes view based on that
  page's content.

## 0.1.3

Diff:
[`0.1.2...0.1.3`](https://github.com/aviatesk/obsidian-sonar/compare/0.1.2...0.1.3)

### Changed

- Sonar now auto-disables tools when chat model doesn't support tool calling.
  The model's capabilities are detected via llama.cpp's `/props` endpoint at
  initialization. (Fixed https://github.com/aviatesk/obsidian-sonar/issues/44)

## 0.1.2

Diff:
[`0.1.1...0.1.2`](https://github.com/aviatesk/obsidian-sonar/compare/0.1.1...0.1.2)

### Fixed

- Fixed chat view input box being hidden behind status bar in default theme
  (Fixed https://github.com/aviatesk/obsidian-sonar/issues/45)

## 0.1.1

Diff:
[`0.1.0...0.1.1`](https://github.com/aviatesk/obsidian-sonar/compare/0.1.0...0.1.1)

### Changed

- Improve agent loop to skip tool execution when context budget is exhausted
- Improve `read_file` to guide the model to use retrieved content directly
  without further tool calls
- Restrict `edit_note` to explicit editing requests only

## 0.1.0

Initial public release.

See [README](./README.md) for installation and usage instructions.
