# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## Unreleased

Diff:
[`0.1.0...HEAD`](https://github.com/aviatesk/obsidian-sonar/compare/0.1.0...HEAD)

### Changed

- Improve agent loop to skip tool execution when context budget is exhausted
- Improve `read_file` to guide the model to use retrieved content directly
  without further tool calls
- Restrict `edit_note` to explicit editing requests only

## 0.1.0

Initial public release.

See [README](./README.md) for installation and usage instructions.
