/**
 * Review gate: an opt-in `agent/turn-stopping` hook that runs a targeted
 * external review of the agent's latest response and steers the turn to keep
 * going when the review flags blocking issues.
 *
 * Off by default (`reviewGate: false`); it can create a long-running
 * review-and-fix loop and consume external-model quota, mirroring the warning
 * in OpenAI's codex-plugin-cc.
 *
 * @module dsh-plugin-ai-bridge/gate
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ResolvedBridgeConfig } from './index.js'
import { callExternalModel } from './client.js'
import { GATE_REVIEW_SYSTEM_PROMPT } from './prompts.js'

/** Maximum characters of the agent's response sent to the gate reviewer. */
export const MAX_GATE_CHARS = 20_000

/** Parse the trailing `VERDICT: PASS` / `VERDICT: FAIL` line from a gate reply. */
export function parseGateVerdict(text: string): 'pass' | 'fail' | 'unknown' {
  const matches = [...text.matchAll(/VERDICT:\s*(PASS|FAIL)/gi)]
  const last = matches[matches.length - 1]
  if (!last) return 'unknown'
  return last[1].toLowerCase() === 'fail' ? 'fail' : 'pass'
}

async function gateReview(text: string, config: ResolvedBridgeConfig, signal: AbortSignal): Promise<'pass' | 'fail' | 'unknown'> {
  const reply = await callExternalModel(
    { system: GATE_REVIEW_SYSTEM_PROMPT, messages: [{ role: 'user', content: text.slice(0, MAX_GATE_CHARS) }] },
    config,
    { signal },
  )
  return parseGateVerdict(reply)
}

/** Register the review gate; a no-op unless `config.reviewGate` is true. */
export function registerReviewGate(ctx: Context, config: ResolvedBridgeConfig): void {
  if (!config.reviewGate) return
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    try {
      const messages = agent.session.deriveMessages()
      const last = [...messages].reverse().find((m) => m.role === 'assistant')
      if (!last) return
      const text = last.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
      if (!text) return
      const verdict = await gateReview(text, config, signal)
      if (verdict === 'fail') {
        agent.steer(createUserMessage({
          content: [{
            type: 'text',
            text: '[bridge review gate] An external reviewer flagged blocking issues in your last response. Fix them before concluding.',
          }],
          source: { kind: 'plugin', plugin: 'ai-bridge', form: 'notice', summary: 'bridge review gate: issues flagged' },
        }))
      }
    } catch {
      // Gate is best-effort; failures must never block the turn.
    }
  })
}
