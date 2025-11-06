# Retrieval Benchmark Suite

Benchmark comparing Sonar (Obsidian plugin) against Elasticsearch and Weaviate
on multilingual and long document retrieval tasks.

## Overview

This benchmark suite evaluates search quality using two datasets:

**[MIRACL](https://project-miracl.github.io/)** (Multilingual retrieval)

- Short-text Wikipedia retrieval in Japanese and English
- Simulates real-world multilingual Obsidian vaults
- 860 Japanese queries + 799 English queries

**[SCIDOCS](https://github.com/beir-cellar/beir)** (Scientific paper retrieval)

- Long-form academic paper abstracts
- 1,000 queries for document-to-document retrieval
- Tests performance on technical/academic content

Each dataset can be benchmarked with the following search methods across
multiple backends ([Elasticsearch](https://www.elastic.co/elasticsearch/),
[Weaviate](https://weaviate.io/), and Sonar).

- **BM25**: Full-text keyword search
- **Vector**: Dense embedding similarity (requires embeddings)
- **Hybrid**: Combined BM25 + vector with RRF fusion

## Benchmark Workflow

### Step 0: Prerequisites

- **Python dependencies**: Install [uv](https://docs.astral.sh/uv/)
- **Docker**: Required for running Elasticsearch and Weaviate
  - macOS: `brew install --cask docker`
  - Or download from <https://www.docker.com/products/docker-desktop/>

> [!NOTE] All commands below should be run from this directory (`/bench`).

### Step 1: Install Python dependencies

```bash
uv sync
```

### Step 2: Download datasets

#### MIRACL (Multilingual retrieval)

Download Japanese and English Wikipedia datasets:

```bash
uv run scripts/download_datasets.py --datasets miracl_ja,miracl_en --splits dev
```

Output: `datasets/raw/miracl_{ja,en}_*_dev.{jsonl,tsv}`

#### SCIDOCS (Scientific papers)

Download scientific paper dataset:

```bash
uv run scripts/download_datasets.py --datasets scidocs
```

Output: `datasets/raw/scidocs_*.{jsonl,tsv}`

### Step 3: Generate benchmark subset

#### MIRACL subset

Generate a mixed Japanese/English subset with 200 queries:

```bash
uv run scripts/generate_subset.py \
  --corpus datasets/raw/miracl_ja_corpus_dev.jsonl,datasets/raw/miracl_en_corpus_dev.jsonl \
  --queries datasets/raw/miracl_ja_queries_dev.jsonl,datasets/raw/miracl_en_queries_dev.jsonl \
  --qrels datasets/raw/miracl_ja_qrels_dev.tsv,datasets/raw/miracl_en_qrels_dev.tsv \
  --n-queries 200
```

This creates:

- `datasets/processed/miracl_ja_dev_miracl_en_dev_subset/corpus.jsonl` -
  Document corpus (~18,000 documents)
- `datasets/processed/miracl_ja_dev_miracl_en_dev_subset/queries.jsonl` - Test
  queries (200 queries)
- `datasets/processed/miracl_ja_dev_miracl_en_dev_subset/qrels.tsv` - Relevance
  judgments
- `datasets/processed/miracl_ja_dev_miracl_en_dev_subset/vault/` - Obsidian
  vault format

#### SCIDOCS subset

Generate a scientific paper subset with 100 queries:

```bash
uv run scripts/generate_subset.py \
  --corpus datasets/raw/scidocs_corpus.jsonl \
  --queries datasets/raw/scidocs_queries.jsonl \
  --qrels datasets/raw/scidocs_qrels.tsv \
  --n-queries 200
```

This creates:

- `datasets/processed/scidocs_subset/corpus.jsonl` - Paper abstracts corpus
  (~18,000 documents)
- `datasets/processed/scidocs_subset/queries.jsonl` - Research queries (100
  queries)
- `datasets/processed/scidocs_subset/qrels.tsv` - Relevance judgments
- `datasets/processed/scidocs_subset/vault/` - Obsidian vault format

### Step 4: Generate embeddings (for vector/hybrid search)

Skip this step if you only want to run BM25 benchmarks.

#### MIRACL embeddings

Generate corpus embeddings:

```bash
uv run scripts/generate_embeddings.py \
  --corpus datasets/processed/miracl_ja_dev_miracl_en_dev_subset/corpus.jsonl \
  --output datasets/processed/miracl_ja_dev_miracl_en_dev_subset/corpus_embeddings.jsonl \
  --model intfloat/multilingual-e5-base \
  --batch-size 128
```

Generate query embeddings:

```bash
uv run scripts/generate_embeddings.py \
  --corpus datasets/processed/miracl_ja_dev_miracl_en_dev_subset/queries.jsonl \
  --output datasets/processed/miracl_ja_dev_miracl_en_dev_subset/query_embeddings.jsonl \
  --model intfloat/multilingual-e5-base \
  --batch-size 128
```

#### SCIDOCS embeddings

Generate corpus embeddings:

```bash
uv run scripts/generate_embeddings.py \
  --corpus datasets/processed/scidocs_subset/corpus.jsonl \
  --output datasets/processed/scidocs_subset/corpus_embeddings.jsonl \
  --model intfloat/multilingual-e5-base \
  --batch-size 128
```

Generate query embeddings:

```bash
uv run scripts/generate_embeddings.py \
  --corpus datasets/processed/scidocs_subset/queries.jsonl \
  --output datasets/processed/scidocs_subset/query_embeddings.jsonl \
  --model intfloat/multilingual-e5-base \
  --batch-size 128
```

#### Device selection

- The script automatically detects and uses GPU (CUDA/MPS) if available
- Force CPU usage: add `--device cpu`
- Adjust batch size based on GPU memory (default: 128 for GPU, 32 for CPU)

#### Long document handling

- Documents are automatically chunked if they exceed model's max sequence length
  (default: 512 tokens per chunk, 128 token overlap)
- Each chunk is stored as a separate embedding with metadata (`doc_id`,
  `chunk_index`, `text`)
- Chunk scores are aggregated to document level at search time (see Advanced
  section in Step 5)

#### Model selection

Any sentence-transformers compatible model from Hugging Face can be used.
Examples:

- `intfloat/multilingual-e5-base` (768 dims, ~1.1GB, recommended)
- `intfloat/multilingual-e5-small` (384 dims, ~470MB, faster)
- `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` (384 dims)

### Step 5: Run benchmarks

#### Quick start: automated benchmark

Run the entire benchmark pipeline (Docker startup, indexing, search, evaluation)
with a single script:

```bash
./run_benchmark.sh
```

This will run all backends (Elasticsearch and Weaviate) with all methods (BM25,
Vector, Hybrid) and output evaluation results.

Options:

```bash
# Run only Elasticsearch with BM25
./run_benchmark.sh --backends elasticsearch --methods bm25

# Run only vector search on both backends
./run_benchmark.sh --methods vector

# Use a different dataset
./run_benchmark.sh --dataset datasets/processed/scidocs_subset
```

Use `./run_benchmark.sh --help` for full options.

#### Manual benchmark steps

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

#### Sonar (Obsidian plugin)

**Not yet implemented.** Planned workflow:

1. Open `bench/datasets/processed/miracl_ja_dev_miracl_en_dev_subset/vault/` in
   Obsidian
2. Wait for Sonar indexing to complete
3. Run evaluation script to generate
   `bench/runs/sonar.{bm25,vector,hybrid}.trec`

#### Elasticsearch

##### BM25 search (keyword-only):

```bash
# Index corpus for BM25
uv run scripts/index.py \
  --backend elasticsearch \
  --dataset datasets/processed/miracl_ja_dev_miracl_en_dev_subset

# Search with BM25
uv run scripts/search.py \
  --backend elasticsearch \
  --queries datasets/processed/miracl_ja_dev_miracl_en_dev_subset/queries.jsonl \
  --output runs/es.bm25.trec \
  --method bm25
```

##### Vector/hybrid search (requires embeddings from Step 4):

```bash
# Index chunks with embeddings
uv run scripts/index.py \
  --backend elasticsearch \
  --embeddings datasets/processed/miracl_ja_dev_miracl_en_dev_subset/corpus_embeddings.jsonl \
  --vector-dims 768

# Vector search
uv run scripts/search.py \
  --backend elasticsearch \
  --queries datasets/processed/miracl_ja_dev_miracl_en_dev_subset/queries.jsonl \
  --output runs/es.vector.trec \
  --method vector \
  --embeddings datasets/processed/miracl_ja_dev_miracl_en_dev_subset/query_embeddings.jsonl

# Hybrid search (BM25 + Vector with RRF fusion)
uv run scripts/search.py \
  --backend elasticsearch \
  --queries datasets/processed/miracl_ja_dev_miracl_en_dev_subset/queries.jsonl \
  --output runs/es.hybrid.trec \
  --method hybrid \
  --embeddings datasets/processed/miracl_ja_dev_miracl_en_dev_subset/query_embeddings.jsonl
```

#### Weaviate

##### BM25 search (keyword-only):

```bash
# Index corpus for BM25
uv run scripts/index.py \
  --backend weaviate \
  --dataset datasets/processed/miracl_ja_dev_miracl_en_dev_subset

# Search with BM25
uv run scripts/search.py \
  --backend weaviate \
  --queries datasets/processed/miracl_ja_dev_miracl_en_dev_subset/queries.jsonl \
  --output runs/weaviate.bm25.trec \
  --method bm25
```

##### Vector/hybrid search (requires embeddings from Step 4):

```bash
# Index chunks with embeddings
uv run scripts/index.py \
  --backend weaviate \
  --embeddings datasets/processed/miracl_ja_dev_miracl_en_dev_subset/corpus_embeddings.jsonl

# Vector search
uv run scripts/search.py \
  --backend weaviate \
  --queries datasets/processed/miracl_ja_dev_miracl_en_dev_subset/queries.jsonl \
  --output runs/weaviate.vector.trec \
  --method vector \
  --embeddings datasets/processed/miracl_ja_dev_miracl_en_dev_subset/query_embeddings.jsonl

# Hybrid search (BM25 + Vector with RRF fusion)
uv run scripts/search.py \
  --backend weaviate \
  --queries datasets/processed/miracl_ja_dev_miracl_en_dev_subset/queries.jsonl \
  --output runs/weaviate.hybrid.trec \
  --method hybrid \
  --embeddings datasets/processed/miracl_ja_dev_miracl_en_dev_subset/query_embeddings.jsonl
```

#### Advanced: Chunk aggregation parameters

All search methods support chunk-level retrieval with document-level
aggregation:

- `--chunk-top-k`: Number of chunks to retrieve (default: 100)
- `--agg-method`: Aggregation method (default: `top_m_sum`)
  - `max_p`: Maximum score across chunks (MaxP)
  - `top_m_sum`: Sum of top m chunk scores (recommended)
  - `top_m_avg`: Average of top m chunk scores
  - `rrf_per_doc`: RRF fusion within document chunks
- `--agg-m`: Number of top chunks per document for `top_m_*` methods
  (default: 3)

Example with custom aggregation:

```bash
uv run scripts/search.py \
  --backend elasticsearch \
  --queries datasets/processed/miracl_ja_dev_miracl_en_dev_subset/queries.jsonl \
  --output runs/es.bm25.max_p.trec \
  --method bm25 \
  --chunk-top-k 200 \
  --agg-method max_p
```

### Step 6: Evaluate results

If you used `./run_benchmark.sh`, evaluation is already complete. Otherwise,
run:

```bash
uv run scripts/evaluate.py \
  --runs runs/*.trec \
  --qrels datasets/processed/miracl_ja_dev_miracl_en_dev_subset/qrels.tsv
```

### Step 7: Clean up

Stop Docker services:

```bash
docker compose down
```

To also remove indexed data volumes:

```bash
docker compose down -v
```

## Dataset Details

### MIRACL (Japanese/English)

- **Task**: Short-text Wikipedia retrieval
- **Languages**: Japanese (~7M docs), English (~33M docs, capped at 7M)
- **Queries**: 860 (ja), 799 (en)
- **Use case**: Multilingual note search (simulates real Obsidian vaults)
- **Reference**: [MIRACL Dataset](https://project-miracl.github.io/) |
  [Paper](https://arxiv.org/abs/2210.09984)

### SCIDOCS

- **Task**: Scientific paper retrieval
- **Corpus**: Paper abstracts (~25K documents)
- **Queries**: 1,000 paper queries (title + abstract)
- **Use case**: Long-form academic content, document-to-document retrieval
- **Reference**: [BEIR Benchmark](https://github.com/beir-cellar/beir) |
  [Paper](https://arxiv.org/abs/2104.08663)

## Troubleshooting

### Out of memory during subset generation

Large corpora (especially MIRACL-en) can exhaust memory. Limit corpus size:

```bash
uv run scripts/generate_subset.py \
  --corpus datasets/raw/miracl_ja_corpus_dev.jsonl,datasets/raw/miracl_en_corpus_dev.jsonl \
  --queries datasets/raw/miracl_ja_queries_dev.jsonl,datasets/raw/miracl_en_queries_dev.jsonl \
  --qrels datasets/raw/miracl_ja_qrels_dev.tsv,datasets/raw/miracl_en_qrels_dev.tsv \
  --n-queries 200 \
  --max-corpus-docs 1000000  # Limit to 1M docs per dataset
```

## Experimental Results

This section documents benchmark results comparing different backends and search
methods.

### Results: MIRACL (Japanese + English)

> [`intfloat/multilingual-e5-base`](https://huggingface.co/intfloat/multilingual-e5-base)

| Backend       | Method | nDCG@10 | Recall@10 | Recall@100 | MRR@10 | MAP    |
| ------------- | ------ | ------- | --------- | ---------- | ------ | ------ |
| Sonar         | BM25   | -       | -         | -          | -      | -      |
| Sonar         | Vector | -       | -         | -          | -      | -      |
| Sonar         | Hybrid | -       | -         | -          | -      | -      |
| Elasticsearch | BM25   | 0.7626  | 0.8167    | 0.9285     | 0.7838 | 0.7260 |
| Elasticsearch | Vector | 0.7443  | 0.9096    | 0.9541     | 0.6884 | 0.6701 |
| Elasticsearch | Hybrid | 0.8420  | 0.8982    | 0.9486     | 0.8614 | 0.8063 |
| Weaviate      | BM25   | 0.6034  | 0.7467    | 0.9000     | 0.5880 | 0.5357 |
| Weaviate      | Vector | 0.7399  | 0.9052    | 0.9551     | 0.6855 | 0.6656 |
| Weaviate      | Hybrid | 0.7753  | 0.8670    | 0.9480     | 0.7757 | 0.7246 |

### Results: SCIDOCS

| Backend       | Method | nDCG@10 | Recall@10 | Recall@100 | MRR@10 | MAP |
| ------------- | ------ | ------- | --------- | ---------- | ------ | --- |
| Sonar         | Vector | -       | -         | -          | -      | -   |
| Sonar         | BM25   | -       | -         | -          | -      | -   |
| Sonar         | Hybrid | -       | -         | -          | -      | -   |
| Elasticsearch | Vector | -       | -         | -          | -      | -   |
| Elasticsearch | BM25   | -       | -         | -          | -      | -   |
| Elasticsearch | Hybrid | -       | -         | -          | -      | -   |
| Weaviate      | Vector | -       | -         | -          | -      | -   |
| Weaviate      | BM25   | -       | -         | -          | -      | -   |
| Weaviate      | Hybrid | -       | -         | -          | -      | -   |

### Notes

#### Metric Definitions

- `nDCG@10`:
  [Normalized Discounted Cumulative Gain](https://en.wikipedia.org/wiki/Discounted_cumulative_gain)
  at rank 10. Evaluates ranking quality by considering both relevance and
  position. Higher scores indicate more relevant documents appear at higher
  ranks. Range: 0-1, where 1.0 is ideal.
- `Recall@10`: Proportion of relevant docs found in top 10 results. Measures how
  well the system captures relevant documents in the initial results. Higher
  values mean fewer relevant documents are missed in the top 10.
- `Recall@100`: Proportion of relevant docs found in top 100 results. Measures
  overall retrieval coverage. Important for applications where users browse
  multiple pages of results.
- `MRR@10`:
  [Mean Reciprocal Rank](https://en.wikipedia.org/wiki/Mean_reciprocal_rank) at
  cutoff 10. Measures how quickly users find the first relevant result. Score is
  1.0 if the first relevant document is at rank 1, 0.5 at rank 2, 0.333 at rank
  3, etc. Averaged across all queries. Higher scores mean users find relevant
  results faster.
- `MAP`:
  [Mean Average Precision](<https://en.wikipedia.org/wiki/Evaluation_measures_(information_retrieval)#Mean_average_precision>)
  across all queries. A comprehensive metric that balances precision and recall
  across all rank positions. Particularly sensitive to the ranking of all
  relevant documents, not just the first one.

For detailed metric explanations, see
[ir-measures documentation](https://ir-measur.es/en/latest/measures.html).

> [!TIP] **nDCG@10 vs MAP**: Both are comprehensive metrics, but serve different
> purposes:
>
> - **nDCG@10**: Measures "quality of the first screen" (top 10 results). Uses
>   logarithmic discounting, so rank 1 vs 2 matters much more than rank 9 vs 10.
>   Focuses on what users immediately see. Best for evaluating user-facing
>   search quality.
> - **MAP**: Measures "overall system ranking ability" across all relevant
>   documents. Treats the 1st and 100th relevant document equally. No cutoff,
>   evaluates complete ranking. Best for evaluating comprehensive retrieval
>   performance.
>
> In practice: High nDCG@10 with lower MAP means good initial results but misses
> some relevant docs deeper in ranking. High MAP with lower nDCG@10 means good
> overall coverage but top results could be better ordered.

#### Expected Performance Characteristics

- Vector search: Better for semantic similarity, multilingual queries
- BM25: Better for exact keyword matching, technical terms
- Hybrid: Balanced performance, combining strengths of both methods

Fill in results after running benchmarks using the workflow described above.
