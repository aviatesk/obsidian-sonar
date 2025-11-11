# Benchmark workflow

## Step 0: Prerequisites

- **Python dependencies**: Install [uv](https://docs.astral.sh/uv/)
- **Docker**: Required for running Elasticsearch and Weaviate
  - macOS: `brew install --cask docker`
  - Or download from <https://www.docker.com/products/docker-desktop/>

> [!NOTE] All commands below should be run from this directory (`/bench`).

## Step 1: Install Python dependencies

```bash
uv sync
```

## Step 2: Download datasets

## MIRACL (Multilingual retrieval)

Download Japanese and English Wikipedia datasets:

```bash
uv run scripts/download_datasets.py --datasets miracl_ja,miracl_en --splits dev
```

Output: `datasets/raw/miracl_{ja,en}_*_dev.{jsonl,tsv}`

## SciDocs (Scientific papers)

Download scientific paper dataset:

```bash
uv run scripts/download_datasets.py --datasets scidocs
```

Output: `datasets/raw/scidocs_*.{jsonl,tsv}`

## Step 3: Generate benchmark subset

## MIRACL subset

Generate a mixed Japanese/English subset with 200 queries (100 ja + 100 en):

```bash
uv run scripts/generate_subset.py \
  --corpus datasets/raw/miracl_ja_corpus_dev.jsonl,datasets/raw/miracl_en_corpus_dev.jsonl \
  --queries datasets/raw/miracl_ja_queries_dev.jsonl,datasets/raw/miracl_en_queries_dev.jsonl \
  --qrels datasets/raw/miracl_ja_qrels_dev.tsv,datasets/raw/miracl_en_qrels_dev.tsv \
  --n-queries 200 \
  --output-dir datasets/processed/miracl-ja-en_query-200
```

This creates:

- `datasets/processed/miracl-ja-en_query-200/corpus.jsonl` - Document corpus
  (~18,000 documents)
- `datasets/processed/miracl-ja-en_query-200/queries.jsonl` - Test queries (200
  queries)
- `datasets/processed/miracl-ja-en_query-200/qrels.tsv` - Relevance judgments

For multiple datasets, queries are sampled with equal distribution (1:1) by
default. To customize the ratio, use `--query-ratio`:

```bash
# Example: 2x more Japanese queries than English (133 ja + 67 en)
uv run scripts/generate_subset.py \
  --corpus datasets/raw/miracl_ja_corpus_dev.jsonl,datasets/raw/miracl_en_corpus_dev.jsonl \
  --queries datasets/raw/miracl_ja_queries_dev.jsonl,datasets/raw/miracl_en_queries_dev.jsonl \
  --qrels datasets/raw/miracl_ja_qrels_dev.tsv,datasets/raw/miracl_en_qrels_dev.tsv \
  --seed 42 \
  --n-queries 200 \
  --query-ratio 2:1 \
  --output-dir datasets/processed/miracl-ja-en_query-200_ja2en1
```

## SciDocs subset

Generate a scientific paper subset with 100 queries:

```bash
uv run scripts/generate_subset.py \
  --corpus datasets/raw/scidocs_corpus.jsonl \
  --queries datasets/raw/scidocs_queries.jsonl \
  --qrels datasets/raw/scidocs_qrels.tsv \
  --seed 42 \
  --n-queries 100  \
  --output-dir datasets/processed/scidocs_query-100
```

This creates:

- `datasets/processed/scidocs_query-100/corpus.jsonl` - Paper abstracts corpus
  (~18,000 documents)
- `datasets/processed/scidocs_query-100/queries.jsonl` - Research queries (100
  queries)
- `datasets/processed/scidocs_query-100/qrels.tsv` - Relevance judgments

## Step 4: Generate embeddings (for vector/hybrid search)

Skip this step if you only want to run BM25 benchmarks.

## MIRACL embeddings

Generate corpus embeddings:

```bash
uv run scripts/generate_embeddings.py \
  --corpus datasets/processed/miracl-ja-en_query-200/corpus.jsonl \
  --output embeddings/miracl-ja-en_query-200/intfloat/multilingual-e5-small/corpus_embeddings.jsonl \
  --model intfloat/multilingual-e5-small
```

Generate query embeddings:

```bash
uv run scripts/generate_embeddings.py \
  --corpus datasets/processed/miracl-ja-en_query-200/queries.jsonl \
  --output embeddings/miracl-ja-en_query-200/multilingual-e5-small/query_embeddings.jsonl \
  --model intfloat/multilingual-e5-small
```

## SciDocs embeddings

Generate corpus embeddings:

```bash
uv run scripts/generate_embeddings.py \
  --corpus datasets/processed/scidocs_query-100/corpus.jsonl \
  --output embeddings/scidocs_query-100/intfloat/multilingual-e5-small/corpus_embeddings.jsonl \
  --model intfloat/multilingual-e5-small
```

Generate query embeddings:

```bash
uv run scripts/generate_embeddings.py \
  --corpus datasets/processed/scidocs_query-100/queries.jsonl \
  --output embeddings/scidocs_query-100/intfloat/multilingual-e5-small/query_embeddings.jsonl \
  --model intfloat/multilingual-e5-small
```

### Device selection

- The script automatically detects and uses GPU (CUDA/MPS) if available
- Force CPU usage: add `--device cpu`
- Adjust batch size based on GPU memory (default: 128 for GPU, 32 for CPU)

## Long document handling

- Documents are automatically chunked if they exceed model's max sequence length
  (default: 512 tokens per chunk, 128 token overlap)
- Each chunk is stored as a separate embedding with metadata (`doc_id`,
  `chunk_index`, `text`)
- Chunk scores are aggregated to document level at search time (see Advanced
  section in Step 5)

## Model selection

Any sentence-transformers compatible model from Hugging Face can be used.
Examples:

- `intfloat/multilingual-e5-small` (384 dims, ~470MB, default)
- `intfloat/multilingual-e5-base` (768 dims, ~1.1GB, currently has accuracy
  issues when used with Transformers.js)
- `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` (384 dims)

## Step 4.5: Generate Obsidian vault (Sonar only)

If you plan to benchmark Sonar (Obsidian plugin), generate vault format from the
corpus:

## MIRACL vault

```bash
uv run scripts/generate_vault.py \
  --corpus datasets/processed/miracl-ja-en_query-200/corpus.jsonl \
  --output vaults/miracl-ja-en_query-200
```

## SciDocs vault

```bash
uv run scripts/generate_vault.py \
  --corpus datasets/processed/scidocs_query-100/corpus.jsonl \
  --output vaults/scidocs_query-100
```

Skip this step if you only want to benchmark Elasticsearch and Weaviate.

## Step 5: Run benchmarks

## Sonar (Obsidian plugin)

Setup benchmark configuration and run all search methods:

```bash
VAULT=/path/to/the/vault
DATASET=datasets/processed/miracl-ja-en_query-200

mkdir -p $VAULT/.obsidian/plugins/sonar/
cp ../main.js ../manifest.json ../styles.css data.json $VAULT/.obsidian/plugins/sonar/

# Edit data.json to set benchmark paths (use vault-relative or absolute paths)
# Set the following fields:
#   "benchmarkQueriesPath": "/absolute/path/to/bench/datasets/processed/dataset/queries.jsonl"
#   "benchmarkQrelsPath": "/absolute/path/to/bench/datasets/processed/dataset/qrels.tsv"
#   "benchmarkOutputDir": "/absolute/path/to/bench/runs"
# Copy benchmark configuration
cp data.json $VAULT/.obsidian/plugins/sonar/data.json

# 5. Open vault in Obsidian
# 6. Wait for Sonar indexing to complete (check status bar)
# 7. Run benchmark command:
#    - Open Command Palette (Cmd+P / Ctrl+P)
#    - Run "Sonar: Run benchmark (BM25, Vector, Hybrid)"
# 8. Results will be written to:
#    - /path/to/your/vault/runs/sonar.bm25.trec
#    - /path/to/your/vault/runs/sonar.vector.trec
#    - /path/to/your/vault/runs/sonar.hybrid.trec
```

## Elasticsearch & Weaviate

### Quick start: automated benchmark

Run the entire benchmark pipeline (Docker startup, indexing, search, evaluation)
with a single script:

```bash
./runbechmark.sh --dataset datasets/processed/miracl-ja-en_query-200
```

This will run all backends (Elasticsearch and Weaviate) with all methods (BM25,
Vector, Hybrid) and output evaluation results.

Options:

```bash
# Use a different dataset
./runbechmark.sh --dataset datasets/processed/scidocs_query-100

# Use a different model for embeddings (need to specify vector dimention depending on model to be used)
./runbechmark.sh --model intfloat/multilingual-e5-small --dataset datasets/processed/scidocs_query-100 --vector-dims 768
```

Use `./runbechmark.sh --help` for full options.

### Manual benchmark steps

If you prefer to run each step manually:

Start Elasticsearch and Weaviate backends:

```bash
docker compose up -d
```

Verify services are running:

```bash
# Elasticsearch
curl http://localhost:9200

# Weaviate
curl http://localhost:8080/v1/.well-known/ready
```

### Elasticsearch

BM25 search (keyword-only):

```bash
# Index corpus for BM25
uv run scripts/index.py \
  --backend elasticsearch \
  --dataset datasets/processed/miracl-ja-en_query-200

# Search with BM25
uv run scripts/search.py \
  --backend elasticsearch \
  --queries datasets/processed/miracl-ja-en_query-200/queries.jsonl \
  --output runs/es.bm25.trec \
  --method bm25
```

Vector/hybrid search (requires embeddings from Step 4):

```bash
# Index chunks with embeddings
uv run scripts/index.py \
  --backend elasticsearch \
  --embeddings embeddings/miracl-ja-en_query-200/multilingual-e5-small/corpus_embeddings.jsonl

# Vector search
uv run scripts/search.py \
  --backend elasticsearch \
  --queries datasets/processed/miracl-ja-en_query-200/queries.jsonl \
  --output runs/es.vector.trec \
  --method vector \
  --embeddings embeddings/miracl-ja-en_query-200/multilingual-e5-small/query_embeddings.jsonl

# Hybrid search (BM25 + Vector with RRF fusion)
uv run scripts/search.py \
  --backend elasticsearch \
  --queries datasets/processed/miracl-ja-en_query-200/queries.jsonl \
  --output runs/es.hybrid.trec \
  --method hybrid \
  --embeddings embeddings/miracl-ja-en_query-200/multilingual-e5-small/query_embeddings.jsonl
```

### Weaviate

BM25 search (keyword-only):

```bash
# Index corpus for BM25
uv run scripts/index.py \
  --backend weaviate \
  --dataset datasets/processed/miracl-ja-en_query-200

# Search with BM25
uv run scripts/search.py \
  --backend weaviate \
  --queries datasets/processed/miracl-ja-en_query-200/queries.jsonl \
  --output runs/weaviate.bm25.trec \
  --method bm25
```

Vector/hybrid search (requires embeddings from Step 4):

```bash
# Index chunks with embeddings
uv run scripts/index.py \
  --backend weaviate \
  --embeddings embeddings/miracl-ja-en_query-200/multilingual-e5-small/corpus_embeddings.jsonl

# Vector search
uv run scripts/search.py \
  --backend weaviate \
  --queries datasets/processed/miracl-ja-en_query-200/queries.jsonl \
  --output runs/weaviate.vector.trec \
  --method vector \
  --embeddings embeddings/miracl-ja-en_query-200/multilingual-e5-small/query_embeddings.jsonl

# Hybrid search (BM25 + Vector with RRF fusion)
uv run scripts/search.py \
  --backend weaviate \
  --queries datasets/processed/miracl-ja-en_query-200/queries.jsonl \
  --output runs/weaviate.hybrid.trec \
  --method hybrid \
  --embeddings embeddings/miracl-ja-en_query-200/multilingual-e5-small/query_embeddings.jsonl
```

### Advanced: Chunk aggregation parameters

All search methods support chunk-level retrieval with document-level
aggregation:

- `--chunk-top-k`: Number of chunks to retrieve (default: 100)
- `--agg-method`: Aggregation method (default: `max_p`)
  - `max_p`: Maximum score across chunks (MaxP)
  - `top_m_sum`: Sum of top m chunk scores
  - `top_m_avg`: Average of top m chunk scores
  - `rrf_per_doc`: RRF fusion within document chunks
- `--agg-m`: Number of top chunks per document for `top_m_*` methods
  (default: 3)

Example with custom aggregation:

```bash
uv run scripts/search.py \
  --backend elasticsearch \
  --queries datasets/processed/miracl-ja-en_query-200/queries.jsonl \
  --output runs/es.bm25.max_p.trec \
  --method bm25 \
  --chunk-top-k 200 \
  --agg-method max_p
```

## Step 6: Evaluate results

If you used `./runbechmark.sh`, evaluation is already complete. Otherwise, run:

```bash
uv run scripts/evaluate.py \
  --runs runs/*.trec \
  --qrels datasets/processed/miracl-ja-en_query-200/qrels.tsv
```

## Step 7: Clean up

Stop Docker services:

```bash
docker compose down
```

To also remove indexed data volumes:

```bash
docker compose down -v
```

# Troubleshooting

## Out of memory during subset generation

Large corpora (especially MIRACL-en) can exhaust memory. Limit corpus size:

```bash
uv run scripts/generate_subset.py \
  --corpus datasets/raw/miracl_ja_corpus_dev.jsonl,datasets/raw/miracl_en_corpus_dev.jsonl \
  --queries datasets/raw/miracl_ja_queries_dev.jsonl,datasets/raw/miracl_en_queries_dev.jsonl \
  --qrels datasets/raw/miracl_ja_qrels_dev.tsv,datasets/raw/miracl_en_qrels_dev.tsv \
  --n-queries 200 \
  --max-docs-per-dataset 1000000  # Limit to 1M docs per dataset
```
