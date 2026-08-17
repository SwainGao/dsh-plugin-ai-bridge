/**
 * Model-facing tools, so the DeepSeek Harness agent itself can request a
 * second opinion or delegate work to an external model without a human typing
 * a slash command.
 *
 * File access is containment-checked (`file_path` is workspace-relative only),
 * and transcripts exclude reasoning/tool results by default.
 *
 * @module dsh-plugin-ai-bridge/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { callExternalModel } from './client.js'
import { MAX_INLINE_CHARS, readContainedFile, redactSecrets, serializeMessages } from './context.js'
import { callReview, type RouterConfig, type ReviewTier } from './router.js'
import {
  ADVERSARIAL_SYSTEM_PROMPT,
  REVIEW_SYSTEM_PROMPT,
  RESCUE_SYSTEM_PROMPT,
  buildRescueUser,
} from './prompts.js'

/** Register the model-facing bridge tools. */
export function registerBridgeTools(ctx: Context, config: RouterConfig): void {
  ctx.tools.register(defineTool({
    name: 'ai_bridge_review',
    description:
      'Send code to an external AI model for a read-only review (style, logic, bugs, security). Never modifies files.',
    parameters: {
      code: {
        type: 'string',
        description: 'Inline code to review. Use when the code is short.',
      },
      file_path: {
        type: 'string',
        description: 'Workspace-relative path to a file to review, instead of inline code.',
      },
      adversarial: {
        type: 'boolean',
        description: 'When true, produce an adversarial review (5-10 challenging questions) instead of a standard review.',
      },
      mode: {
        type: 'string',
        enum: ['fast', 'deep', 'auto'],
        description: 'Model tier: deep (default) = authoritative model; fast = cheap model; auto = cheap first, escalate to deep on low confidence.',
      },
      raw: {
        type: 'boolean',
        description: 'When true, skip secret redaction on the reviewed content.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const root = exec.agent?.session.header.cwd ?? process.cwd()
      let code: string
      if (args.file_path) {
        code = await readContainedFile(args.file_path, root)
      } else if (args.code) {
        if (args.code.length > MAX_INLINE_CHARS) {
          throw new Error(`inline code exceeds ${MAX_INLINE_CHARS} characters`)
        }
        code = args.code
      } else {
        throw new Error('provide either `code` or `file_path`')
      }
      // Redact obvious secrets by default; `raw: true` opts out.
      if (!args.raw) code = redactSecrets(code)
      const system = args.adversarial ? ADVERSARIAL_SYSTEM_PROMPT : REVIEW_SYSTEM_PROMPT
      const tier: ReviewTier = args.mode === 'fast' || args.mode === 'auto' ? args.mode : 'deep'
      return callReview(
        { system, messages: [{ role: 'user', content: code }] },
        config,
        { signal: exec.signal },
        tier,
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
        description: 'Include this conversation history (user/assistant text) as delegation context.',
      },
      include_tool_results: {
        type: 'boolean',
        description: 'Also include tool calls/results and reasoning (may contain secrets).',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const transcript = args.include_history && exec.agent
        ? serializeMessages(exec.agent.session.deriveMessages(), {
            includeReasoning: args.include_tool_results,
            includeToolResults: args.include_tool_results,
          })
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
