/**
 * Model-facing tools, so the DeepSeek Harness agent itself can request a
 * second opinion or delegate work to an external model without a human typing
 * a slash command.
 *
 * @module dsh-plugin-ai-bridge/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { BridgeClientConfig } from './client.js'
import { callExternalModel } from './client.js'
import { readReviewTarget, serializeMessages } from './context.js'
import {
  ADVERSARIAL_SYSTEM_PROMPT,
  REVIEW_SYSTEM_PROMPT,
  RESCUE_SYSTEM_PROMPT,
  buildRescueUser,
} from './prompts.js'

/** Register the model-facing bridge tools. */
export function registerBridgeTools(ctx: Context, config: BridgeClientConfig): void {
  ctx.tools.register(defineTool({
    name: 'ai_bridge_review',
    description:
      'Send code to an external AI model for a read-only review (style, logic, bugs, security). Never modifies files.',
    parameters: {
      code: {
        type: 'string',
        required: true,
        description: 'Code to review, or a path to a file containing the code.',
      },
      adversarial: {
        type: 'boolean',
        description: 'When true, produce an adversarial review (5-10 challenging questions) instead of a standard review.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const code = await readReviewTarget(args.code, exec.agent?.session.header.cwd)
      const system = args.adversarial ? ADVERSARIAL_SYSTEM_PROMPT : REVIEW_SYSTEM_PROMPT
      return callExternalModel(
        { system, messages: [{ role: 'user', content: code }] },
        config,
        { signal: exec.signal },
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ai_bridge_delegate',
    description:
      'Delegate a task (optionally with this conversation history) to an external AI model and return its continuation.',
    parameters: {
      task: {
        type: 'string',
        required: true,
        description: 'The task to delegate to the external model.',
      },
      include_history: {
        type: 'boolean',
        description: 'Include this conversation history as delegation context.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const transcript = args.include_history && exec.agent
        ? serializeMessages(exec.agent.session.deriveMessages())
        : ''
      const content = buildRescueUser(args.task, transcript)
      return callExternalModel(
        { system: RESCUE_SYSTEM_PROMPT, messages: [{ role: 'user', content }] },
        config,
        { signal: exec.signal },
      )
    },
  }))
}
