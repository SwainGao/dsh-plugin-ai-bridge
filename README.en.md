[简体中文](README.md) · [**English**](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

<div align="center">

<img src="docs/logo.svg" alt="dsh-plugin-ai-bridge logo" width="128">

# dsh-plugin-ai-bridge

### *Bridge DeepSeek Harness to external AI models — second-opinion review · adversarial review · task delegation · non-blocking background scheduling*

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-Plugin-4D6BFE)](https://github.com/topics/dsh-plugin)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](#)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=node.js&logoColor=white)](#)
[![CI](https://github.com/SwainGao/dsh-plugin-ai-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/SwainGao/dsh-plugin-ai-bridge/actions/workflows/ci.yml)

[![Codex](https://img.shields.io/badge/Codex-OpenAI--compatible-000000)](#)
[![Claude](https://img.shields.io/badge/Claude-Anthropic-d97757)](#)
[![GPT](https://img.shields.io/badge/GPT-OpenAI-10a37f)](#)
[![Generic](https://img.shields.io/badge/Generic-OpenAI%20compatible-8A2BE2)](#)

<br>

[✨ Features](#features) · [⚡ Install](#install) · [🔧 Config](#config) · [🎛️ Commands](#commands) · [🧰 Tools](#tools) · [🏗️ Architecture](#architecture) · [🎬 Demo](#demo) · [🧪 Tests](#tests) · [🛡️ Security](#security) · [⚖️ License](#license)

</div>

---

<a id="features"></a>
## ✨ Features

DeepSeek Harness currently lacks cross-model collaboration. This plugin builds a "bridge" for it — delegate code review or complex tasks to an external model from inside a session, then bring its judgment back into the current session.

<table>
<tr><td align="left">

🔍 &nbsp;Read-only **second-opinion review** — style, logic, potential bugs, security; never mutates session state<br>
⚔️ &nbsp;**Adversarial review** — challenge design decisions, architecture assumptions, boundary conditions and error handling with 5–10 "soul-searching" questions<br>
🛟 &nbsp;**Task delegation / rescue** — bundle conversation history + task, inject the result back as plugin context<br>
⏳ &nbsp;**Non-blocking background jobs** — `status` / `result` / `cancel` on top of `ctx.jobs`<br>
🧩 &nbsp;**Model-facing tools** — `ai_bridge_review` / `ai_bridge_delegate` so the agent can ask for help on its own

</td></tr>
</table>

| Capability | Trigger | Description |
|------|---------|------|
| Second-opinion review | `/bridge review <file\|code>` | Read-only review, runs as a non-blocking background job |
| Adversarial review | `/bridge adversarial-review <file\|code>` | 5–10 challenging questions |
| Task delegation / rescue | `/bridge rescue <task>` | History + task → external model → injected result |
| Job status | `/bridge status` | List bridge background jobs |
| Read result | `/bridge result <job-id>` | Read a finished job's output |
| Cancel job | `/bridge cancel <job-id>` | Cancel a running job |

---

<a id="install"></a>
## ⚡ Install

```sh
# One command installs and auto-mounts the plugin (via dsh.bundle.patch).
dsh plugin --profile <profile-name> add dsh-plugin-ai-bridge

# Restart the profile, then type:
/bridge help
```

Then override the config in the profile's `cordis.patch.yml` (see "Config" below):

```yaml
- id: ai-bridge
  config:
    provider: generic
    baseUrl: https://your-relay.example.com/v1
    defaultModel: gpt-5.4
    apiKey: sk-...
```

> No manual `insert` is needed — the plugin mounts itself through `dsh.bundle.patch`. You can also use only env vars (`BRIDGE_API_KEY` / `BRIDGE_BASE_URL` / `BRIDGE_MODEL`).
>
> If you previously mounted it with a manual `insert`, remove that block to avoid double-mounting. To install from source: `npm run build`, then link `lib/` into the profile's `node_modules/dsh-plugin-ai-bridge`.

---

<a id="config"></a>
## 🔧 Config

Plugin config lives in the profile's `cordis.patch.yml` (environment variables act as fallbacks).

| Key | Default | Description |
|---|---|---|
| `apiKey` | `''` | External-model API key |
| `baseUrl` | per provider | Endpoint base URL (OpenAI-compatible URLs include `/v1`; Anthropic URLs do not) |
| `provider` | `openai` | `openai` (GPT, Chat Completions) · `codex` (Responses API) · `anthropic` (Claude) · `generic` (any OpenAI-compatible relay) |
| `defaultModel` | `gpt-5-codex` | Default model id (the "deep" model) |
| `fastModel` | same as `defaultModel` | Cheap/fast model for `--fast` and auto escalation. Empty falls back to the deep model (single-model installs keep working) |
| `deepModel` | same as `defaultModel` | Authoritative/deep model. Empty falls back to `defaultModel` → `BRIDGE_MODEL` → provider default |
| `timeoutMs` | `120000` | Per-request timeout (milliseconds) |
| `maxOutputTokens` | `4000` | Maximum output tokens per call |
| `cacheTtlMs` | `600000` | Dedup cache TTL (ms): identical requests reuse the previous answer within this window. `0` disables |
| `threadCompressAfter` | `8` | Summarize earlier rescue-thread turns with `fastModel` once the thread exceeds this many messages. `0` disables |
| `injectRescueResult` | `false` | Auto-inject rescue results back into the session (marked untrusted); when `false`, read them via `/bridge result` |
| `reviewGate` | `false` | Enable the opt-in review gate that reviews the agent response before a turn stops (can loop and consume quota) |
| `threadsDir` | `~/.dsh-plugin-ai-bridge` | Directory that persists rescue threads |

<details>
<summary><b>🔵 Example 1: GPT (Chat Completions)</b></summary>

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
<summary><b>⚫ Example 2: Codex (Responses API)</b></summary>

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
<summary><b>🟤 Example 3: Claude (Anthropic)</b></summary>

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
<summary><b>🟣 Example 4: Custom OpenAI-compatible gateway</b></summary>

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

### 🔌 Relay gateways (cc-switch)

The plugin supports any relay gateway through `baseUrl`. If you use [cc-switch](https://github.com/farion1231/cc-switch) to route Claude / Codex through a relay, fill in the same "relay URL + token + model name":

| Scenario | `provider` | `baseUrl` | `defaultModel` |
|----------|-----------|-----------|----------------|
| Codex (Chat Completions relay) | `generic` | `https://<relay>/v1` | the model name your relay expects |
| Codex (Responses API relay) | `codex` | `https://<relay>/v1` | the model name your relay expects |
| Claude (Anthropic relay) | `anthropic` | `https://<relay>` | the model name your relay expects |

> ⚠️ cc-switch writes to Claude Code / Codex CLI config files, which do not automatically flow into the DSH process. Either repeat the same relay credentials in the config above, or export cc-switch-style environment variables (below) — the plugin reads them as fallbacks.

### 🔑 Environment fallbacks

When `cordis.patch.yml` omits a value, it is read from the environment in this priority order:

- **API key**: `BRIDGE_API_KEY` → `ANTHROPIC_AUTH_TOKEN` (anthropic only) → `ANTHROPIC_API_KEY` (anthropic only) → `OPENAI_API_KEY`
- **baseUrl**: `BRIDGE_BASE_URL` → `ANTHROPIC_BASE_URL` (anthropic only) / `OPENAI_BASE_URL` (others)
- **model**: `BRIDGE_MODEL`

> So if your shell already exports the cc-switch-style `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `OPENAI_BASE_URL` / `OPENAI_API_KEY`, this plugin reuses them directly.

---

<a id="commands"></a>
## 🎛️ Commands

> DSH command names only allow `[a-z][a-z0-9_-]*` (no `:`). The six operations are therefore implemented as **subcommands** of a single `/bridge` command:

| Requested command | Actual trigger |
|---|---|
| `/bridge:review [file path or code snippet]` | `/bridge review [--fast\|--deep\|--auto] [--model <m>] <file\|code>` |
| `/bridge:adversarial-review [...]` | `/bridge adversarial-review [--fast\|--deep\|--auto] <file\|code>` |
| `/bridge:rescue [task description]` | `/bridge rescue [--full] <task>` |
| `/bridge:status` | `/bridge status` |
| `/bridge:result [job-id]` | `/bridge result <job-id>` |
| `/bridge:cancel [job-id]` | `/bridge cancel <job-id>` |

### 🔍 `/bridge review [--fast|--deep|--auto] [--model <m>] <file|code>`

Read-only review. `file` may be an absolute path or one relative to the current session's working directory; otherwise the input is treated as a code snippet.

**Model tier** (the cost-efficiency switch):

- `--deep` (default) → review with `deepModel` (best quality);
- `--fast` → review with `fastModel` (cheapest);
- `--auto` → review with `fastModel` first, and escalate to `deepModel` only when it outputs `CONFIDENCE: low` (or a missing/ambiguous marker). A single-model install collapses all three to one call.

```
/bridge review src/index.ts
/bridge review function add(a, b) { return a - b }
/bridge review --fast src/a.ts
/bridge review --auto src/a.ts
```

`review` and `adversarial-review` run as **background jobs** (non-blocking), returning an `ai-bridge-N` job id immediately; read the result with `/bridge result <id>`.

### ⚔️ `/bridge adversarial-review [--fast|--deep|--auto] <file|code>`

Adversarial review, producing 5–10 "soul-searching" questions. Supports the same review targets and model tiers as `review`.

### 🛟 `/bridge rescue [--full] <task>`

Bundles the task + current conversation history (last 200 messages, up to 60k chars) and delegates them to the external model. **By default only user/assistant text is sent, with common secret shapes redacted**; add `--full` to also include tool calls/results and reasoning (may contain secrets). By default (`injectRescueResult: false`) the result is **not** auto-injected — read it via `/bridge result <id>`; when injection is enabled, it is marked `[bridge rescue result — UNTRUSTED EXTERNAL OUTPUT]`.

Long threads are compressed: once a thread exceeds `threadCompressAfter` messages, earlier turns are summarized with `fastModel` and only the summary plus the most recent turns are sent verbatim to the deep model (skipped automatically on single-model installs).

### ⏳ Job management

```
/bridge status             # list bridge background jobs
/bridge result <job-id>    # read a finished result; running jobs prompt you to wait
/bridge cancel <job-id>    # cancel a running job
```

---

<a id="tools"></a>
## 🧰 Model-facing tools

The plugin also registers two tools so the DeepSeek Harness agent can use them proactively without human input:

| Tool | Parameters | Description |
|------|------|------|
| `ai_bridge_review` | `code` (required) · `adversarial?` · `mode?` (`fast`/`deep`/`auto`) | Send code (or a file path) to an external model for a read-only review; `mode` selects the model tier |
| `ai_bridge_delegate` | `task` (required) · `include_history?` | Delegate a task (optionally with conversation history) and return its continuation |

---

<a id="architecture"></a>
## 🏗️ Architecture

Dependency injection: `inject = ['commands', 'jobs', 'tools']`; `apply()` attaches the background-job controller via `ctx.jobs.attachController('ai-bridge')`.

| File | Responsibility |
|------|------|
| `src/index.ts` | Plugin entry: `name` / `inject` / `Config` / `apply` |
| `src/client.ts` | External-model HTTP client (OpenAI-compatible + Anthropic, streaming/non-streaming, dedup cache) |
| `src/cache.ts` | Request-hash de-duplication cache (TTL + LRU eviction) |
| `src/router.ts` | Model-tier routing (fast/deep/auto) + thread-history compression |
| `src/prompts.ts` | review / adversarial / rescue / confidence / summary system prompts |
| `src/context.ts` | File reading and conversation-history serialization |
| `src/jobs.ts` | `ctx.jobs` background-job wrapper + `JobKindMap` extension (`ai-bridge`) |
| `src/commands.ts` | `/bridge` command registration and subcommand dispatch |
| `src/tools.ts` | Model-facing tool registration |

```
src/
├── index.ts     # entry: name / inject / Config / apply
├── client.ts    # external-model client (OpenAI-compatible + Anthropic)
├── cache.ts     # request de-duplication cache
├── router.ts    # model-tier routing + thread compression
├── prompts.ts   # system prompts
├── context.ts   # file reading + history serialization
├── jobs.ts      # ctx.jobs background jobs + JobKind extension
├── commands.ts  # /bridge command dispatch
└── tools.ts     # ai_bridge_review / ai_bridge_delegate
```

---

<a id="demo"></a>
## 🎬 Demo

```
User ❯ /bridge review src/index.ts

Bridge ❯ Started review as background job ai-bridge-1.
         Check progress: /bridge status
         Get result:     /bridge result ai-bridge-1

User ❯ /bridge status

Bridge ❯ ai-bridge-1 [ai-bridge] running — bridge review src/index.ts

User ❯ /bridge result ai-bridge-1

Bridge ❯ [style] Naming is clear, but the magic number at index.ts:42 should be a constant
         [logic] parseArgs does not short-circuit on empty input — possible null dereference
         [security] User input is concatenated into a template string; escape it
         ...

User ❯ /bridge rescue fix the failing test

Bridge ❯ Delegated rescue task as background job ai-bridge-2.
         The result will be injected back into this session when ready.

Bridge ❯ [bridge rescue result]
         Found the root cause: ... apply the following fixes in order ...
```

> Record as `demo.gif` with [`terminalizer`](https://github.com/faressoft/terminalizer) or [`asciinema`](https://asciinema.org).

---

<a id="tests"></a>
## 🧪 Tests

```sh
npm install        # install dependencies
npm run typecheck  # type check
npm run build      # compile to lib/
npm test           # build and run the tests
```

| Test file | Coverage |
|---------|------|
| `test/client.test.mjs` | API client against a local mock server (OpenAI/Anthropic, streaming/non-streaming, error handling) |
| `test/context.test.mjs` | File reading and history serialization |
| `test/commands.test.mjs` | End-to-end behavior of the six subcommands (background jobs, rescue injection) |
| `test/integration.test.mjs` | Loads the plugin with the **real `CommandRuntime`** and executes `/bridge` |
| `test/smoke.test.mjs` | Plugin object shape and registration |

---

<a id="security"></a>

## 🛡️ Security & data boundaries

This plugin sends content to the configured `baseUrl` (an external model or relay). Know these boundaries:

- **File paths**: only workspace-relative paths are allowed; absolute paths, `../` traversal, and symlinks pointing outside the workspace are rejected. Files are size-checked (300 KB cap) *before* being read.
- **Code review**: `/bridge review` / `ai_bridge_review` send only the file or inline code you specify.
- **Task delegation**: `/bridge rescue` and `ai_bridge_delegate` send only user/assistant text by default, with common secret shapes redacted; reasoning and tool results are sent only with `--full` (or `include_tool_results`).
- **External output**: rescue results are marked "untrusted external output" for reference only; do not execute commands or instructions from them. By default (`injectRescueResult: false`) results are *not* auto-injected — read them via `/bridge result`.

---

<a id="license"></a>
## ⚖️ License & compliance

> **This plugin is inspired by OpenAI's `codex-plugin-cc` and is an independent implementation, not affiliated with OpenAI.**
>
> `codex-plugin-cc` (Copyright OpenAI and its contributors) is licensed under [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0). This plugin only draws on its design ideas as an independent implementation; it contains, copies, or derives no source code from it, and has no affiliation with, endorsement by, or sponsorship from OpenAI.
>
> See [`NOTICE`](./NOTICE) in the repository root.

## 📄 License

[Apache-2.0](./LICENSE) · third-party notices in [`NOTICE`](./NOTICE).

---

<div align="center">

Made with 🧡 for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) community · Inspired by OpenAI `codex-plugin-cc` (independent implementation)

</div>
