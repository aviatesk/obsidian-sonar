# End-to-end RAG benchmark

This benchmark evaluates Sonar's full RAG pipeline accuracy using the CRAG
dataset, measuring how well the system retrieves relevant information and
generates correct answers.

## Purpose

Demonstrate Sonar's RAG accuracy numerically by comparing against published
baselines. Unlike the retrieval-only benchmarks in `bench/`, this evaluates the
complete pipeline: retrieval → reranking → LLM answer generation.

Key questions:

- Does Sonar's hybrid retrieval (BM25 + embedding + reranking) improve answer
  quality over naive approaches?
- How does a local LLM with good retrieval compare to cloud LLMs with simple
  retrieval?

## Dataset: CRAG (Meta)

[CRAG](https://github.com/facebookresearch/CRAG) (Comprehensive RAG Benchmark)
provides:

- 4,409 Q&A pairs (2,706 in public split)
- 50 web pages pre-retrieved per question
- Ground truth answers with alternatives
- 5 domains: Finance, Sports, Music, Movie, Open

This benchmark uses the pre-retrieved pages, testing Sonar's ability to find
relevant chunks within those pages and generate accurate answers.

Reference: [CRAG paper (arXiv:2406.04744)](https://arxiv.org/abs/2406.04744)

## Evaluation metrics

CRAG uses a three-tier classification:

| Classification | Score | Criteria                                  |
| -------------- | ----- | ----------------------------------------- |
| Correct        | +1    | Answer matches ground truth               |
| Missing        | 0     | Model declines to answer ("I don't know") |
| Incorrect      | -1    | Wrong answer (hallucination)              |

Aggregate metrics:

- **Accuracy** = correct / total
- **Hallucination** = incorrect / total
- **Score** = (correct - incorrect) / total = accuracy - hallucination

Score formula (from CRAG paper):

```
Score = Σ(score_i) / N

where score_i = +1 (correct), 0 (missing), -1 (incorrect)
```

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

## Benchmark workflow

### Step 1: Install dependencies

```bash
uv sync
```

### Step 2: Download and preprocess CRAG data

```bash
cd rag-bench
uv run scripts/download_crag.py --output-dir datasets/crag
```

Options:

- `--sample-size N`: Process only N samples (for testing)
- `--seed N`: Random seed for sampling (default: 42)

Output: `datasets/crag/data.jsonl`

### Step 3: Configure Sonar

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
- `cragOpenaiApiKey`: OpenAI API key for LLM-as-judge evaluation (required)

Search parameters (chunking, reranking, result count, etc.) use Sonar's standard
settings.

### Step 4: Run benchmark

1. Open Obsidian with Sonar enabled
2. Wait for Sonar initialization (embedder + reranker ready)
3. Open Command Palette (Cmd+P / Ctrl+P)
4. Run "Sonar: Run CRAG benchmark (end-to-end RAG)"

The benchmark will:

1. For each question, create a temporary IndexedDB
2. Index the pages (chunking, embedding, BM25)
3. Perform hybrid search with reranking
4. Generate answer using the chat model
5. Evaluate against ground truth
6. Clean up temporary IndexedDB

### Step 5: Review results

Output files in `runs/`:

- `results.jsonl`: Per-question results
- `summary.json`: Aggregate metrics

Results are also logged to the developer console.

## Results

### Sonar (local)

> Configuration:
>
> - Embedding model: `BAAI/bge-m3`
> - Reranker model: `BAAI/bge-reranker-v2-m3`
> - Chat model: `Qwen/Qwen3-8B-GGUF`
> - Samples: 100

| Metric        | Value |
| ------------- | ----- |
| Accuracy      | 40.0% |
| Hallucination | 29.0% |
| Score         | 11.0% |

### Comparison with baselines

All baseline results are from CRAG paper (Table 5).

| Configuration                          | Accuracy  | Hallucination | Score     |
| -------------------------------------- | --------- | ------------- | --------- |
| GPT-4 Turbo (No RAG)[^no-rag]          | 33.5%     | 13.5%         | 20.0%     |
| Llama 3 70B (No RAG)[^no-rag]          | 32.3%     | 28.9%         | 3.4%      |
| GPT-4 Turbo + Naive RAG                | 43.6%     | 30.1%         | 13.4%     |
| Llama 3 70B + Naive RAG                | 40.6%     | 31.6%         | 9.1%      |
| **Sonar (local)[^llm-as-judge-model]** | **40.0%** | **29.0%**     | **11.0%** |

[^no-rag]:
    "No RAG" uses only the LLM's parametric knowledge without retrieved context.
    This differs fundamentally from RAG approaches. Lower hallucination in No
    RAG (especially GPT-4) suggests models are more conservative without
    external context.

[^llm-as-judge-model]:
    Sonar results use `gpt-4o-mini` as the single LLM evaluator, while the paper
    reports averages from `gpt-3.5-turbo` and `llama-3-70B-instruct`. Results
    may not be directly comparable.

## Limitations

- **Small corpus per question**: Each question only searches within 50
  pre-retrieved pages, not a large corpus. This tests retrieval quality within a
  constrained set, not scalability.
- **English-centric**: CRAG is primarily English; results may not generalize to
  other languages.

## Future work

- Add Benchmark B using HotpotQA/NQ for large-corpus evaluation
- Compare with cloud-based RAG services
