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
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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

/** JSON-file backed store of rescue threads, keyed by workspace cwd. */
export class ThreadStore {
  private threads: RescueThread[] = []

  constructor(readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) this.threads = parsed
    } catch {
      this.threads = []
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(this.threads, null, 2), 'utf8')
  }

  list(cwd: string): RescueThread[] {
    return this.threads.filter((t) => t.cwd === cwd).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  latest(cwd: string): RescueThread | undefined {
    return this.list(cwd)[0]
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
