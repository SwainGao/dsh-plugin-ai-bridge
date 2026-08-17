/**
 * dsh-plugin-ai-bridge
 *
 * A DeepSeek Harness plugin that bridges to external AI models (Codex, Claude,
 * GPT, and any OpenAI-compatible endpoint) for:
 *   - read-only second-opinion code review (incl. git diff / branch review),
 *   - adversarial review (5-10 challenging questions),
 *   - task delegation / "rescue" with conversation context + resume threads,
 *   - non-blocking background-job management (status / result / cancel),
 *   - an opt-in review gate over the agent's turn-stopping boundary.
 *
 * Entry point. Exports the Cordis object-plugin shape (`name`, `inject`,
 * `Config`, `apply`) consumed by the DSH plugin loader.
 *
 * @module dsh-plugin-ai-bridge
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { BridgeClientConfig, BridgeProvider } from './client.js'
import { ResponseCache } from './cache.js'
import { registerReviewGate } from './gate.js'
import { registerBridgeCommand } from './commands.js'
import { ThreadStore } from './threads.js'
import { registerBridgeTools } from './tools.js'

export const name = 'ai-bridge'
export const inject = ['commands', 'jobs', 'tools']

export interface ConfigShape {
  apiKey?: string
  baseUrl?: string
  provider?: BridgeProvider
  defaultModel?: string
  /** Cheap/fast model for `--fast` and auto escalation. Empty falls back to the deep model. */
  fastModel?: string
  /** Authoritative/deep model. Empty falls back to defaultModel, then BRIDGE_MODEL, then a provider default. */
  deepModel?: string
  timeoutMs?: number
  maxOutputTokens?: number
  /** Dedup cache TTL in ms; identical requests within this window reuse the previous answer. 0 disables. */
  cacheTtlMs?: number
  /** Summarize earlier rescue-thread turns with the fast model once the thread exceeds this many messages. 0 disables. */
  threadCompressAfter?: number
  /** Auto-inject rescue results back into the session (marked untrusted). */
  injectRescueResult?: boolean
  /** Enable the opt-in review gate (agent/turn-stopping hook). */
  reviewGate?: boolean
  /** Directory that persists rescue threads. */
  threadsDir?: string
}

/** Resolved runtime config: the client fields plus plugin behavior flags. */
export interface ResolvedBridgeConfig extends BridgeClientConfig {
  fastModel: string
  cacheTtlMs: number
  threadCompressAfter: number
  injectRescueResult: boolean
  reviewGate: boolean
  threadsDir: string
}

/** Configuration schema, validated against the profile's `cordis.patch.yml`. */
export const Config = z.object({
  apiKey: z
    .string()
    .description('API key for the external model provider.')
    .default(''),
  baseUrl: z
    .string()
    .description('Provider base URL. OpenAI-compatible URLs include /v1; Anthropic URLs do not.')
    .default(''),
  provider: z
    .union(['openai', 'codex', 'anthropic', 'generic'])
    .description('Wire protocol: openai (Chat Completions), codex (Responses API), anthropic (Claude), or generic OpenAI-compatible.')
    .default('openai'),
  defaultModel: z
    .string()
    .description('Default external model id. Empty falls back to BRIDGE_MODEL, then a provider-specific default.')
    .default(''),
  fastModel: z
    .string()
    .description('Cheap/fast model for --fast and auto escalation. Empty falls back to the deep model, so single-model installs keep working.')
    .default(''),
  deepModel: z
    .string()
    .description('Authoritative/deep model. Empty falls back to defaultModel, then BRIDGE_MODEL, then a provider-specific default.')
    .default(''),
  timeoutMs: z
    .number()
    .min(1000)
    .description('Per-request timeout in milliseconds.')
    .default(120_000),
  maxOutputTokens: z
    .number()
    .min(1)
    .description('Maximum output tokens per call.')
    .default(4000),
  cacheTtlMs: z
    .number()
    .min(0)
    .description('Dedup cache TTL in milliseconds; identical requests within this window reuse the previous answer. 0 disables.')
    .default(600_000),
  threadCompressAfter: z
    .number()
    .min(0)
    .description('Summarize earlier rescue-thread turns with the fast model once the thread exceeds this many messages. 0 disables.')
    .default(8),
  injectRescueResult: z
    .boolean()
    .description('Auto-inject rescue results back into the session (marked untrusted). When false, results are only read via /bridge result.')
    .default(false),
  reviewGate: z
    .boolean()
    .description('Enable the opt-in review gate that reviews the agent response before a turn stops. Can loop and consume quota.')
    .default(false),
  threadsDir: z
    .string()
    .description('Directory that persists rescue threads. Empty defaults to ~/.dsh-plugin-ai-bridge.')
    .default(''),
})

export function resolveConfig(config: ConfigShape): ResolvedBridgeConfig {
  const provider = config.provider ?? 'openai'
  const isAnthropic = provider === 'anthropic'
  const apiKey = config.apiKey
    || process.env.BRIDGE_API_KEY
    || (isAnthropic ? process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '' : '')
    || process.env.OPENAI_API_KEY
    || ''
  const defaultBaseUrl = isAnthropic ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'
  const providerDefaultModel = isAnthropic ? 'claude-sonnet-4-5' : 'gpt-5-codex'
  // Deep model resolution: deepModel > defaultModel > BRIDGE_MODEL > provider default.
  const deepModel = config.deepModel
    || config.defaultModel
    || process.env.BRIDGE_MODEL
    || providerDefaultModel
  // Fast model falls back to the deep model, so a single-model install degrades
  // gracefully (fast/deep/auto all hit the one configured model).
  const fastModel = config.fastModel
    || process.env.BRIDGE_FAST_MODEL
    || deepModel
  // Honor the env vars that cc-switch / relay tooling conventionally exports:
  // ANTHROPIC_BASE_URL (Claude) and OPENAI_BASE_URL (Codex/GPT), under BRIDGE_BASE_URL.
  const envBaseUrl = isAnthropic ? process.env.ANTHROPIC_BASE_URL : process.env.OPENAI_BASE_URL
  const threadsDir = config.threadsDir
    || process.env.DSH_BRIDGE_THREADS_DIR
    || join(process.env.DSH_HOME || homedir(), '.dsh-plugin-ai-bridge')
  const cacheTtlMs = config.cacheTtlMs ?? 600_000
  const threadCompressAfter = config.threadCompressAfter ?? 8
  return {
    apiKey,
    baseUrl: config.baseUrl || process.env.BRIDGE_BASE_URL || envBaseUrl || defaultBaseUrl,
    provider,
    model: deepModel,
    fastModel,
    timeoutMs: config.timeoutMs ?? 120_000,
    maxOutputTokens: config.maxOutputTokens ?? 4000,
    cache: new ResponseCache(cacheTtlMs),
    cacheTtlMs,
    threadCompressAfter,
    injectRescueResult: config.injectRescueResult ?? false,
    reviewGate: config.reviewGate ?? false,
    threadsDir,
  }
}

export function apply(ctx: Context, config: ConfigShape = {}): void {
  const resolved = resolveConfig(config)
  // `ctx.jobs.start` refuses owners no attached controller serves; attach ours.
  ctx.jobs.attachController('ai-bridge')
  const store = new ThreadStore(join(resolved.threadsDir, 'threads.json'))
  registerBridgeCommand(ctx, resolved, store)
  registerBridgeTools(ctx, resolved)
  registerReviewGate(ctx, resolved)
}
