# Obsidian Sonar

**Deep semantic search for your knowledges, completely offline.**

Sonar is a [Obsidian.md](https://obsidian.md/) plugin that brings advanced
semantic search to your Obsidian vault. Like detecting hidden objects under the
sea, it discovers meaningful connections between your notes. All running
privately on your device.

## Requirements

- Node.js 18+
- [llama.cpp](https://github.com/ggerganov/llama.cpp)

## Installation

### Install llama.cpp

```bash
# macOS (Homebrew)
brew install llama.cpp

# Or build from source
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp
make llama-server
```

### Install the plugin

```bash
git clone https://github.com/aviatesk/obsidian-sonar.git
cd obsidian-sonar
npm install
npm run build
cp main.js manifest.json styles.css /path/to/vault/.obsidian/plugins/obsidian-sonar/
```

### Configure in Sonar settings

- **Server path**: Path to `llama-server` binary
  - You can use just the command name `llama-server` if installed via Homebrew
    or other package managers (the plugin will resolve the full path
    automatically)
  - If path resolution doesn't work, use the absolute path instead:
    - macOS (Homebrew): `/opt/homebrew/bin/llama-server` (Apple Silicon) or
      `/usr/local/bin/llama-server` (Intel)
    - Linux: `/usr/local/bin/llama-server` or `/usr/bin/llama-server`
    - Custom build: `/path/to/llama.cpp/llama-server`
  - To find the absolute path, run `which llama-server` in your terminal
- **Model repository**: HuggingFace repository (default:
  `ggml-org/bge-m3-Q8_0-GGUF`)
- **Model file**: GGUF filename (default: `bge-m3-q8_0.gguf`)

## Model and server management

The plugin automatically manages the llama.cpp server process (starts, stops,
health checks) and downloads models from HuggingFace on first use. Models are
cached in the default location, i.e. `~/Library/Caches/llama.cpp/` (macOS) or
`~/.cache/llama.cpp/` (Linux).

Most embedding models on HuggingFace are public and require no authentication.
For gated models (e.g., Llama 2/3), create a HuggingFace access token at
https://huggingface.co/settings/tokens and save it to `~/.huggingface/token`:

```bash
mkdir -p ~/.huggingface
echo 'YOUR_TOKEN_HERE' > ~/.huggingface/token
chmod 600 ~/.huggingface/token
```

## Audio transcription (experimental)

Sonar supports indexing audio files (`.m4a`, `.mp3`, `.wav`, `.webm`, `.ogg`,
`.flac`) by transcribing them locally using
[whisper.cpp](https://github.com/ggerganov/whisper.cpp). This feature is
experimental and requires external dependencies.

### Requirements

1. **whisper.cpp**: Install via Homebrew or build from source:

   ```bash
   # macOS (Homebrew)
   brew install whisper-cpp
   ```

2. **ffmpeg**: Required for audio format conversion:

   ```bash
   # macOS (Homebrew)
   brew install ffmpeg
   ```

3. **Whisper model**: Download a GGML-format model from HuggingFace:

   ```bash
   # Create models directory
   mkdir -p ~/whisper-models

   # Download model (using Hugging Face CLI)
   huggingface-cli download ggerganov/whisper.cpp \
     ggml-large-v3-turbo-q5_0.bin \
     --local-dir ~/whisper-models/
   ```

   For alternative models, see:
   https://huggingface.co/ggerganov/whisper.cpp/tree/main

### Configuration

Configure audio transcription in Sonar settings:

- **Whisper CLI path**: Path to `whisper-cli` binary (default: `whisper-cli`)
- **Whisper model path**: Path to the model file (e.g.,
  `~/whisper-models/ggml-large-v3-turbo-q5_0.bin`)
- **ffmpeg path**: Path to `ffmpeg` binary (default: `ffmpeg`)
- **Transcription language**: Language code for transcription (default: `auto`
  for auto-detection)

## Web search (optional)

Sonar can search the web using [SearXNG](https://github.com/searxng/searxng), a
privacy-respecting metasearch engine.

### Requirements

- A running SearXNG instance with JSON format enabled
- See [SearXNG documentation](https://docs.searxng.org/admin/installation.html)
  for setup instructions

### Configuration

1. Ensure your SearXNG instance has JSON output enabled in `settings.yml`:

   ```yaml
   search:
     formats:
       - html
       - json
   ```

2. Configure in Sonar settings:
   - **SearXNG URL**: Your instance URL (default: `http://localhost:8080`)

## Development

See [CLAUDE.md](./CLAUDE.md) for detailed development guidelines.

## Benchmark

See [bench/README.md](./bench/README.md) for the benchmarks regarding the
accuracy and performance of the features provided by this plugin.

## License

TODO

## Acknowledgments

Built with:

- [llama.cpp](https://github.com/ggerganov/llama.cpp) for local embedding
  generation
- [Svelte](https://svelte.dev/) for reactive UI components
- [Obsidian API](https://docs.obsidian.md/) for vault integration
