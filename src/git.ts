/**
 * Git review targets: uncommitted changes and branch diffs.
 *
 * `/bridge review` with no positional reviews the working tree against HEAD;
 * `--base <ref>` reviews the diff from `<ref>...HEAD`. The diff text is capped
 * before it is sent to the external model.
 *
 * @module dsh-plugin-ai-bridge/git
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** Maximum diff bytes sent to an external model. */
export const MAX_DIFF_BYTES = 100_000

export type GitDiffResult =
  | { kind: 'diff'; text: string }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }

async function runDiff(cwd: string, args: string[]): Promise<GitDiffResult> {
  try {
    const { stdout } = await execFileP('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024,
      env: process.env,
    })
    const text = stdout
    if (!text.trim()) return { kind: 'empty' }
    if (text.length > MAX_DIFF_BYTES) {
      return { kind: 'diff', text: `${text.slice(0, MAX_DIFF_BYTES)}\n\u2026(diff truncated at ${MAX_DIFF_BYTES} bytes)` }
    }
    return { kind: 'diff', text }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'error', message: message.length > 500 ? `${message.slice(0, 500)}\u2026` : message }
  }
}

/** Diff of the working tree (staged + unstaged) against HEAD. */
export function getUncommittedDiff(cwd: string): Promise<GitDiffResult> {
  return runDiff(cwd, ['diff', 'HEAD'])
}

/** Diff from `<base>...HEAD` (changes on this branch since the base). */
export function getBranchDiff(cwd: string, base: string): Promise<GitDiffResult> {
  return runDiff(cwd, ['diff', `${base}...HEAD`])
}
