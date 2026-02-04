# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## Unreleased

Diff:
[`0.1.2...HEAD`](https://github.com/aviatesk/obsidian-sonar/compare/0.1.2...HEAD)

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
