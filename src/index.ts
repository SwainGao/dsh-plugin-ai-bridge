/**
 * dsh-plugin-ai-bridge
 *
 * A DeepSeek Harness plugin that bridges to external AI models (Codex, Claude,
 * GPT, and any OpenAI-compatible endpoint) for:
 *   - read-only second-opinion code review,
 *   - adversarial review (5-10 challenging questions),
 *   - task delegation / "rescue" with conversation context injection,
 *   - non-blocking background-job management (status / result / cancel).
 *
 * Entry point. Exports the Cordis object-plugin shape (`name`, `inject`,
 * `Config`, `apply`) consumed by the DSH plugin loader.
 *
 * @module dsh-plugin-ai-bridge
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { BridgeClientConfig, BridgeProvider } from './client.js'
import { registerBridgeCommand } from './commands.js'
import { registerBridgeTools } from './tools.js'

export const name = 'ai-bridge'
export const inject = ['commands', 'jobs', 'tools']

export interface ConfigShape {
  apiKey?: string
  baseUrl?: string
  provider?: BridgeProvider
  defaultModel?: string
  timeoutMs?: number
  maxOutputTokens?: number
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
    .union(['openai', 'anthropic', 'generic'])
    .description('Wire protocol: openai (Codex/GPT), anthropic (Claude), or generic OpenAI-compatible.')
    .default('openai'),
  defaultModel: z
    .string()
    .description('Default external model id.')
    .default('gpt-5-codex'),
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
})

function resolveConfig(config: ConfigShape): BridgeClientConfig {
  const provider = config.provider ?? 'openai'
  const apiKey = config.apiKey
    || process.env.BRIDGE_API_KEY
    || (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY ?? '' : '')
    || process.env.OPENAI_API_KEY
    || ''
  const defaultBaseUrl = provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'
  const defaultModel = provider === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-5-codex'
  return {
    apiKey,
    baseUrl: config.baseUrl || process.env.BRIDGE_BASE_URL || defaultBaseUrl,
    provider,
    model: config.defaultModel || process.env.BRIDGE_MODEL || defaultModel,
    timeoutMs: config.timeoutMs ?? 120_000,
    maxOutputTokens: config.maxOutputTokens ?? 4000,
  }
}

export function apply(ctx: Context, config: ConfigShape = {}): void {
  const resolved = resolveConfig(config)
  // `ctx.jobs.start` refuses owners no attached controller serves; attach ours.
  ctx.jobs.attachController('ai-bridge')
  registerBridgeCommand(ctx, resolved)
  registerBridgeTools(ctx, resolved)
}
