/**
 * Input resolution and conversation-context extraction.
 *
 * Review commands accept either a file path or an inline code snippet; this
 * module resolves that input against the session's working directory. Rescue
 * and delegation calls serialize the live session's derived message history
 * into a bounded plain-text transcript.
 *
 * @module dsh-plugin-ai-bridge/context
 */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'

/** Maximum file size read into a review request. */
export const MAX_FILE_BYTES = 300_000
/** Maximum number of trailing messages included in a transcript. */
export const MAX_TRANSCRIPT_MESSAGES = 200
/** Maximum character length of a serialized transcript. */
export const MAX_TRANSCRIPT_CHARS = 60_000

export interface TranscriptOptions {
  maxMessages?: number
  maxChars?: number
}

/**
 * Resolve review input to a code string. When `input` names a readable file
 * (relative paths resolve against `cwd`, falling back to `process.cwd()`), the
 * file contents are returned wrapped in a fenced block with a path comment;
 * otherwise the input is treated as an inline code snippet and returned as-is.
 */
export async function readReviewTarget(input: string, cwd?: string): Promise<string> {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('no code or file path provided')
  const candidate = isAbsolute(trimmed) ? trimmed : resolve(cwd ?? process.cwd(), trimmed)
  try {
    const info = await stat(candidate)
    if (info.isFile()) {
      const content = await readFile(candidate, 'utf8')
      const bounded = content.length > MAX_FILE_BYTES
        ? `${content.slice(0, MAX_FILE_BYTES)}\n\u2026(file truncated)`
        : content
      return `\`\`\`\n// File: ${candidate}\n${bounded}\n\`\`\``
    }
  } catch {
    // Not a readable file — fall through and treat the input as a snippet.
  }
  return trimmed
}

function renderBlock(block: ContentBlock): string | null {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return block.text
    case 'tool-call':
      return `[tool call] ${block.name}(${block.arguments})`
    case 'tool-result': {
      const inner = block.content.map(renderBlock).filter((x): x is string => x !== null).join('\n')
      return block.isError ? `[tool error] ${inner}` : `[tool result] ${inner}`
    }
    default:
      // Merge-extensible block vocabulary: skip unknown block kinds safely.
      return null
  }
}

/**
 * Serialize an agent's derived message history into a bounded transcript, one
 * `[role] text` entry per message. Tool calls/results are rendered inline so
 * the external model sees the working state, not just prose.
 */
export function serializeMessages(messages: readonly Message[], options: TranscriptOptions = {}): string {
  const maxMessages = options.maxMessages ?? MAX_TRANSCRIPT_MESSAGES
  const maxChars = options.maxChars ?? MAX_TRANSCRIPT_CHARS
  const recent = messages.slice(-maxMessages)
  const lines: string[] = []
  for (const message of recent) {
    const text = message.content.map(renderBlock).filter((x): x is string => x !== null).join('\n').trim()
    if (!text) continue
    lines.push(`[${message.role}] ${text}`)
  }
  let out = lines.join('\n\n')
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars)}\n\n\u2026(transcript truncated)`
  }
  return out
}
