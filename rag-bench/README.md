# End-to-end RAG benchmark

This benchmark evaluates Sonar's full RAG pipeline accuracy using the
[CRAG](https://github.com/facebookresearch/CRAG) dataset, measuring how well the
system retrieves relevant information and generates correct answers.

## Purpose

Demonstrate Sonar's RAG accuracy numerically through two complementary
benchmarks:

- **Benchmark A (Per-question)**: Small corpus (~50 pages per question),
  compares against CRAG paper baselines
- **Benchmark B (Unified corpus)**: Large corpus (~60K pages shared across all
  questions), compares Sonar vs cloud RAG configuration

Key questions:

- Does Sonar's hybrid retrieval (BM25 + embedding + reranking) improve answer
  quality over naive approaches?
- How does a local LLM with good retrieval compare to cloud LLMs with simple
  retrieval?
- How does performance scale from small (50 pages) to large (60K pages) corpora?

## Dataset: CRAG (Meta)

[CRAG](https://github.com/facebookresearch/CRAG) (Comprehensive RAG Benchmark)
provides:

- 4,409 Q&A pairs (2,706 in public split)
- 50 web pages pre-retrieved per question
- Ground truth answers with alternatives
- 5 domains: Finance, Sports, Music, Movie, Open
- Multiple question types: simple, multi-hop, comparison, aggregation, set,
  false_premise, post-processing

Reference: [CRAG paper (arXiv:2406.04744)](https://arxiv.org/abs/2406.04744)

## Evaluation metrics

Both benchmarks use CRAG's three-tier classification:

| Classification | Score | Criteria                                  |
| -------------- | ----- | ----------------------------------------- |
| Correct        | +1    | Answer matches ground truth               |
| Missing        | 0     | Model declines to answer ("I don't know") |
| Incorrect      | -1    | Wrong answer (hallucination)              |

Aggregate metrics:

- **Accuracy** = correct / total
- **Hallucination** = incorrect / total
- **Score** = (correct - incorrect) / total = accuracy - hallucination

This penalizes hallucinations: a system that always says "I don't know" scores
0, while one that hallucinates gets negative scores.

### Evaluation method

Following the CRAG paper (Section 4.2), evaluation uses a two-step automatic
approach:

1. **Rule-based matching**: If the generated answer exactly matches the ground
   truth (case-insensitive), classify as "correct". If the answer contains
   phrases like "I don't know" or "cannot answer", classify as "missing".

2. **LLM-as-judge**: For non-exact matches, an LLM classifies the answer into
   one of three categories: correct, incorrect, or missing.

The CRAG paper uses two LLM evaluators (`gpt-3.5-turbo` and
`llama-3-70B-instruct`) and reports the average to avoid self-preference bias.
This implementation uses `gpt-4o-mini` as a single evaluator for simplicity.

LLM-as-judge prompt:

```
Question: {question}
Ground truth: {expected}
Prediction: {generated}
Evaluate the prediction. Answer with just one word: correct, incorrect, or missing
(use "missing" if the prediction declines to answer or says "I don't know")
```

---

## Benchmark A: Per-question evaluation

Each question searches within its own 50 pre-retrieved pages. This tests
retrieval quality within a constrained set, matching the CRAG paper's Task 3
setup.

### Workflow

#### Step 1: Install dependencies

```bash
uv sync
```

#### Step 2: Download and process CRAG data

First, download the raw CRAG data:

```bash
cd rag-bench
uv run scripts/download_crag.py
```

This downloads and extracts raw data to `datasets/crag-raw/`.

Then, process the raw data into the benchmark format:

```bash
uv run scripts/build_crag.py
```

Options for `build_crag.py`:

- `--input-dir`: Input directory for raw data (default: `datasets/crag-raw`)
- `--output-dir`: Output directory for processed data (default: `datasets/crag`)
- `--sample-size N`: Process only N samples (for testing)
- `--seed N`: Random seed for sampling (default: 42)

Output: `datasets/crag/data.jsonl`

#### Step 3: Configure Sonar

Add the following to your Sonar settings (via Obsidian settings UI or
`data.json`):

```json
{
  "cragDataPath": "/absolute/path/to/rag-bench/datasets/crag/data.jsonl",
  "cragOutputDir": "/absolute/path/to/rag-bench/runs",
  "cragSampleSize": 100,
  "cragOpenaiApiKey": "sk-..."
}
```

Configuration options:

- `cragDataPath`: Path to preprocessed CRAG data
- `cragOutputDir`: Directory for benchmark output
- `cragSampleSize`: Number of samples to process (0 = all)
- `cragSampleOffset`: Number of samples to skip before processing (default: 0)
- `cragOpenaiApiKey`: OpenAI API key for LLM-as-judge evaluation (required)

Search parameters (chunking, reranking, result count, etc.) use Sonar's standard
settings.

#### Step 4: Run benchmark

1. Open Obsidian with Sonar enabled
2. Wait for Sonar initialization (embedder + reranker ready)
3. Open Command Palette (Cmd+P / Ctrl+P)
4. Run **Sonar: Run CRAG benchmark (end-to-end RAG)**

The benchmark will:

1. For each question, create a temporary IndexedDB
2. Index the pages (chunking, embedding, BM25)
3. Perform hybrid search with reranking
4. Generate answer using the chat model
5. Evaluate against ground truth
6. Clean up temporary IndexedDB

#### Step 5: Review results

Output files in `runs/crag/`:

- `results.jsonl`: Per-question results
- `summary.json`: Aggregate metrics with domain/question_type breakdown

### Results

#### Sonar

> Configuration:
>
> - Machine: MacBook Pro (Apple M2 Pro, 16-core GPU, 32 GB RAM)
> - Embedding model: `BAAI/bge-m3`
> - Reranker model: `BAAI/bge-reranker-v2-m3`
> - Chat model: `Qwen/Qwen3-8B-GGUF`
> - Samples: 100

| Metric        | Value |
| ------------- | ----- |
| Accuracy      | 40.0% |
| Hallucination | 29.0% |
| Score         | 11.0% |

<details>
<summary>Breakdown by domain and question type</summary>

Note: With only 100 samples, per-category results have high variance. Treat
these as directional insights rather than statistically significant conclusions.

**By domain:**

| Domain  | N   | Accuracy | Hallucination | Score |
| ------- | --- | -------- | ------------- | ----- |
| open    | 19  | 58%      | 21%           | 37%   |
| music   | 14  | 50%      | 43%           | 7%    |
| movie   | 15  | 40%      | 13%           | 27%   |
| finance | 27  | 37%      | 26%           | 11%   |
| sports  | 25  | 24%      | 40%           | -16%  |

**By question type:**

| Type               | N   | Accuracy | Hallucination | Score |
| ------------------ | --- | -------- | ------------- | ----- |
| simple             | 27  | 63%      | 19%           | 44%   |
| multi-hop          | 6   | 50%      | 50%           | 0%    |
| aggregation        | 10  | 40%      | 30%           | 10%   |
| set                | 9   | 33%      | 56%           | -22%  |
| post-processing    | 6   | 33%      | 50%           | -17%  |
| false_premise      | 14  | 29%      | 29%           | 0%    |
| simple_w_condition | 15  | 27%      | 20%           | 7%    |
| comparison         | 13  | 23%      | 23%           | 0%    |

</details>

#### Comparison with baselines

All baseline results are from CRAG paper (Table 5).

| Configuration           | Accuracy | Hallucination | Score |
| ----------------------- | -------- | ------------- | ----- |
| GPT-4 Turbo (No RAG)    | 33.5%    | 13.5%         | 20.0% |
| Llama 3 70B (No RAG)    | 32.3%    | 28.9%         | 3.4%  |
| GPT-4 Turbo + Naive RAG | 43.6%    | 30.1%         | 13.4% |
| Llama 3 70B + Naive RAG | 40.6%    | 31.6%         | 9.1%  |
| **Sonar Qwen 8B + RAG** | 40.0%    | 29.0%         | 11.0% |

Notes:

- "No RAG" uses only the LLM's parametric knowledge without retrieved context
- "Naive RAG" concatenates search results in ranking order
- Sonar results use `gpt-4o-mini` as the single LLM evaluator, while the paper
  reports averages from `gpt-3.5-turbo` and `llama-3-70B-instruct`

### Limitations

- **Small corpus per question**: Each question only searches within 50
  pre-retrieved pages, not a large corpus. This tests retrieval quality within a
  constrained set, not scalability.
- **English-centric**: CRAG is primarily English; results may not generalize to
  other languages.

---

## Benchmark B: Unified corpus evaluation

All questions search within a single large corpus (~60K pages merged from all
CRAG questions). This tests retrieval scalability and compares Sonar's local
pipeline against a cloud RAG configuration.

### Differences from Benchmark A

| Aspect            | Benchmark A (Per-question) | Benchmark B (Unified)    |
| ----------------- | -------------------------- | ------------------------ |
| Corpus            | ~50 pages per question     | ~60K pages shared        |
| Index             | Created/destroyed per Q    | Created once, shared     |
| Search difficulty | 50 pages                   | 60K pages                |
| Execution time    | Slow (indexing per Q)      | Fast (one-time indexing) |
| Comparison        | vs CRAG paper baselines    | Sonar vs Cloud RAG       |

### Configurations compared

| Configuration      | Embedding              | Search                          | Generation   |
| ------------------ | ---------------------- | ------------------------------- | ------------ |
| **Sonar**          | BGE-M3                 | Hybrid (BM25 + Vector) + Rerank | Qwen3-8B     |
| **Cloud (OpenAI)** | text-embedding-3-large | Vector only (no reranking)      | gpt-4.1-mini |

### Workflow

#### Step 1: Prepare CRAG data

First, complete Benchmark A Steps 1-2 to download and process the CRAG dataset.

#### Step 2: Build unified corpus

```bash
cd rag-bench
uv run scripts/build_crag_unified.py --sample-size 100
```

Options:

- `--input`: Input CRAG data file (default: `datasets/crag/data.jsonl`)
- `--output-dir`: Output directory (default: `datasets/crag-unified`)
- `--sample-size N`: Number of questions to sample (default: 100)
- `--seed N`: Random seed (default: 42)

Output:

- `datasets/crag-unified/corpus.jsonl`: Unified corpus (deduplicated by URL)
- `datasets/crag-unified/queries.jsonl`: Sampled questions
- `datasets/crag-unified/metadata.json`: Statistics

#### Step 3: Configure settings

Add the following to your Sonar settings:

```json
{
  "cragUnifiedCorpusPath": "/absolute/path/to/datasets/crag-unified/corpus.jsonl",
  "cragUnifiedQueriesPath": "/absolute/path/to/datasets/crag-unified/queries.jsonl",
  "cragUnifiedOutputDir": "/absolute/path/to/rag-bench/runs/crag-unified",
  "cragUnifiedSampleSize": 0,
  "cragUnifiedOpenaiApiKey": "sk-..."
}
```

Configuration options:

- `cragUnifiedCorpusPath`: Path to unified corpus
- `cragUnifiedQueriesPath`: Path to queries file
- `cragUnifiedOutputDir`: Directory for benchmark output
- `cragUnifiedSampleSize`: Number of queries to evaluate (0 = all)
- `cragUnifiedSampleOffset`: Number of queries to skip (default: 0)
- `cragUnifiedOpenaiApiKey`: OpenAI API key (required for both evaluation and
  Cloud RAG)

#### Step 4: Run benchmark

1. Open Obsidian with Sonar enabled
2. Open Command Palette (Cmd+P / Ctrl+P)
3. Run **Sonar: Run CRAG Unified benchmark (Sonar vs Cloud)**

The benchmark will:

1. **Sonar evaluation**:
   - Index corpus with BGE-M3 embeddings + BM25
   - For each query: hybrid search + reranking → Qwen3-8B generation
   - Evaluate with LLM-as-judge

2. **Cloud evaluation**:
   - Index corpus with OpenAI text-embedding-3-large (chunked for long docs)
   - For each query: vector search only → gpt-4.1-mini generation
   - Evaluate with LLM-as-judge

3. Generate comparison summary

#### Step 5: Review results

Output files in `runs/crag-unified/`:

- `results-sonar.jsonl`: Per-question Sonar results
- `results-cloud.jsonl`: Per-question Cloud results
- `summary-sonar.json`: Sonar aggregate metrics
- `summary-cloud.json`: Cloud aggregate metrics
- `comparison.json`: Side-by-side comparison

### Results

> Configuration:
>
> - Machine: MacBook Pro (Apple M2 Pro, 16-core GPU, 32 GB RAM)
> - Corpus: 4,652 documents (~60K pages deduplicated)
> - Queries: 100 samples
>
> | Component  | Sonar                | Cloud (OpenAI)         |
> | ---------- | -------------------- | ---------------------- |
> | Embedding  | BGE-M3               | text-embedding-3-large |
> | Retrieval  | BM25 + vector hybrid | embedding similarity   |
> | Reranking  | BGE-reranker-v2-m3   | (none)                 |
> | Generation | Qwen3-8B             | gpt-4.1-mini           |

#### Overall comparison

| Metric        | Sonar       | Cloud (OpenAI) |
| ------------- | ----------- | -------------- |
| Accuracy      | 43%         | 42%            |
| Hallucination | 32%         | 35%            |
| Score         | 11%         | 7%             |
| Indexing time | 6,245s      | 1,133s         |
| Query time    | 33.5s/query | 1.7s/query     |
| API cost      | $0          | $2.66          |

#### Key findings

- **Accuracy is comparable**: Sonar achieves similar accuracy (43% vs 42%) to
  the cloud configuration despite using a local 8B parameter model vs
  GPT-4.1-mini.

- **Lower hallucination**: Sonar has a 3% lower hallucination rate (32% vs 35%),
  resulting in a higher overall score (+4%).

- **Trade-off: speed vs cost**: Cloud is ~20x faster per query (1.7s vs 33.5s)
  but costs $2.66/100 queries. Sonar is free but slower due to limited machine
  resources. Initial indexing is also slower (6,245s vs 1,133s), but this is a
  one-time cost.

<details>
<summary>Breakdown by domain and question type</summary>

Note: With only 100 samples, per-category results have high variance (some
categories have as few as 3-15 samples). Treat these as directional insights
rather than statistically significant conclusions.

**By domain:**

| Domain  | N   | Sonar | Cloud | Diff |
| ------- | --- | ----- | ----- | ---- |
| open    | 18  | 67%   | 67%   | 0%   |
| sports  | 15  | 60%   | 47%   | +13% |
| music   | 15  | 53%   | 60%   | -7%  |
| movie   | 27  | 33%   | 37%   | -4%  |
| finance | 25  | 20%   | 16%   | +4%  |

**By question type:**

| Type               | N   | Sonar | Cloud | Diff |
| ------------------ | --- | ----- | ----- | ---- |
| simple             | 35  | 40%   | 46%   | -6%  |
| multi-hop          | 10  | 70%   | 80%   | -10% |
| simple_w_condition | 11  | 73%   | 45%   | +28% |
| set                | 10  | 40%   | 30%   | +10% |
| comparison         | 12  | 25%   | 42%   | -17% |
| false_premise      | 12  | 25%   | 25%   | 0%   |
| aggregation        | 7   | 43%   | 29%   | +14% |
| post-processing    | 3   | 33%   | 0%    | +33% |

</details>

---

## References

- [CRAG GitHub](https://github.com/facebookresearch/CRAG)
- [CRAG paper (arXiv:2406.04744)](https://arxiv.org/abs/2406.04744)
