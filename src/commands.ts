/**
 * The human-facing `/bridge` slash command.
 *
 * DSH command names are restricted to `/^[a-z][a-z0-9_-]*$/`, so the six
 * requested operations are dispatched as subcommands of a single `/bridge`
 * command rather than as `bridge:review` etc. The mapping is:
 *
 *   /bridge review <file|code>          ~  /bridge:review
 *   /bridge adversarial-review <file|code> ~ /bridge:adversarial-review
 *   /bridge rescue <task>               ~  /bridge:rescue
 *   /bridge status                      ~  /bridge:status
 *   /bridge result <job-id>             ~  /bridge:result
 *   /bridge cancel <job-id>             ~  /bridge:cancel
 *
 * @module dsh-plugin-ai-bridge/commands
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { BridgeClientConfig } from './client.js'
import { callExternalModel } from './client.js'
import { readReviewTarget, serializeMessages } from './context.js'
import { errorMessage, startBridgeJob } from './jobs.js'
import {
  ADVERSARIAL_SYSTEM_PROMPT,
  REVIEW_SYSTEM_PROMPT,
  RESCUE_SYSTEM_PROMPT,
  buildRescueUser,
} from './prompts.js'

export const BRIDGE_COMMAND_NAME = 'bridge'
export const BRIDGE_PLUGIN_ID = 'ai-bridge'

const USAGE = [
  'AI bridge: delegate to external models (Codex, Claude, GPT, \u2026).',
  '',
  'Usage:',
  '  /bridge review <file|code>             read-only code review by an external model',
  '  /bridge adversarial-review <file|code> 5-10 challenging questions about the code',
  '  /bridge rescue <task>                  delegate task + history, inject the result',
  '  /bridge status                         list bridge background jobs',
  '  /bridge result <job-id>                read a finished job result',
  '  /bridge cancel <job-id>                cancel a running job',
].join('\n')

function missingApiKey(): CommandResult {
  return {
    kind: 'error',
    text: 'No external-model API key configured. Set `ai-bridge.apiKey` in cordis.patch.yml, or set BRIDGE_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY.',
  }
}

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}\u2026` : text
}

function startReview(
  ctx: Context,
  config: BridgeClientConfig,
  agent: Agent,
  arg: string,
  mode: 'review' | 'adversarial',
): CommandResult {
  if (!arg) {
    return { kind: 'error', text: `No file path or code provided.\nUsage: /bridge ${mode} <file|code>` }
  }
  if (!config.apiKey) return missingApiKey()
  const jobId = startBridgeJob(ctx, agent, {
    kind: mode,
    label: `bridge ${mode} ${truncate(arg, 80)}`,
    run: async (signal) => {
      const code = await readReviewTarget(arg, agent.session.header.cwd)
      const system = mode === 'adversarial' ? ADVERSARIAL_SYSTEM_PROMPT : REVIEW_SYSTEM_PROMPT
      return callExternalModel({ system, messages: [{ role: 'user', content: code }] }, config, { signal })
    },
  })
  return {
    kind: 'success',
    text: [
      `Started ${mode} as background job ${jobId}.`,
      `Check progress: /bridge status`,
      `Get result:     /bridge result ${jobId}`,
    ].join('\n'),
  }
}

function startRescue(ctx: Context, config: BridgeClientConfig, agent: Agent, arg: string): CommandResult {
  if (!arg) {
    return { kind: 'error', text: 'No task description provided.\nUsage: /bridge rescue <task>' }
  }
  if (!config.apiKey) return missingApiKey()
  const jobId = startBridgeJob(ctx, agent, {
    kind: 'rescue',
    label: `bridge rescue ${truncate(arg, 80)}`,
    run: async (signal) => {
      const transcript = serializeMessages(agent.session.deriveMessages())
      const content = buildRescueUser(arg, transcript)
      return callExternalModel(
        { system: RESCUE_SYSTEM_PROMPT, messages: [{ role: 'user', content }] },
        config,
        { signal },
      )
    },
    onDone: (text) => injectRescueResult(agent, text),
  })
  return {
    kind: 'success',
    text: [
      `Delegated rescue task as background job ${jobId}.`,
      'The result will be injected back into this session when ready.',
      `Check progress: /bridge status`,
    ].join('\n'),
  }
}

/** Inject the delegated rescue result as plugin-sourced model-facing context. */
function injectRescueResult(agent: Agent, text: string): void {
  try {
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: `[bridge rescue result]\n\n${text}` }],
      source: { kind: 'plugin', plugin: BRIDGE_PLUGIN_ID, form: 'notice', summary: 'bridge rescue result' },
    }))
  } catch {
    // The agent may already be disposed; injection is best-effort.
  }
}

function showStatus(ctx: Context, agent: Agent): CommandResult {
  const jobs = ctx.jobs.list(agent).filter((job) => job.kind === 'ai-bridge')
  if (jobs.length === 0) return { kind: 'success', text: '(no bridge background jobs)' }
  return {
    kind: 'success',
    text: jobs
      .map((job) => `${job.id} [${job.kind}] ${job.status}${job.detail ? ` (${job.detail})` : ''} \u2014 ${job.label}`)
      .join('\n'),
  }
}

function showResult(ctx: Context, agent: Agent, arg: string): CommandResult {
  if (!arg) return { kind: 'error', text: 'Usage: /bridge result <job-id>' }
  const id = JobId(arg)
  const read = ctx.jobs.read(id, agent)
  const snapshot = read.snapshot
  if (snapshot.status === 'running' || snapshot.status === 'stopping') {
    return { kind: 'success', text: `Job ${id} is still ${snapshot.status}. Check back with /bridge status.` }
  }
  const body = read.text.trim()
  return {
    kind: 'success',
    text: body || `Job ${id} finished (${snapshot.status}${snapshot.detail ? `: ${snapshot.detail}` : ''}) with no output.`,
  }
}

function cancelJob(ctx: Context, agent: Agent, arg: string): CommandResult {
  if (!arg) return { kind: 'error', text: 'Usage: /bridge cancel <job-id>' }
  const id = JobId(arg)
  const outcome = ctx.jobs.kill(id, agent)
  return {
    kind: 'success',
    text: outcome === 'requested' ? `Requested cancellation of job ${id}.` : `Job ${id} already finished.`,
  }
}

/** Register the `/bridge` command for every composed command adapter. */
export function registerBridgeCommand(ctx: Context, config: BridgeClientConfig): void {
  ctx.commands.register({
    name: BRIDGE_COMMAND_NAME,
    description: 'delegate code review and complex tasks to external AI models',
    input: { hint: 'review|adversarial-review|rescue|status|result|cancel' },
    handler: (invocation) => handleBridgeCommand(ctx, config, invocation),
  })
}

/** Resolve one `/bridge` invocation to its command result. Exported for tests. */
export async function handleBridgeCommand(
  ctx: Context,
  config: BridgeClientConfig,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const raw = invocation.rawInput.trim()
  const [sub, ...rest] = raw.split(/\s+/)
  const arg = rest.join(' ').trim()
  const agent = invocation.agent
  try {
    switch (sub) {
      case '':
      case 'help':
        return { kind: 'success', text: USAGE }
      case 'review':
        return startReview(ctx, config, agent, arg, 'review')
      case 'adversarial-review':
        return startReview(ctx, config, agent, arg, 'adversarial')
      case 'rescue':
        return startRescue(ctx, config, agent, arg)
      case 'status':
        return showStatus(ctx, agent)
      case 'result':
        return showResult(ctx, agent, arg)
      case 'cancel':
        return cancelJob(ctx, agent, arg)
      default:
        return { kind: 'error', text: `Unknown /bridge subcommand "${sub || ''}".\n\n${USAGE}` }
    }
  } catch (error) {
    return { kind: 'error', text: errorMessage(error) }
  }
}
