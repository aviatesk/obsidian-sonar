> [!TLDR]
>
> 1. Bi-encoder（埋め込み検索）で _広く_ Top-K を拾い、
> 2. cross-encoder で `query` と各候補チャンクを"連結"して関連度を再採点、
> 3. 上位 N を提示。
> 4. 速度は落ちるが Precision@k / nDCG@k が大幅に上がる。まずは K=30–50 /
>    max_length=384–512 / batch=16 を起点に。

---

## 用語の整理

- Reranker（再ランク）：検索で拾った候補を もう一度スコアリングして並べ替える工程のこと（役割名）。
- Cross-encoder：その実現方式のひとつ。`query` と `doc`
  を 1 本の入力として同じエンコーダに通し、1 つの関連度スコアを返す。
- Bi-encoder：`query` と `doc`
  を 別々に埋め込んでベクトル空間で近さを測る（ANN 検索）。
- 普通の会話 LLM（decoder-only）は通常の reranker ではない（"LLM に採点させる"ことは可能だが重い）。

---

## 典型パイプライン

```
query
  └─(埋め込み)──────────────┐
                           ├─ 類似度検索（チャンク単位）→ Top-K 候補
docチャンク群 ─(インデックス)──┘

for each candidate in Top-K:
  input := `${query} [SEP] ${candidate.text}`   ← 文字列を"連結"する（数値和ではない）
  score := cross-encoder(input)

候補を score 降順に並べ替え → 同一ドキュメントで集約 → 上位 N を提示
```

---

## 実装で気をつけるポイント（チェックリスト）

### 入力の作り方

- "連結"は文字列で行う：`query + [SEP] + doc`。
  _（誤解しがち：数値ベクトルを足し合わせるのではない）_
- フォーマットはモデルカード推奨に合わせる（`[SEP]` / `query: …\ndocument: …`
  など）。
- `truncation:true / max_length:384–512` を必ず指定（長文で遅くなるのを防ぐ）。

### 規模・速度の調整

- K（Top-K）：30–50 から開始。欲張るほど遅くなる。
- batch：8–32 を試し、安定する所で固定。
- max_length：384–512。章レベルの長文は先頭優先で切り詰める。
- キャッシュ：`hash(query+doc) → score` でメモ化すると体感が安定。

### 取得後の集約

- チャンク単位のスコアを ドキュメント単位に集約（`max` や `mean`）。
- 近接チャンクは 提示前にマージして読みやすく。

### 失敗しやすい点

- K を上げ過ぎ → レイテンシ増。
- 長すぎる入力 → モデルが遅い/メモリ圧迫。
- 多言語なのに英語専用 reranker → 日本語で精度低下。
- 重複チャンクの上位独占 → overlap を抑え、ドキュメント集約で抑制。

---

## Ollamaベースの実装プラン

### 使うモデル

- 埋め込み：`bge-m3`（8k tokens /
  1024次元）（Ollama 公式の埋め込みカテゴリ。`/api/embed` を使う） ([Ollama][1])

- クロスエンコーダ（Reranker）候補
  - [`qllama/bge-reranker-v2-m3`](https://huggingface.co/BAAI/bge-reranker-v2-m3)（\~636
    MB, ctx 8k）
  - [`qllama/bge-reranker-large`](https://ollama.com/qllama/bge-reranker-large)（\~604
    MB, ctx 512）
  - [`dengcao/Qwen3-Reranker-4B`](https://huggingface.co/dengcao/Qwen3-Reranker-4B-seq-cls)（多言語・32k）
    - コミュニティモデル。ページに「現時点のツール側で"リランク専用API"は未サポート」という注記あり（＝/api/generateで採点させる運用）。 ([Ollama][2])
  - Jina Reranker v2（英/多言語版あり）
  - cross-encoder/ms-marco-MiniLM-L-6-v2（軽量・英語）
  * monoT5（高品質だが重い；seq2seq スコアラー）

### 最小プロトタイプ

> [!warning] Ollama自体に「rerank専用API」はない。`/api/embed`（埋め込み）と
> `/api/generate`（生成）を使って 「query＋docを入力→スコアだけ返させる」形で実装。

#### 1) 埋め込み（bge-m3）

省略。

### 2) Rerank（cross-encoder を /api/generate で採点）

```ts
const RERANKER = 'qllama/bge-reranker-v2-m3'; // 例。Qwen3系でも可

function buildPrompt(query: string, passage: string) {
  // モデルに"数値のみ"を出させるプロンプト（頑丈にパースするため）
  return `You are a reranker. Given a user query and a passage,
return only one floating-point relevance score between 0 and 1.

Query:
${query}

Passage:
${passage}

Rules:
- Output only the score, no text.
- Use 0~1 where 1 is highly relevant.

Score:`;
}

async function scorePair(
  query: string,
  passage: string,
  host = 'http://127.0.0.1:11435'
) {
  const r = await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: RERANKER,
      prompt: buildPrompt(query, passage),
      stream: false,
      keep_alive: '30m',
    }),
  });
  if (!r.ok) throw new Error(await r.text());
  const { response } = (await r.json()) as { response: string };
  const m = response.match(/([01]?\.\d+|0|1)(?![\d.])/); // 浮動小数を抜く
  return m ? Math.max(0, Math.min(1, parseFloat(m[1]))) : 0;
}

export async function rerank(
  query: string,
  chunks: { id: string; text: string; docId: string }[],
  K = 50
) {
  // 1) まずは ANN で拾ってきた Top-K チャンクを渡す想定
  const cand = chunks.slice(0, K);

  // 2) （並列）ペア採点
  const scores = await Promise.all(cand.map(c => scorePair(query, c.text)));

  // 3) スコア付与→ドキュメント集約（max）
  const ranked = cand.map((c, i) => ({ ...c, score: scores[i] }));
  const byDoc = new Map<
    string,
    { docId: string; score: number; items: typeof ranked }
  >();
  for (const r of ranked) {
    const cur = byDoc.get(r.docId) ?? {
      docId: r.docId,
      score: -Infinity,
      items: [] as any,
    };
    cur.score = Math.max(cur.score, r.score);
    cur.items.push(r);
    byDoc.set(r.docId, cur);
  }
  return [...byDoc.values()].sort((a, b) => b.score - a.score).slice(0, 10);
}
```

ポイント:

- Reranker は「`query`＋`passage`
  を 1本の入力」として採点する＝cross-encoderの流儀。
- Ollama は "JSON専用出力"の保証がモデル依存なので、数値だけ出させて正規表現で抜くのが堅実。
- レイテンシを抑えるには Top-K=30–50
  / 同時実行（`Promise.all`）、必要なら"埋め込みと生成を別ポートの Ollama で分離"が効く。
- 一部コミュニティモデルは README 不備や I/O仕様が曖昧。上のプロンプト固定で"数値のみ"返すよう縛るのが安全。（Ollamaに rerank専用APIは未提供。/api/generate での採点運用が現実解） ([Ollama][3],
  [Medium][4])

---

### 推奨パラメータ（初期値）

| 項目                   |           値 | メモ                 |
| ---------------------- | -----------: | -------------------- |
| Retrieval Top-K（ANN） |           50 | 30–50 で調整         |
| Rerank 対象K           |           50 | ANN と同じ           |
| チャンク長             |   512 tokens | 256–1,024 で調整     |
| Overlap                |       10–20% | 例: 512/ovl 96       |
| max 文長（採点側）     | \~512 tokens | 長文は先頭優先で切詰 |

### CLIでの疎通テスト

- 埋め込み（bge-m3）

  ````bash
  curl -s http://127.0.0.1:11434/api/embed \
    -d '{ "model":"bge-m3", "input":["晴れの日","雨の日"] }' | jq '.embeddings | length, .[0] | length'
  # => 件数, 次元（1024）
  ``` :contentReference[oaicite:7]{index=7}

  ````

- Rerank（bge-reranker-v2-m3 で採点）

  ````bash
  PROMPT=$(cat <<'TXT'
  You are a reranker. Given a user query and a passage,
  return only one floating-point relevance score between 0 and 1.

  Query:
  明日の天気を教えて

  Passage:
  天気予報によると明日は全国的に雨で、午後から気温が下がる見込みです。

  Rules:
  - Output only the score, no text.
  - Use 0~1 where 1 is highly relevant.

  Score:
  TXT
  )
  curl -s http://127.0.0.1:11435/api/generate \
    -d "{\"model\":\"qllama/bge-reranker-v2-m3\",\"prompt\":$(
        node -e 'console.log(JSON.stringify(process.argv[1]))' "$PROMPT"
      ),\"stream\":false}" \
  | jq -r .response
  # => 0.89 などの数値が返る想定
  ``` :contentReference[oaicite:8]{index=8}
  ````

### よくある落とし穴と対策

- 「数値じゃなく文章で返ってくる」→ プロンプトで"数値のみ"を強制。必要なら返答の先頭1行だけ読む・`SCORE:`
  接頭辞を付ける等で堅牢化。
- Top-K を上げすぎて遅い → K=30–50 / 同時実行 / 文長トリム（\~512 tokens）。
- モデル互換性 → 一部ツールは「Ollama の reranker モデル未対応」と明記（＝手で
  `/api/generate` を叩く)
- 多言語 → 日本語を含むなら BGE系 or
  Qwen3-Rerankerが無難。モデル切替で比較テストを。

## なぜ「Ollama最小実装」でもクロスエンコーダが成り立つのか

- モデル自体が「`query+passage` → スコア」を学習している（BGE-Reranker /
  Qwen3-Reranker 等）
- APIは汎用（/api/generate）だが、プロンプトを数値スコア専用に固定すれば、実質 cross-encoder
  rerankとして機能する
- 将来、Ollama が rerank 専用I/Oを持てば置き換え可（現状はこの"最小パス"が一番速く組める
