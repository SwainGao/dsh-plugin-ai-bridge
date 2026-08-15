/**
 * Background-job bridge over DSH's `ctx.jobs` registry.
 *
 * Each bridge operation (review, adversarial review, rescue) runs as a
 * final-output background job so the human stays unblocked and can poll
 * `/bridge status` / `/bridge result` or cancel with `/bridge cancel`.
 *
 * @module dsh-plugin-ai-bridge/jobs
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId, type JobOutcome } from '@deepseek-ai/dsh-jobs'

// Extend the merge-extensible job-kind vocabulary with this plugin's kind.
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'ai-bridge': 'ai-bridge'
  }
}

export type BridgeJobKind = 'review' | 'adversarial' | 'rescue'

export interface StartBridgeJobOptions {
  kind: BridgeJobKind
  label: string
  /** Produce the final output text. Receives the job's cancellation signal. */
  run: (signal: AbortSignal) => Promise<string>
  /** Best-effort completion hook (e.g. inject a rescue result into the session). */
  onDone?: (text: string, agent: Agent) => void | Promise<void>
}

/** Normalize an unknown error into a bounded, display-safe message. */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 500 ? `${message.slice(0, 500)}\u2026` : message
}

/**
 * Start a bridge background job owned by `agent`. Returns the registry-issued
 * `<ai-bridge>-N` id. The returned `done` hook never rejects; cancellation is
 * recorded as `killed`, ordinary failure as `failed`.
 */
export function startBridgeJob(ctx: Context, agent: Agent, options: StartBridgeJobOptions): JobId {
  const controller = new AbortController()
  const work = options.run(controller.signal)
  const done: Promise<JobOutcome> = work.then(
    async (text) => {
      if (options.onDone) {
        try {
          await options.onDone(text, agent)
        } catch {
          // Injection is best-effort; a disposed agent must not fail the job.
        }
      }
      const outcome: JobOutcome = {
        status: 'completed',
        output: text,
        detail: `${options.kind} complete`,
      }
      return outcome
    },
    (error) => {
      if (controller.signal.aborted) {
        const outcome: JobOutcome = { status: 'killed', detail: 'cancelled' }
        return outcome
      }
      const outcome: JobOutcome = { status: 'failed', detail: errorMessage(error) }
      return outcome
    },
  )
  return ctx.jobs.start({
    kind: 'ai-bridge',
    label: options.label,
    owner: agent,
    run: () => ({
      cancel: (reason) => controller.abort(reason),
      done,
    }),
  })
}
