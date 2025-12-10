# Retrieval benchmark suite

Benchmark comparing Sonar (Obsidian plugin) against Elasticsearch and Weaviate
on multilingual and long document retrieval tasks.

## Overview

### Benchmark datasets

This benchmark suite evaluates search quality using two datasets:

**[MIRACL](https://project-miracl.github.io/)**:

- **Languages**: Japanese (7M documents), English (33M documents)
- **Corpus**: Wikipedia articles (pre-chunked)
- **Query**: Short question sentences
- **Task**: Short text Wikipedia retrieval: short question sentence → related
  Wikipedia chunk
- **Reference**: [MIRACL Dataset](https://project-miracl.github.io/) |
  [Paper](https://arxiv.org/abs/2210.09984)

<details>
<summary>Example data</summary>

Query (English):

```json
{
  "_id": "miracl_en_dev#105",
  "text": "Is Abi Branning still a character on EastEnders?"
}
```

Query (Japanese):

```json
{
  "_id": "miracl_ja_dev#101",
  "text": "日本で最古の民間保険会社は何？"
}
```

Corpus (English):

```json
{
  "_id": "miracl_en_dev#4768094#0",
  "title": "Abi Branning",
  "text": "Abi Branning is a fictional character from the BBC soap opera \"EastEnders\", played by Lorna Fitzgerald. She was introduced by executive producer Kate Harwood on 3 July 2006..."
}
```

Corpus (Japanese):

```json
{
  "_id": "miracl_ja_dev#96129#16",
  "title": "生命保険",
  "text": "日本では慶応3年（1868年）に福澤諭吉が著書「西洋旅案内」の中で欧米の文化の一つとして近代保険制度(損害保険、生命保険)を紹介したことが発端となり、1880年に岩倉使節団の随員だった若山儀一らによる日東保生会社（日本初の生命保険会社）開業されるが、倒産してしまう。1881年（明治14年）7月、福沢諭吉門下の阿部泰蔵によって現存最古の保険会社・有限明治生命保険会社が開業された..."
}
```

Qrels (relevance judgments):

```tsv
query-id                   corpus-id                    score
miracl_en_dev#105          miracl_en_dev#4768094#0      1
miracl_ja_dev#101          miracl_ja_dev#96129#16       1
```

The English query asks about a TV character, and finds the relevant Wikipedia
article about that character. The Japanese query asks about the oldest insurance
company, and finds the relevant section in the life insurance article.

</details>

**MIRACL Merged (long document retrieval)**:

A variant of MIRACL that merges pre-chunked passages back into complete
Wikipedia articles for article-level retrieval evaluation.

- **Languages**: Japanese, English (same as MIRACL)
- **Corpus**: Complete Wikipedia articles (merged from chunks) + distractor
  articles from the original BM25 candidate pool
- **Query**: Same short question sentences as MIRACL
- **Task**: Long document retrieval: question → relevant Wikipedia article

<details>
<summary>Example data</summary>

Corpus (merged article):

```json
{
  "_id": "miracl_en_dev#4768094",
  "title": "Abi Branning",
  "text": "Abi Branning is a fictional character from the BBC soap opera..."
}
```

Unlike chunked MIRACL where IDs include chunk indices
(`miracl_en_dev#4768094#0`, `#1`, etc.), merged articles use article-level IDs
(`miracl_en_dev#4768094`).

Qrels (article-level relevance):

```tsv
query-id             corpus-id                score
miracl_en_dev#105    miracl_en_dev#4768094    1
miracl_ja_dev#101    miracl_ja_dev#96129      1
```

</details>

**[SciDocs](https://github.com/beir-cellar/beir)**:

- **Languages**: English only (25K documents)
- **Corpus**: Paper abstracts
- **Query**: 1,000 citing paper title
- **Task**: Scientific paper retrieval: citing paper title → cited paper
  abstract
- **Reference**: [BEIR Benchmark](https://github.com/beir-cellar/beir) |
  [Paper](https://arxiv.org/abs/2104.08663)

<details>
<summary>Example data</summary>

Query:

```json
{
  "_id": "01273bd34dacfe9ef887b320f36934d2f9fa9b34",
  "text": "Image-Guided Nanopositioning Scheme for SEM"
}
```

Corpus:

```json
{
  "_id": "00a7370518a6174e078df1c22ad366a2188313b5",
  "title": "Determining Optical Flow",
  "text": "Optical flow cannot be computed locally, since only one independent measurement is available from the image sequence at a point, while the flow velocity has two components. A second constraint is needed. A method for finding the optical flow pattern is presented which assumes that the apparent velocity of the brightness pattern varies smoothly almost everywhere in the image..."
}
```

Qrels (relevance judgments):

```tsv
query-id                                  corpus-id                                 score
01273bd34dacfe9ef887b320f36934d2f9fa9b34  00a7370518a6174e078df1c22ad366a2188313b5  1
```

The query is a paper title about nanopositioning in SEM (Scanning Electron
Microscopy). The related corpus document is a classic paper on optical flow
(Horn & Schunck, 1981). The relevance is based on citation relationships: the
nanopositioning paper likely cites the optical flow paper as part of its image
processing methodology, demonstrating the indirect, citation-based relevance
characteristic of SciDocs.

</details>

These datasets are widely used for evaluating embedding models and other
purposes, but their characteristics differ significantly.

In rough terms:

- MIRACL is a multilingual zero-shot database built on Wikipedia, using
  intuitive relevance from "question → answer" relationships as query-relevances
- On the other hand, SciDocs is a dataset based on citation graphs of scientific
  papers, creating query-relevance sets by considering the relationship "paper A
  cites paper B → A and B are related" as indirect, academic relevance

MIRACL can be used to measure the accuracy of general information retrieval
tasks, specifically finding short text chunks related to a given query, which is
usually relatively simple and short question.

Whereas SciDocs measures the accuracy of somewhat abstract tasks, specifically
finding abstracts of cited papers that are loosely or strongly related to a
given scientific paper title.

### Benchmark design

Each dataset can be benchmarked with the following search methods across
multiple backends, [Elasticsearch](https://www.elastic.co/elasticsearch/),
[Weaviate](https://weaviate.io/), and Sonar (the Obsidian plugin).

- **BM25**: Full-text keyword search
- **Vector**: Dense embedding similarity (requires embeddings)
- **Hybrid**: Combined BM25 + vector with RRF fusion

For Sonar benchmarking, to ensure proper plugin functionality, we convert the
corpus constructed from the above datasets into markdown files to create a
vault, and then benchmark by actually enabling Sonar within that vault. Sonar
currently uses
[Transformers.js](https://huggingface.co/docs/transformers.js/en/index) as the
backend for embedding generation, and this benchmark primarily utilizes
embeddings generated with that backend.

Benchmarks using Elasticsearch and Weaviate as backends are implemented for
comparative validation. These benchmarks directly load files such as jsonl
extracted from the above datasets via CLI, generate embeddings using
[SentenceTransformer](https://huggingface.co/sentence-transformers), and perform
benchmarking by passing that data to those search backends. Docker is used to
launch these search backends.

The benchmarks for Sonar, Elasticsearch, and Weaviate are implemented to be as
fair as possible. However, due to implementation constraints and for comparative
reference, the following differences exist:

- Elasticsearch uses
  [Kuromoji](https://www.elastic.co/docs/reference/elasticsearch/plugins/analysis-kuromoji-tokenizer)
  for BM25, so it is expected to achieve better accuracy in BM25 benchmarks that
  include Japanese documents
- The Elasticsearch/Weaviate implementations use BYO embeddings generated with
  SentenceTransformer.
- In contrast, Sonar generates embeddings using Transformers.js and manages them
  in IndexedDB, but when using GPU, the embeddings generated by Transformers.js
  showed significant numerical instability (elaborated in the next section).
  Through this benchmark, I was working to resolve these numerical instabilities
  on the Sonar side, but there may still be some minor instabilities.

## Results

### Result for MIRACL

> - Queries: 200
> - Documents: 24754 (JA:EN = 1:1)
> - Embedding model:
>   [`intfloat/multilingual-e5-small`](https://huggingface.co/intfloat/multilingual-e5-small)

| Backend       | Method | nDCG@10 | Recall@10 | Recall@100 | MRR@10 | MAP    |
| ------------- | ------ | ------- | --------- | ---------- | ------ | ------ |
| Sonar         | BM25   | 0.7624  | 0.8753    | 0.9729     | 0.7642 | 0.7103 |
| Sonar         | Vector | 0.9326  | 0.9749    | 0.9975     | 0.9399 | 0.9089 |
| Sonar         | Hybrid | 0.8892  | 0.9444    | 0.9938     | 0.8932 | 0.8580 |
| Elasticsearch | BM25   | 0.7965  | 0.8833    | 0.9530     | 0.8044 | 0.7514 |
| Elasticsearch | Vector | 0.9355  | 0.9749    | 0.9975     | 0.9433 | 0.9129 |
| Elasticsearch | Hybrid | 0.8909  | 0.9348    | 1.0000     | 0.8940 | 0.8650 |
| Weaviate      | BM25   | 0.7480  | 0.8526    | 0.9480     | 0.7481 | 0.6957 |
| Weaviate      | Vector | 0.9357  | 0.9759    | 1.0000     | 0.9432 | 0.9124 |
| Weaviate      | Hybrid | 0.8761  | 0.9316    | 1.0000     | 0.8800 | 0.8486 |

### Result for MIRACL Merged (long document retrieval)

> - Queries: 200
> - Documents: 6,259 articles (394 relevant + 5,865 distractors)
> - Embedding model:
>   [`intfloat/multilingual-e5-small`](https://huggingface.co/intfloat/multilingual-e5-small)

| Backend       | Method | nDCG@10 | Recall@10 | Recall@100 | MRR@10 | MAP    |
| ------------- | ------ | ------- | --------- | ---------- | ------ | ------ |
| Sonar         | BM25   | 0.8827  | 0.9552    | 0.9950     | 0.8742 | 0.8501 |
| Sonar         | Vector | 0.9432  | 0.9735    | 0.9927     | 0.9570 | 0.9213 |
| Sonar         | Hybrid | 0.9531  | 0.9893    | 0.9950     | 0.9497 | 0.9331 |
| Elasticsearch | BM25   | 0.9776  | 0.9976    | 1.0000     | 0.9749 | 0.9673 |
| Elasticsearch | Vector | 0.9756  | 0.9899    | 1.0000     | 0.9778 | 0.9683 |
| Elasticsearch | Hybrid | 0.9873  | 0.9988    | 1.0000     | 0.9796 | 0.9809 |
| Weaviate      | BM25   | 0.9696  | 0.9926    | 1.0000     | 0.9681 | 0.9571 |
| Weaviate      | Vector | 0.9762  | 0.9905    | 1.0000     | 0.9778 | 0.9688 |
| Weaviate      | Hybrid | 0.9845  | 1.0000    | 1.0000     | 0.9779 | 0.9765 |

Sonar's BM25 gap (~0.88 vs ~0.97) is due to tokenization: Sonar uses BPE subword
tokenizer while ES/Weaviate use morphological analyzers (Kuromoji/Kagome).
Vector search compensates in hybrid mode, achieving 0.95+ nDCG@10.

### Result for SciDocs

> - Queries: 100
> - Documents: 12426
> - Embedding model:
>   [`intfloat/multilingual-e5-small`](https://huggingface.co/intfloat/multilingual-e5-small)

| Backend       | Method | nDCG@10 | Recall@10 | Recall@100 | MRR@10 | MAP    |
| ------------- | ------ | ------- | --------- | ---------- | ------ | ------ |
| Sonar         | BM25   | 0.1550  | 0.1625    | 0.3495     | 0.2735 | 0.1043 |
| Sonar         | Vector | 0.1531  | 0.1685    | 0.3390     | 0.2633 | 0.0982 |
| Sonar         | Hybrid | 0.1790  | 0.1940    | 0.3925     | 0.2969 | 0.1198 |
| Elasticsearch | BM25   | 0.1564  | 0.1660    | 0.3450     | 0.2606 | 0.1071 |
| Elasticsearch | Vector | 0.1535  | 0.1685    | 0.3580     | 0.2678 | 0.0979 |
| Elasticsearch | Hybrid | 0.1801  | 0.1905    | 0.3780     | 0.3062 | 0.1224 |
| Weaviate      | BM25   | 0.1511  | 0.1550    | 0.3390     | 0.2598 | 0.1059 |
| Weaviate      | Vector | 0.1576  | 0.1705    | 0.3580     | 0.2781 | 0.1007 |
| Weaviate      | Hybrid | 0.1805  | 0.1925    | 0.3785     | 0.3064 | 0.1224 |

### Notes

#### Metric definitions

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

## Benchmark workflow

To actually run this benchmark, refer to
[benchmark-workflow.md](./benchmark-workflow.md).

## Transformers.js issues found during benchmarking Sonar

### Invalid embeddings on WebGPU

When using `Xenova/multilingual-e5-base` with WebGPU, different embeddings were
generated compared to those generated using WASM as the backend. Since the
similarity between embeddings generated by SentenceTransformer and those
generated with the WASM backend was >0.99, it appears that the embeddings
generated by the WebGPU backend were invalid. Similar issues:

- https://github.com/huggingface/transformers.js/issues/1046
- https://github.com/microsoft/onnxruntime/issues/24442

**Workaround**: Use `Xenova/multilingual-e5-small` instead.

### NaN embeddings at batch boundaries

**Symptom**: Transformers.js (WASM backend) consistently generates all-NaN
embeddings (all 384 dimensions) for the **last item in any batch**, regardless
of batch size.

**Discovery**: During MIRACL benchmark (`miracl-ja-en_query-20`, 3455 files,
batch_size=32), 7 chunks (0.2%) had completely NaN embeddings. The same texts
processed with Python SentenceTransformer produced valid embeddings (norm=1.0,
no NaN).

**Impact on search quality**:

Before fix (NaN embeddings present):

| Run                  | nDCG@10    | Recall@10  | MRR@10     | MAP        |
| -------------------- | ---------- | ---------- | ---------- | ---------- |
| elasticsearch.vector | 0.9261     | 0.9677     | 0.9373     | 0.8972     |
| weaviate.vector      | 0.9264     | 0.9664     | 0.9385     | 0.8980     |
| **sonar.vector**     | **0.4189** | **0.4694** | **0.5344** | **0.3802** |
| sonar.hybrid         | 0.7643     | 0.8589     | 0.7756     | 0.7214     |

NaN embeddings cause JavaScript `Array.sort((a, b) => b.score - a.score)` to
break (NaN comparison returns NaN), corrupting the entire ranking. Example: a
document with score 0.921780 (expected rank #1) was placed at rank #1512, while
documents with score ~0.75 ranked higher.

**Workaround**: Application-layer NaN detection and skipping during indexing.

**UPDATE 2025-11-13**: Additionally, we found that forcing the batch size to 1
prevents this issue from occurring, so the tables in the
[results section](#results) are based on results from indexing with batch
size 1.

**Related upstream issue?**:
https://github.com/microsoft/onnxruntime/issues/26367
