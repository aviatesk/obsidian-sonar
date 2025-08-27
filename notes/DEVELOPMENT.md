```table-of-contents

```

# UIs

- [x] 動的ナレッジリストビュー [completion:: 2025-08-28]
- [ ] 動的ナレッジグラフビュー
- [x] Semantic note finder [completion:: 2025-08-30]
- [ ] RAG(?)

## Implementation

- [ ] Svelteベースの実装へ移行
- [ ] DB/推論のステートの表示: status bar
- [ ] ステートの同期、伝播

# Tokenizing

- [x] transformers.js `AutoTokenizer`
- [ ] Ollama based tokenization

# Chunking

- [ ] 適切な[[#Chunk分割単位]]の策定

## Chunk分割単位

現状は以下の設定でチャンクを分割:

- 基本チャンク単位: 512 tokens
- Overlap(同一ファイル内): 64 tokens

一方`BGE-M3`の最大トークン数は8192。チャンク分割単位をあげてもいいかもしれない。

# Preprocessing

- [ ] 無関係なテキストの除去
- [ ] 見出しレベルに基づいた階層構造の保持
- [ ] メタデータの保存

# Search result aggregation

実際のベクタDBはドキュメントごとではなく、チャンクごとに管理されており、検索単位もチャンクごと。それを各UIにおいてどのようにaggregationするべきかを再考する必要がある。

# 精度改善

> [!link] [[RAG検索精度の改善策]]

優先度順に列挙。

## 評価指標の確立

- [ ] ゴールドセット作成: 10-50問程度の質問と正解チャンクIDのセットを作成
- [ ] Recall@k / Precision@k: 検索精度の基本指標を計測
- [ ] [Ragas](https://docs.ragas.io/en/stable/)による生成品質評価: Answer
      Relevance、Faithfulnessの自動評価

## 即効性の高い改善

- [ ] [[Cross-Encoder Rerank]] (BGE-reranker-base)
- [ ] メタデータフィルタリング:
      Obsidianのタグ・フォルダ情報をChromaDBのmetadataとして活用しノイズ低減

## Recall向上施策

- [ ] Hybrid検索 (BM25 +
      Embedding): 固有名詞や専門用語の取り漏らし防止、Reciprocal Rank
      Fusionで統合
- [ ] クエリ拡張:
      LLMで同義語・言い換えを生成し複数埋め込みで検索、言い回しの違いを吸収

## 構造化知識の活用 (GraphRAG)

- [ ] Lv-1: 1-hop拡張 -
      Obsidianの`[[リンク]]`情報を活用し、検索ヒットから1-hop先のノートも取得、あるいは重みづけを変更
- [ ] Lv-2: Knowledge Graph構築 -
      Neo4j等でノート間の関係をグラフDB化、Why/How系の質問への対応力向上

## 長文・専門語対策

- [ ] Multi-Vector Retrieval
      (BGE-M3のColBERTモード): 文書内の部分一致を細かく拾える、長文ノートが多い場合は効果大

# Incremental indexing

# Configurations

- [x] `excludedPaths`
- [ ] `IncludedPaths`
