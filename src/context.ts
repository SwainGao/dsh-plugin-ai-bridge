/**
 * Input resolution and conversation-context extraction.
 *
 * File input is read through a containment-checked helper that rejects absolute
 * paths and any path (including symlinks) that escapes the session's workspace
 * root, and enforces a size cap *before* reading. Rescue/delegation transcripts
 * are bounded, redacted, and by default exclude reasoning and tool results so
 * secrets and private material are not forwarded to third-party endpoints.
 *
 * @module dsh-plugin-ai-bridge/context
 */
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'

/** Maximum file size (bytes) read into a review request; enforced pre-read. */
export const MAX_FILE_BYTES = 300_000
/** Maximum inline-code / task length (chars) accepted without a file. */
export const MAX_INLINE_CHARS = 200_000
/** Maximum number of trailing messages included in a transcript. */
export const MAX_TRANSCRIPT_MESSAGES = 200
/** Maximum character length of a serialized transcript. */
export const MAX_TRANSCRIPT_CHARS = 60_000

export interface TranscriptOptions {
  maxMessages?: number
  maxChars?: number
  /** Include model reasoning/thinking blocks. Default false. */
  includeReasoning?: boolean
  /** Include tool calls and tool results. Default false (may contain secrets). */
  includeToolResults?: boolean
}

/** Best-effort masking of common high-signal credential shapes. */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
]

/** Mask obvious credential shapes in a text. */
export function redactSecrets(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]')
  return out
}

/**
 * Read a workspace-relative file, enforcing (a) rejection of absolute paths,
 * (b) `realpath()` containment within `root` (blocks `..` and symlink escapes),
 * and (c) a size cap checked before the file is read into memory.
 */
export async function readContainedFile(filePath: string, root: string): Promise<string> {
  if (!filePath.trim()) throw new Error('no file path provided')
  if (isAbsolute(filePath)) {
    throw new Error(`absolute paths are not allowed (use a workspace-relative path): ${filePath}`)
  }
  const rootReal = await realpath(root).catch(() => resolve(root))
  const real = await realpath(resolve(rootReal, filePath)).catch(() => {
    throw new Error(`file not found: ${filePath}`)
  })
  const rel = relative(rootReal, real)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`path escapes the workspace root: ${filePath}`)
  }
  const info = await stat(real)
  if (!info.isFile()) throw new Error(`not a file: ${filePath}`)
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`file too large (${info.size} bytes > ${MAX_FILE_BYTES}): ${filePath}`)
  }
  const content = await readFile(real, 'utf8')
  // Expose only the workspace-relative path (never the absolute real path) to
  // avoid leaking the local filesystem layout to the external model.
  return `\`\`\`\n// File: ${rel}\n${content}\n\`\`\``
}

/**
 * Resolve review input for the human command: an existing workspace-relative
 * file is read (contained); otherwise the input is treated as an inline code
 * snippet. Absolute paths are rejected outright.
 */
export async function readReviewTarget(input: string, cwd?: string): Promise<string> {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('no code or file path provided')
  const root = cwd ?? process.cwd()
  if (isAbsolute(trimmed)) {
    throw new Error(`absolute paths are not allowed (use a workspace-relative path): ${trimmed}`)
  }
  // A path is only consulted when the input does not obviously look like code.
  const looksLikeCode = /[\n;={}]/.test(trimmed) || trimmed.length > 260
  if (!looksLikeCode) {
    try {
      const info = await stat(resolve(root, trimmed))
      if (info.isFile()) return await readContainedFile(trimmed, root)
    } catch {
      // Not an existing file — fall through and treat the input as a snippet.
    }
  }
  if (trimmed.length > MAX_INLINE_CHARS) {
    throw new Error(`inline code exceeds ${MAX_INLINE_CHARS} characters`)
  }
  return trimmed
}

function renderBlock(
  block: ContentBlock,
  includeReasoning: boolean,
  includeToolResults: boolean,
): string | null {
  switch (block.type) {
    case 'text':
      return block.text
    case 'reasoning':
      return includeReasoning ? `[reasoning] ${block.text}` : null
    case 'tool-call':
      return includeToolResults ? `[tool call] ${block.name}(${block.arguments})` : null
    case 'tool-result': {
      if (!includeToolResults) return null
      const inner = block.content
        .map((b) => renderBlock(b, includeReasoning, includeToolResults))
        .filter((x): x is string => x !== null)
        .join('\n')
      return block.isError ? `[tool error] ${inner}` : `[tool result] ${inner}`
    }
    default:
      // Merge-extensible block vocabulary: skip unknown block kinds safely.
      return null
  }
}

/**
 * Serialize an agent's derived message history into a bounded, redacted
 * transcript. By default reasoning and tool results are excluded (they are the
 * most likely to carry secrets/private material); opt in explicitly.
 *
 * When the character cap is hit, the *tail* is kept (newest context first is
 * what a rescue needs), with a leading truncation marker.
 */
export function serializeMessages(messages: readonly Message[], options: TranscriptOptions = {}): string {
  const maxMessages = options.maxMessages ?? MAX_TRANSCRIPT_MESSAGES
  const maxChars = options.maxChars ?? MAX_TRANSCRIPT_CHARS
  const includeReasoning = options.includeReasoning ?? false
  const includeToolResults = options.includeToolResults ?? false
  const recent = messages.slice(-maxMessages)
  const lines: string[] = []
  for (const message of recent) {
    const text = message.content
      .map((block) => renderBlock(block, includeReasoning, includeToolResults))
      .filter((x): x is string => x !== null)
      .join('\n')
      .trim()
    if (!text) continue
    lines.push(`[${message.role}] ${text}`)
  }
  let out = lines.join('\n\n')
  if (out.length > maxChars) {
    out = `\u2026(earlier context truncated)\n\n${out.slice(-maxChars)}`
  }
  return redactSecrets(out)
}
