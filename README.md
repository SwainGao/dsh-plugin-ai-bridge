[**简体中文**](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

<div align="center">

<img src="docs/logo.svg" alt="dsh-plugin-ai-bridge logo" width="128">

# dsh-plugin-ai-bridge

### *让 DeepSeek Harness 与外部 AI 模型无缝协作 —— 第二意见审查 · 对抗性审查 · 任务委托 · 非阻塞后台调度*

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

[✨ 特性](#features) · [⚡ 安装](#install) · [🔧 配置](#config) · [🎛️ 命令](#commands) · [🧰 工具](#tools) · [🏗️ 架构](#architecture) · [🎬 演示](#demo) · [🧪 测试](#tests) · [🛡️ 安全](#security) · [⚖️ 版权](#license)

</div>

---

<a id="features"></a>
## ✨ 特性

DSH 目前缺少跨模型协作能力。本插件为它补上一座「桥」—— 在会话内部即可把代码审查或复杂任务委托给外部模型，再把人家的判断带回当前会话。

<table>
<tr><td align="left">

🔍 &nbsp;只读**第二意见审查** —— 风格、逻辑、潜在 bug、安全性，不改动任何会话状态<br>
⚔️ &nbsp;**对抗性审查** —— 挑战设计决策、架构假设、边界条件与异常处理，5–10 条"灵魂拷问"<br>
🛟 &nbsp;**任务委托 / 救援** —— 打包对话历史 + 任务，结果以插件上下文注入回当前会话<br>
⏳ &nbsp;**非阻塞后台任务** —— 基于 `ctx.jobs` 的 `status` / `result` / `cancel`<br>
💸 &nbsp;**省 token 路由** —— `--fast` / `--deep` / `--auto` 档位 + 请求去重缓存 + 长线程摘要压缩<br>
🧩 &nbsp;**模型可用工具** —— `ai_bridge_review` / `ai_bridge_delegate`，让智能体自己也能主动求教

</td></tr>
</table>

| 能力 | 触发方式 | 说明 |
|------|---------|------|
| 第二意见审查 | `/bridge review <file\|code>` | 只读审查，非阻塞后台运行 |
| 对抗性审查 | `/bridge adversarial-review <file\|code>` | 5–10 条挑战性问题 |
| 任务委托 / 救援 | `/bridge rescue [--full] <task>` | 历史（默认脱敏）+ 任务 → 外部模型 → 注入结果（标记不可信） |
| 任务进度 | `/bridge status` | 列出 bridge 后台任务 |
| 读取结果 | `/bridge result <job-id>` | 读取已完成任务输出 |
| 取消任务 | `/bridge cancel <job-id>` | 取消运行中任务 |

---

<a id="install"></a>
## ⚡ 安装

```sh
# 一条命令安装并自动挂载（通过 dsh.bundle.patch，无需手动 insert）
dsh plugin --profile <profile-name> add dsh-plugin-ai-bridge

# 重启 profile，然后输入：
/bridge help
```

然后在 profile 的 `cordis.patch.yml` 里覆写配置（见下方「配置」）：

```yaml
- id: ai-bridge
  config:
    provider: generic
    baseUrl: https://your-relay.example.com/v1
    defaultModel: gpt-5.4
    apiKey: sk-...
```

> 也可以只用环境变量（`BRIDGE_API_KEY` / `BRIDGE_BASE_URL` / `BRIDGE_MODEL`），连这段配置都省了。
>
> 若之前用旧方式手动 `insert` 挂载过，请删掉那段，避免双挂载。也可以从源码安装：`npm run build` 后把 `lib/` 链接进 profile 的 `node_modules/dsh-plugin-ai-bridge`。

---

<a id="config"></a>
## 🔧 配置

插件配置写入 profile 的 `cordis.patch.yml`（也可用环境变量兜底）。

| 键 | 默认值 | 说明 |
|---|---|---|
| `apiKey` | `''` | 外部模型 API Key |
| `baseUrl` | 按 provider 自动 | 端点基地址（OpenAI 兼容需含 `/v1`；Anthropic 不含） |
| `provider` | `openai` | `openai`（GPT，Chat Completions）· `codex`（Responses API）· `anthropic`（Claude）· `generic`（任意 OpenAI 兼容中转站） |
| `defaultModel` | `gpt-5-codex` | 默认模型 id（即「深」模型） |
| `fastModel` | 同 `defaultModel` | 「快/省」模型 id；`--fast` 与自动升级用。留空则回退到深模型（单模型安装也能用） |
| `deepModel` | 同 `defaultModel` | 「权威/深」模型 id；留空则回退到 `defaultModel` → `BRIDGE_MODEL` → 平台默认 |
| `timeoutMs` | `120000` | 单次请求超时（毫秒） |
| `maxOutputTokens` | `4000` | 单次调用最大输出 token |
| `cacheTtlMs` | `600000` | 去重缓存 TTL（毫秒）：相同请求在此窗口内复用上一次回答。`0` 关闭 |
| `threadCompressAfter` | `8` | rescue 线程超过该消息数时，用 `fastModel` 压缩早先轮次（只保留最近几轮原文）。`0` 关闭 |
| `injectRescueResult` | `false` | 是否把 rescue 结果自动注入回会话（标记不可信）；`false` 时仅用 `/bridge result` 读取 |
| `reviewGate` | `false` | 开启「审查门」：回合结束前自动外部审查并拦截带问题的回答（可能成环、耗额度） |
| `threadsDir` | `~/.dsh-plugin-ai-bridge` | rescue 线程持久化目录 |

<details>
<summary><b>🔵 示例一：GPT（Chat Completions）</b></summary>

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
<summary><b>⚫ 示例二：Codex（Responses API）</b></summary>

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
<summary><b>🟤 示例三：Claude（Anthropic）</b></summary>

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
<summary><b>🟣 示例四：自定义 OpenAI 兼容网关</b></summary>

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

### 🔌 中转站 / Relay（cc-switch）

插件通过 `baseUrl` 支持任意中转站服务。若你用 [cc-switch](https://github.com/farion1231/cc-switch) 把 Claude / Codex 切到中转站，把同样的「中转地址 + Token + 模型名」填进来即可：

| 场景 | `provider` | `baseUrl` | `defaultModel` |
|------|-----------|-----------|----------------|
| Codex（Chat Completions 中转） | `generic` | `https://<中转站>/v1` | 中转站要求的模型名 |
| Codex（Responses API 中转） | `codex` | `https://<中转站>/v1` | 中转站要求的模型名 |
| Claude（Anthropic 中转） | `anthropic` | `https://<中转站>` | 中转站要求的模型名 |

> ⚠️ cc-switch 写的是 Claude Code / Codex CLI **各自**的配置文件，不会自动注入 DSH 进程。要么在上方配置里再填一次同样的中转凭据，要么导出 cc-switch 风格的环境变量（见下方），本插件会自动兜底读取。

### 🔑 环境变量兜底

当 `cordis.patch.yml` 未提供对应值时，按优先级从环境变量读取：

- **API Key**：`BRIDGE_API_KEY` → `ANTHROPIC_AUTH_TOKEN`（仅 anthropic）→ `ANTHROPIC_API_KEY`（仅 anthropic）→ `OPENAI_API_KEY`
- **baseUrl**：`BRIDGE_BASE_URL` → `ANTHROPIC_BASE_URL`（仅 anthropic）/ `OPENAI_BASE_URL`（其他）
- **模型**：`BRIDGE_MODEL`（深模型）· `BRIDGE_FAST_MODEL`（快模型，留空回退到深模型）

> 因此，若你在 shell 里已导出 cc-switch 常见的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `OPENAI_BASE_URL` / `OPENAI_API_KEY`，本插件可直接复用。

---

<a id="commands"></a>
## 🎛️ 命令

> DSH 命令名仅允许 `[a-z][a-z0-9_-]*`（不含 `:`）。因此六个操作以单一 `/bridge` 命令的**子命令**实现：

| 需求中的命令 | 实际触发方式 |
|---|---|
| `/bridge:review [文件路径或代码片段]` | `/bridge review [--base <ref>] [--fast\|--deep\|--auto] [--background\|--wait] [--model <m>] [<file\|code>]` |
| `/bridge:adversarial-review [...]` | `/bridge adversarial-review [--fast\|--deep\|--auto] <file\|code>` |
| `/bridge:rescue [任务描述]` | `/bridge rescue [--full] <task>` |
| `/bridge:status` | `/bridge status` |
| `/bridge:result [job-id]` | `/bridge result <job-id>` |
| `/bridge:cancel [job-id]` | `/bridge cancel <job-id>` |

### 🔍 `/bridge review [--base <ref>] [--fast|--deep|--auto] [--background|--wait] [--model <m>] [<file|code>]`

只读审查。审查目标按优先级：

1. `--base <ref>` → 审查分支差异（`git diff <ref>...HEAD`）；
2. `<file|code>` → 审查指定文件（工作区相对路径）或内联代码；
3. 两者皆无 → 审查未提交改动（`git diff HEAD`）。

**模型档位**（省 token / 性价比的核心开关）：

- `--deep`（默认）→ 用 `deepModel` 审查，质量最高；
- `--fast` → 用 `fastModel` 审查，最省；
- `--auto` → 先用 `fastModel` 审查，仅在它输出 `CONFIDENCE: low`（低置信 / 缺失标记）时才升级到 `deepModel` 重审。单模型安装时三者退化为同一模型，各调用一次。

```
/bridge review                          # 审未提交改动
/bridge review --base main              # 审相对 main 的分支差异
/bridge review src/index.ts             # 审文件
/bridge review --wait function f() {}   # 同步返回结果（默认后台）
/bridge review --fast src/a.ts          # 用快模型，省 token
/bridge review --auto src/a.ts          # 快模型先审，低置信才升级
/bridge review --model gpt-5.5 src/a.ts # 覆盖模型
```

`--background`（默认）立即返回 `ai-bridge-N` 任务 id，用 `/bridge result <id>` 读取；`--wait` 直接内联返回结果。

### ⚔️ `/bridge adversarial-review [--base <ref>] [--fast|--deep|--auto] [--background|--wait] [--model <m>] [<file|code>] [focus...]`

对抗性审查，输出 5–10 条"灵魂拷问"式问题；与 `review` 使用相同的审查目标选择与模型档位，并支持追加 `focus` 关注点文字。

### 🛟 `/bridge rescue [--full] [--resume|--thread <id>] [--background|--wait] [--model <m>] <task>`

打包任务 + 当前会话历史（最近 200 条消息、最多 60k 字符）委托给外部模型。**默认只含用户/助手文本**，并做密钥脱敏；加 `--full` 才额外包含工具调用/结果与推理内容（可能含敏感信息）。

- `--resume` 续跑本仓库最近的 rescue 线程；`--thread <id>` 续跑指定线程。
- `--background`（默认）/`--wait`、`--model <m>` 同 review。
- 线程消息数超过 `threadCompressAfter` 时，早先轮次会用 `fastModel` 压缩成摘要，只把「摘要 + 最近几轮原文」发给深模型，省 token（单模型安装时自动跳过，不额外开销）。
- 结果标记为 `[bridge rescue result — UNTRUSTED EXTERNAL OUTPUT]` 不可信参考；`injectRescueResult: false`（默认）时仅用 `/bridge result <id>` 读取。

### 🔁 `/bridge transfer`

把当前会话打包成一个可续跑的 rescue 线程，返回线程 id 与续跑命令：

```
/bridge transfer
/bridge rescue --thread <id> 继续刚才的任务
```

### ⏳ 任务管理

### ⏳ 任务管理

```
/bridge status             # 列出 bridge 后台任务
/bridge result <job-id>    # 读取已完成结果；运行中会提示等待
/bridge cancel <job-id>    # 取消运行中任务
```

---

<a id="tools"></a>
## 🧰 模型可用工具

插件同时注册两个工具，供 DSH 智能体在无需人工输入的情况下主动使用：

| 工具 | 参数 | 说明 |
|------|------|------|
| `ai_bridge_review` | `code`（必填）· `adversarial?` · `mode?`（`fast`/`deep`/`auto`） | 将代码（或文件路径）发给外部模型做只读审查；`mode` 决定模型档位 |
| `ai_bridge_delegate` | `task`（必填）· `include_history?` | 委托任务（可选携带会话历史）并返回其延续 |

---

<a id="architecture"></a>
## 🏗️ 架构

依赖注入：`inject = ['commands', 'jobs', 'tools']`；`apply()` 中通过 `ctx.jobs.attachController('ai-bridge')` 挂载后台任务控制器。

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 插件入口：`name` / `inject` / `Config` / `apply` |
| `src/client.ts` | 外部模型 HTTP 客户端（OpenAI 兼容 + Anthropic，流式/非流式，去重缓存） |
| `src/cache.ts` | 请求哈希去重缓存（TTL + LRU 淘汰） |
| `src/router.ts` | 模型档位路由（fast/deep/auto）+ 线程历史压缩 |
| `src/prompts.ts` | review / adversarial / rescue / 置信度 / 摘要系统提示词 |
| `src/context.ts` | 文件读取与会话历史序列化 |
| `src/jobs.ts` | `ctx.jobs` 后台任务封装 + `JobKindMap` 扩展（`ai-bridge`） |
| `src/commands.ts` | `/bridge` 命令注册与子命令分发 |
| `src/tools.ts` | 模型可用工具注册 |

```
src/
├── index.ts     # 入口：name / inject / Config / apply
├── client.ts    # 外部模型客户端（OpenAI-compatible + Anthropic）
├── cache.ts     # 请求去重缓存
├── router.ts    # 模型档位路由 + 线程压缩
├── prompts.ts   # 系统提示词
├── context.ts   # 文件读取 + 会话历史序列化
├── jobs.ts      # ctx.jobs 后台任务 + JobKind 扩展
├── commands.ts  # /bridge 命令分发
└── tools.ts     # ai_bridge_review / ai_bridge_delegate
```

---

<a id="demo"></a>
## 🎬 演示

```
User ❯ /bridge review src/index.ts

Bridge ❯ Started review as background job ai-bridge-1.
         Check progress: /bridge status
         Get result:     /bridge result ai-bridge-1

User ❯ /bridge status

Bridge ❯ ai-bridge-1 [ai-bridge] running — bridge review src/index.ts

User ❯ /bridge result ai-bridge-1

Bridge ❯ [风格] 命名清晰，但 index.ts:42 的魔法数字建议提取常量
         [逻辑] parseArgs 在空输入时未短路，存在空指针风险
         [安全] 用户输入直接拼接进模板字符串，建议转义
         ...

User ❯ /bridge rescue 修复失败的测试

Bridge ❯ Delegated rescue task as background job ai-bridge-2.
         The result will be injected back into this session when ready.

Bridge ❯ [bridge rescue result]
         已定位失败原因：……建议按以下顺序修复……
```

> 可用 [`terminalizer`](https://github.com/faressoft/terminalizer) 或 [`asciinema`](https://asciinema.org) 录制为 `demo.gif`。

---

<a id="tests"></a>
## 🧪 测试

```sh
npm install        # 安装依赖
npm run typecheck  # 类型检查
npm run build      # 编译到 lib/
npm test           # 编译并运行测试
```

| 测试文件 | 覆盖 |
|---------|------|
| `test/client.test.mjs` | API 客户端对本地 mock 服务器（OpenAI/Anthropic、流式/非流式、错误处理） |
| `test/context.test.mjs` | 文件读取与会话历史序列化 |
| `test/commands.test.mjs` | 六个子命令端到端行为（后台任务、rescue 注入） |
| `test/integration.test.mjs` | 使用**真实 `CommandRuntime`** 加载插件并执行 `/bridge` |
| `test/smoke.test.mjs` | 插件对象形态、注册、模型默认值与路径越界 |

---

<a id="security"></a>

## 安全与数据外发

本插件会把内容发送到你配置的 `baseUrl`（外部模型或中转站）。请知悉以下边界：

- **文件路径**：仅允许工作区相对路径；绝对路径、`../` 越界、以及指向工作区外的符号链接都会被拒绝。文件在**读取前**先做大小校验（默认上限 300 KB）。
- **代码审查**：`/bridge review` / `ai_bridge_review` 只发送你指定的文件或内联代码。
- **任务委托**：`/bridge rescue` 与 `ai_bridge_delegate` 默认只发送**用户/助手文本**，并对常见密钥形态做脱敏；推理内容与工具结果仅在 `--full`（或 `include_tool_results`）时才会发送。
- **外部输出**：rescue 的结果以「不可信外部输出」标记注入，仅供参考，请勿直接执行其中的指令或代码。

---

<a id="license"></a>
## ⚖️ 版权与合规

> **此插件受 OpenAI `codex-plugin-cc` 启发，为独立实现，与 OpenAI 无关联。**
>
> `codex-plugin-cc`（Copyright OpenAI and its contributors）采用 [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) 许可证。本插件仅参考其设计思路进行独立实现，不包含、不复制、不派生其源代码；与 OpenAI 不存在任何隶属、背书或赞助关系。
>
> 相关声明同时记录于仓库根目录的 [`NOTICE`](./NOTICE)。

## 📄 License

[Apache-2.0](./LICENSE) · 第三方声明见 [`NOTICE`](./NOTICE)。

---

<div align="center">

Made with 🧡 for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) community · Inspired by OpenAI `codex-plugin-cc` (independent implementation)

</div>
