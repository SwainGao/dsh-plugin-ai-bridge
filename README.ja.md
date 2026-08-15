[简体中文](README.md) · [English](README.en.md) · [**日本語**](README.ja.md) · [한국어](README.ko.md)

<div align="center">

<img src="docs/logo.svg" alt="dsh-plugin-ai-bridge logo" width="128">

# 🌉 dsh-plugin-ai-bridge

### *DeepSeek Harness を外部 AI モデルに橋渡し —— セカンドオピニオン査読 · 敵対的レビュー · タスク委譲 · ノンブロッキングなバックグラウンド実行*

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-Plugin-4D6BFE)](https://github.com/topics/dsh-plugin)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](#)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=node.js&logoColor=white)](#)
[![Tests](https://img.shields.io/badge/tests-23%2F23%20passing-22c55e)](#)

[![Codex](https://img.shields.io/badge/Codex-OpenAI--compatible-000000)](#)
[![Claude](https://img.shields.io/badge/Claude-Anthropic-d97757)](#)
[![GPT](https://img.shields.io/badge/GPT-OpenAI-10a37f)](#)
[![Generic](https://img.shields.io/badge/Generic-OpenAI%20compatible-8A2BE2)](#)

<br>

[✨ 特徴](#features) · [⚡ インストール](#install) · [🔧 設定](#config) · [🎛️ コマンド](#commands) · [🧰 ツール](#tools) · [🏗️ アーキテクチャ](#architecture) · [🎬 デモ](#demo) · [🧪 テスト](#tests) · [⚖️ ライセンス](#license)

</div>

---

<a id="features"></a>
## ✨ 特徴

DeepSeek Harness には現在、モデル間コラボレーションの機能がありません。本プラグインはそこに「橋」を架けます —— セッション内からコードレビューや複雑なタスクを外部モデルへ委譲し、その判断を現在のセッションに持ち帰れます。

<table>
<tr><td align="left">

🔍 &nbsp;読み取り専用の**セカンドオピニオン査読** —— スタイル・ロジック・潜在バグ・セキュリティ。セッション状態は変更しない<br>
⚔️ &nbsp;**敵対的レビュー** —— 設計判断・アーキテクチャの前提・境界条件・例外処理を、5〜10 の「魂を揺さぶる」質問で突く<br>
🛟 &nbsp;**タスク委譲 / レスキュー** —— 会話履歴 + タスクをまとめ、結果をプラグインコンテキストとして注入<br>
⏳ &nbsp;**ノンブロッキングなバックグラウンドジョブ** —— `ctx.jobs` 上の `status` / `result` / `cancel`<br>
🧩 &nbsp;**モデル向けツール** —— `ai_bridge_review` / `ai_bridge_delegate` で、エージェント自身も自発的に助言を求められる

</td></tr>
</table>

| 機能 | 起動方法 | 説明 |
|------|---------|------|
| セカンドオピニオン査読 | `/bridge review <file\|code>` | 読み取り専用レビュー。ノンブロッキングでバックグラウンド実行 |
| 敵対的レビュー | `/bridge adversarial-review <file\|code>` | 5〜10 の挑戦的な質問 |
| タスク委譲 / レスキュー | `/bridge rescue <task>` | 履歴 + タスク → 外部モデル → 結果を注入 |
| ジョブ状況 | `/bridge status` | bridge のバックグラウンドジョブを一覧 |
| 結果の取得 | `/bridge result <job-id>` | 完了したジョブの出力を取得 |
| ジョブのキャンセル | `/bridge cancel <job-id>` | 実行中ジョブをキャンセル |

---

<a id="install"></a>
## ⚡ インストール

```sh
# 1. DSH プロファイルに追加
dsh plugin --profile <profile-name> add dsh-plugin-ai-bridge

# 2. プロファイルの cordis.patch.yml に登録（「設定」を参照）

# 3. プロファイルを再起動し、次のように入力:
/bridge help
```

> ソースからインストールする場合: `npm run build` を実行後、`lib/` をプロファイルの `node_modules/dsh-plugin-ai-bridge` にリンクします。

---

<a id="config"></a>
## 🔧 設定

プラグイン設定はプロファイルの `cordis.patch.yml` に記述します（環境変数はフォールバックとして機能）。

| キー | デフォルト | 説明 |
|---|---|---|
| `apiKey` | `''` | 外部モデルの API キー |
| `baseUrl` | provider に応じて自動 | エンドポイントのベース URL（OpenAI 互換は `/v1` を含む / Anthropic は含まない） |
| `provider` | `openai` | `openai`（GPT、Chat Completions）· `codex`（Responses API）· `anthropic`（Claude）· `generic`（任意の OpenAI 互換リレー） |
| `defaultModel` | `gpt-5-codex` | デフォルトのモデル id |
| `timeoutMs` | `120000` | リクエストごとのタイムアウト（ミリ秒） |
| `maxOutputTokens` | `4000` | 1 回の呼び出しの最大出力トークン |

<details>
<summary><b>🔵 例 1: GPT（Chat Completions）</b></summary>

```yaml
# $DSH_HOME/profiles/<profile-name>/cordis.patch.yml
- insert:
    - id: ai-bridge
      name: dsh-plugin-ai-bridge
      config:
        provider: openai
        defaultModel: gpt-5-codex
        baseUrl: https://api.openai.com/v1
        apiKey: sk-...
```
</details>

<details>
<summary><b>⚫ 例 2: Codex（Responses API）</b></summary>

```yaml
- insert:
    - id: ai-bridge
      name: dsh-plugin-ai-bridge
      config:
        provider: codex
        defaultModel: gpt-5-codex
        baseUrl: https://api.openai.com/v1
        apiKey: sk-...
```
</details>

<details>
<summary><b>🟤 例 3: Claude（Anthropic）</b></summary>

```yaml
- insert:
    - id: ai-bridge
      name: dsh-plugin-ai-bridge
      config:
        provider: anthropic
        defaultModel: claude-sonnet-4-5
        baseUrl: https://api.anthropic.com
        apiKey: sk-ant-...
```
</details>

<details>
<summary><b>🟣 例 4: 独自の OpenAI 互換ゲートウェイ</b></summary>

```yaml
- insert:
    - id: ai-bridge
      name: dsh-plugin-ai-bridge
      config:
        provider: generic
        baseUrl: https://your-gateway.example.com/v1
        defaultModel: your-model-id
        apiKey: ...
```
</details>

### 🔌 リレーゲートウェイ（cc-switch）

プラグインは `baseUrl` により任意のリレーサービスをサポートします。[cc-switch](https://github.com/farion1231/cc-switch) で Claude / Codex をリレーに切り替えている場合、「リレー URL + トークン + モデル名」を同じように記述します:

| シーン | `provider` | `baseUrl` | `defaultModel` |
|--------|-----------|-----------|----------------|
| Codex（Chat Completions リレー） | `generic` | `https://<リレー>/v1` | リレーが要求するモデル名 |
| Codex（Responses API リレー） | `codex` | `https://<リレー>/v1` | リレーが要求するモデル名 |
| Claude（Anthropic リレー） | `anthropic` | `https://<リレー>` | リレーが要求するモデル名 |

> ⚠️ cc-switch が書き込むのは Claude Code / Codex CLI それぞれの設定ファイルであり、DSH プロセスには自動注入されません。上の設定に同じリレー認証情報をもう一度書くか、cc-switch 風の環境変数（下記）をエクスポートしてください。プラグインがフォールバックとして読み取ります。

### 🔑 環境変数によるフォールバック

`cordis.patch.yml` に値がない場合、次の優先順で環境変数から読み取ります:

- **API キー**: `BRIDGE_API_KEY` → `ANTHROPIC_AUTH_TOKEN`（anthropic のみ）→ `ANTHROPIC_API_KEY`（anthropic のみ）→ `OPENAI_API_KEY`
- **baseUrl**: `BRIDGE_BASE_URL` → `ANTHROPIC_BASE_URL`（anthropic のみ）/ `OPENAI_BASE_URL`（その他）
- **モデル**: `BRIDGE_MODEL`

> したがって、シェルに cc-switch でよく使う `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `OPENAI_BASE_URL` / `OPENAI_API_KEY` を既にエクスポートしている場合、本プラグインはそれをそのまま利用できます。

---

<a id="commands"></a>
## 🎛️ コマンド

> DSH のコマンド名は `[a-z][a-z0-9_-]*` のみ（`:` 不可）。そのため 6 つの操作は単一の `/bridge` コマンドの**サブコマンド**として実装しています:

| 想定コマンド | 実際の起動方法 |
|---|---|
| `/bridge:review [ファイルパスまたはコード片]` | `/bridge review <file\|code>` |
| `/bridge:adversarial-review [...]` | `/bridge adversarial-review <file\|code>` |
| `/bridge:rescue [タスク説明]` | `/bridge rescue <task>` |
| `/bridge:status` | `/bridge status` |
| `/bridge:result [job-id]` | `/bridge result <job-id>` |
| `/bridge:cancel [job-id]` | `/bridge cancel <job-id>` |

### 🔍 `/bridge review <file|code>`

読み取り専用レビュー。`file` は絶対パス、または現在のセッション作業ディレクトリからの相対パスを指定できます。それ以外はコード片として扱われます。

```
/bridge review src/index.ts
/bridge review function add(a, b) { return a - b }
```

`review` と `adversarial-review` は**バックグラウンドジョブ**として実行され（ノンブロッキング）、即座に `ai-bridge-N` のジョブ id を返します。結果は `/bridge result <id>` で取得します。

### ⚔️ `/bridge adversarial-review <file|code>`

敵対的レビュー。5〜10 の「魂を揺さぶる」質問を出力します。

### 🛟 `/bridge rescue <task>`

タスク + 現在の会話履歴（直近 200 メッセージ、最大 60k 文字、ツール呼び出し/結果を含む）をまとめて外部モデルに委譲します。完了すると結果は `[bridge rescue result]` を先頭に付けたプラグインコンテキストとしてセッションへ自動注入され、`/bridge result <id>` でも取得できます。

### ⏳ ジョブ管理

```
/bridge status             # bridge のバックグラウンドジョブを一覧
/bridge result <job-id>    # 完了結果を取得（実行中は待機を案内）
/bridge cancel <job-id>    # 実行中ジョブをキャンセル
```

---

<a id="tools"></a>
## 🧰 モデル向けツール

プラグインは、DeepSeek Harness エージェントが人の入力なしで自発的に使える 2 つのツールも登録します:

| ツール | パラメータ | 説明 |
|------|------|------|
| `ai_bridge_review` | `code`（必須）· `adversarial?` | コード（またはファイルパス）を外部モデルに送り読み取り専用レビュー |
| `ai_bridge_delegate` | `task`（必須）· `include_history?` | タスクを委譲（任意で会話履歴付き）して続きを返す |

---

<a id="architecture"></a>
## 🏗️ アーキテクチャ

依存注入: `inject = ['commands', 'jobs', 'tools']`。`apply()` 内で `ctx.jobs.attachController('ai-bridge')` によりバックグラウンドジョブのコントローラを接続します。

| ファイル | 責務 |
|------|------|
| `src/index.ts` | プラグインエントリ: `name` / `inject` / `Config` / `apply` |
| `src/client.ts` | 外部モデル HTTP クライアント（OpenAI 互換 + Anthropic、ストリーミング/非ストリーミング） |
| `src/prompts.ts` | review / adversarial / rescue のシステムプロンプト |
| `src/context.ts` | ファイル読み取りと会話履歴のシリアライズ |
| `src/jobs.ts` | `ctx.jobs` バックグラウンドジョブ + `JobKindMap` 拡張（`ai-bridge`） |
| `src/commands.ts` | `/bridge` コマンド登録とサブコマンド振り分け |
| `src/tools.ts` | モデル向けツール登録 |

```
src/
├── index.ts     # エントリ: name / inject / Config / apply
├── client.ts    # 外部モデルクライアント（OpenAI-compatible + Anthropic）
├── prompts.ts   # 3 種のシステムプロンプト
├── context.ts   # ファイル読み取り + 履歴シリアライズ
├── jobs.ts      # ctx.jobs バックグラウンドジョブ + JobKind 拡張
├── commands.ts  # /bridge コマンド振り分け
└── tools.ts     # ai_bridge_review / ai_bridge_delegate
```

---

<a id="demo"></a>
## 🎬 デモ

```
User ❯ /bridge review src/index.ts

Bridge ❯ Started review as background job ai-bridge-1.
         Check progress: /bridge status
         Get result:     /bridge result ai-bridge-1

User ❯ /bridge status

Bridge ❯ ai-bridge-1 [ai-bridge] running — bridge review src/index.ts

User ❯ /bridge result ai-bridge-1

Bridge ❯ [スタイル] 命名は明快だが、index.ts:42 のマジックナンバーは定数化を推奨
         [ロジック] parseArgs は空入力で短絡せず、ヌル参照の恐れ
         [セキュリティ] ユーザー入力をテンプレート文字列へ直接連結している。エスケープを
         ...

User ❯ /bridge rescue 失敗したテストを修正して

Bridge ❯ Delegated rescue task as background job ai-bridge-2.
         The result will be injected back into this session when ready.

Bridge ❯ [bridge rescue result]
         原因を特定しました：……以下の順で修正してください……
```

> [`terminalizer`](https://github.com/faressoft/terminalizer) や [`asciinema`](https://asciinema.org) で `demo.gif` として録画できます。

---

<a id="tests"></a>
## 🧪 テスト

```sh
npm install        # 依存関係のインストール
npm run typecheck  # 型チェック
npm run build      # lib/ へコンパイル
npm test           # ビルドしてテストを実行
```

| テストファイル | カバレッジ |
|---------|------|
| `test/client.test.mjs` | ローカル mock サーバーに対する API クライアント（OpenAI/Anthropic、ストリーミング/非ストリーミング、エラー処理） |
| `test/context.test.mjs` | ファイル読み取りと履歴シリアライズ |
| `test/commands.test.mjs` | 6 サブコマンドのエンドツーエンド動作（バックグラウンドジョブ、rescue 注入） |
| `test/integration.test.mjs` | **実物の `CommandRuntime`** でプラグインを読み込み `/bridge` を実行 |
| `test/smoke.test.mjs` | プラグインのオブジェクト形状と登録の検証 |

---

<a id="license"></a>
## ⚖️ ライセンスとコンプライアンス

> **本プラグインは OpenAI の `codex-plugin-cc` に着想を得た独立実装であり、OpenAI とは無関係です。**
>
> `codex-plugin-cc`（Copyright OpenAI and its contributors）は [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) ライセンスです。本プラグインはその設計思想のみを参考にした独立実装であり、ソースコードの包含・複製・派生物はありません。OpenAI との所属・推奨・支援関係は一切ありません。
>
> 詳細はリポジトリルートの [`NOTICE`](./NOTICE) に記載しています。

## 📄 ライセンス

[Apache-2.0](./LICENSE) · 第三者通知は [`NOTICE`](./NOTICE) を参照。

---

<div align="center">

Made with 🧡 for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) community · Inspired by OpenAI `codex-plugin-cc` (independent implementation)

</div>
