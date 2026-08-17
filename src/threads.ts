/**
 * Persistent rescue threads.
 *
 * Because the bridge speaks to *stateless* HTTP model APIs, a "thread" here is
 * the conversation the plugin has already exchanged with the external model.
 * Persisting it lets `/bridge rescue --resume` continue that exchange instead
 * of starting over.
 *
 * @module dsh-plugin-ai-bridge/threads
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ChatMessage } from './client.js'

export interface RescueThread {
  id: string
  cwd: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
}

function newId(): string {
  return `th-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Shape check so malformed persisted entries can never crash the store. */
function isValidThread(value: unknown): value is RescueThread {
  if (typeof value !== 'object' || value === null) return false
  const t = value as Record<string, unknown>
  return typeof t.id === 'string'
    && typeof t.cwd === 'string'
    && typeof t.createdAt === 'number'
    && typeof t.updatedAt === 'number'
    && Array.isArray(t.messages)
}

/** JSON-file backed store of rescue threads, keyed by workspace cwd. */
export class ThreadStore {
  private threads: RescueThread[] = []

  constructor(readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      this.threads = Array.isArray(parsed) ? parsed.filter(isValidThread) : []
    } catch (error) {
      // ENOENT is a normal first run; other failures (corrupt JSON, permission)
      // are surfaced once for diagnostics but never crash the plugin.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[ai-bridge] failed to load rescue threads from ${this.file}:`, error)
      }
      this.threads = []
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    // Atomic write: write a temp file then rename, so a crash mid-write never
    // leaves a truncated/corrupt threads.json behind. Owner-only permissions
    // because threads may contain conversation content and secrets.
    const tmp = `${this.file}.${process.pid}.${Date.now().toString(36)}.tmp`
    await writeFile(tmp, JSON.stringify(this.threads, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, this.file)
  }

  list(cwd: string): RescueThread[] {
    return this.threads.filter((t) => t.cwd === cwd).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  latest(cwd: string): RescueThread | undefined {
    let latest: RescueThread | undefined
    for (const t of this.threads) {
      if (t.cwd !== cwd) continue
      if (latest === undefined || t.updatedAt > latest.updatedAt) latest = t
    }
    return latest
  }

  get(id: string): RescueThread | undefined {
    return this.threads.find((t) => t.id === id)
  }

  create(cwd: string): RescueThread {
    const thread: RescueThread = { id: newId(), cwd, createdAt: Date.now(), updatedAt: Date.now(), messages: [] }
    this.threads.push(thread)
    return thread
  }

  async append(thread: RescueThread, ...messages: ChatMessage[]): Promise<void> {
    thread.messages.push(...messages)
    thread.updatedAt = Date.now()
    await this.save()
  }
}
