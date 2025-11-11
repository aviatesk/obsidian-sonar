# Obsidian Sonar

**Deep semantic search for your knowledges, completely offline.**

Sonar is a [Obsidian.md](https://obsidian.md/) plugin that brings advanced
semantic search to your Obsidian vault. Like detecting hidden objects under the
sea, it discovers meaningful connections between your notes. All running
privately on your device.

## Requirements

- Node.js 18+
- (Optional) [llama.cpp](https://github.com/ggerganov/llama.cpp)

## Installation

```bash
git clone https://github.com/aviatesk/obsidian-sonar.git
cd obsidian-sonar
npm install
npm run build
cp main.js manifest.json styles.css /path/to/vault/.obsidian/plugins/obsidian-sonar/
```

## Embedder backend

This plugin supports two backends for embedding generation:
[Transformers.js](https://huggingface.co/docs/transformers.js) and
[llama.cpp](https://github.com/ggml-org/llama.cpp). You can switch between them
in the plugin settings without reloading.

### Transformers.js backend

Transformers.js is bundled with the plugin, requiring no additional
installation. This is the default backend for Sonar.

However, Transformers.js can exhibit numerical instability when using WebGPU
(see [bench/README](./bench/README.md#transformersjs-issues-found-during-benchmarking-sonar)
for details). For this reason, the default model for Transformers.js is limited
to [`Xenova/multilingual-e5-small`](https://huggingface.co/Xenova/multilingual-e5-small).

**Pros:**
- Zero external dependencies
- Works out of the box

**Cons:**
- Numerical instability with WebGPU
- Limited model selection

### llama.cpp backend

The llama.cpp backend provides better numerical accuracy and performance, using
quantized GGUF models. The default model is configured to
[`BAAI/bge-m3-gguf`](https://huggingface.co/BAAI/bge-m3-gguf).

**Pros:**
- Better numerical accuracy
- Better performance with quantized models
- Wider model selection (any GGUF embedding model on HuggingFace, without any
  numerical instability - hopefully)

**Cons:**
- Requires external llama.cpp installation

**Installation:**

1. Install llama.cpp:
   ```bash
   # macOS (Homebrew)
   brew install llama.cpp

   # Or build from source
   git clone https://github.com/ggerganov/llama.cpp
   cd llama.cpp
   make llama-server
   ```

2. Configure in Sonar settings:
   - **Embedder backend**: Select `llama.cpp`
   - **Server path**: Path to `llama-server` binary (e.g., `llama-server` or
     `/path/to/llama-server`)
   - **Model repository**: HuggingFace repository (e.g., `BAAI/bge-m3-gguf`)
   - **Model file**: GGUF filename (e.g., `bge-m3-q8_0.gguf`)

The plugin automatically manages the llama.cpp server process (starts, stops,
health checks) and downloads models from HuggingFace on first use.

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
- [Transformers.js](https://huggingface.co/docs/transformers.js) for
  browser-based embeddings
- [Svelte](https://svelte.dev/) for reactive UI components
- [Obsidian API](https://docs.obsidian.md/) for vault integration
