/**
 * Model-tier routing and thread-history compression.
 *
 * Three review tiers map one human intention onto possibly-different models:
 *  - `fast`: the cheap model does the review (lowest cost, lower ceiling),
 *  - `deep`: the authoritative model does the review (default, best quality),
 *  - `auto`: the cheap model reviews first and, only when it flags low
 *    confidence, the review is re-run on the deep model.
 *
 * A single-model install degrades gracefully: `fastModel` falls back to the
 * deep model, and `auto` collapses to one call. Long rescue threads are
 * compressed by summarizing earlier turns with the cheap model, keeping only
 * the last turns verbatim for the deep model.
 *
 * @module dsh-plugin-ai-bridge/router
 */
import type { BridgeClientConfig, ChatMessage, ExternalCall } from './client.js'
import { callExternalModel, callExternalModelDetailed } from './client.js'
import { CONFIDENCE_INSTRUCTION, SUMMARIZE_SYSTEM_PROMPT } from './prompts.js'

/** A bridge config that also carries the (possibly equal) fast-tier model. */
export type RouterConfig = BridgeClientConfig & { fastModel: string }

export type ReviewTier = 'fast' | 'deep' | 'auto'

export interface ReviewCallOptions {
  signal?: AbortSignal
  onDelta?: (delta: string) => void
}

/** Parse the trailing `CONFIDENCE: high|low` marker the fast tier emits. */
export function parseConfidence(text: string): 'high' | 'low' | 'unknown' {
  const matches = [...text.matchAll(/CONFIDENCE:\s*(high|low)/gi)]
  const last = matches[matches.length - 1]
  if (!last) return 'unknown'
  return last[1].toLowerCase() === 'low' ? 'low' : 'high'
}

/** Remove the confidence marker lines from a fast-tier review body. */
export function stripConfidence(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*CONFIDENCE:\s*(high|low)\s*$/i.test(line))
    .join('\n')
    .trim()
}

/**
 * Run a review according to `tier`.
 *
 * `--auto` first asks the fast model for a full review with a confidence
 * marker appended; on `high` its (marker-stripped) answer is returned, on
 * `low` (or a missing/ambiguous marker) the deep model re-reviews and its
 * answer wins. When the fast and deep models are the same, auto runs once.
 */
export async function callReview(
  call: ExternalCall,
  config: RouterConfig,
  opts: ReviewCallOptions = {},
  tier: ReviewTier = 'deep',
  modelOverride?: string,
): Promise<string> {
  if (tier === 'fast') {
    return callExternalModel(call, { ...config, model: modelOverride ?? config.fastModel }, opts)
  }
  if (tier === 'deep') {
    return callExternalModel(call, { ...config, model: modelOverride ?? config.model }, opts)
  }
  const fastModel = modelOverride ?? config.fastModel
  const deepModel = modelOverride ?? config.model
  if (fastModel === deepModel) {
    return callExternalModel(call, { ...config, model: deepModel }, opts)
  }
  const fastResult = await callExternalModelDetailed(
    { system: `${call.system ?? ''}\n${CONFIDENCE_INSTRUCTION}`, messages: call.messages },
    { ...config, model: fastModel },
    { signal: opts.signal },
  )
  const confidence = parseConfidence(fastResult.text)
  if (confidence === 'low' || confidence === 'unknown') {
    return callExternalModel(call, { ...config, model: deepModel }, opts)
  }
  return stripConfidence(fastResult.text)
}

/** How many of the newest messages are kept verbatim when compressing. */
export const KEEP_RECENT_TURNS = 2

function serializeTurns(messages: ChatMessage[]): string {
  return messages.map((m) => `[${m.role}] ${m.content}`).join('\n\n')
}

/**
 * Compress a rescue thread by summarizing earlier turns with the fast model.
 *
 * No-op (returns `messages` unchanged) when: there are too few turns, the
 * fast/deep models are identical (a single-model install — compression would
 * only add cost), or the summarization call itself fails (best-effort: a
 * failed compression must never block the rescue).
 */
export async function maybeCompressThread(
  messages: ChatMessage[],
  config: RouterConfig,
  signal?: AbortSignal,
  afterTurns?: number,
): Promise<ChatMessage[]> {
  const threshold = afterTurns ?? Number.POSITIVE_INFINITY
  if (threshold <= 0 || config.fastModel === config.model || messages.length <= threshold) {
    return messages
  }
  const old = messages.slice(0, messages.length - KEEP_RECENT_TURNS)
  const recent = messages.slice(messages.length - KEEP_RECENT_TURNS)
  if (old.length === 0) return messages
  try {
    const summary = await callExternalModel(
      { system: SUMMARIZE_SYSTEM_PROMPT, messages: [{ role: 'user', content: serializeTurns(old) }] },
      { ...config, model: config.fastModel },
      { signal },
    )
    const block = [
      '## Conversation summary (earlier turns)',
      summary.trim(),
      '',
      '## Recent turns (verbatim)',
    ].join('\n')
    return [{ role: 'user', content: block }, ...recent]
  } catch {
    return messages
  }
}
