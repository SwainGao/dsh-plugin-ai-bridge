/**
 * In-memory response de-duplication cache.
 *
 * Identical external-model requests (same provider, model, key, prompt, and
 * messages) within a short TTL reuse the previous answer, so repeat reviews,
 * gate loops, and re-delegations do not re-bill the provider. The cache key is
 * a SHA-256 of the full request, so nothing sensitive is stored in plaintext,
 * and any input already redacted by the caller stays redacted.
 *
 * @module dsh-plugin-ai-bridge/cache
 */
import { createHash } from 'node:crypto'
import type { BridgeClientConfig, CallResult, ExternalCall } from './client.js'

/** A bounded, TTL-expiring, LRU-ordered map of request-hash -> result. */
export class ResponseCache {
  private readonly entries = new Map<string, { result: CallResult; expires: number }>()

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
  ) {}

  /** `ttlMs <= 0` disables caching entirely. */
  get disabled(): boolean {
    return this.ttlMs <= 0
  }

  get(key: string): CallResult | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expires <= Date.now()) {
      this.entries.delete(key)
      return undefined
    }
    // Refresh recency so the oldest-inserted entry is evicted first on overflow.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.result
  }

  set(key: string, result: CallResult): void {
    if (this.disabled) return
    this.entries.delete(key)
    this.entries.set(key, { result, expires: Date.now() + this.ttlMs })
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
  }

  clear(): void {
    this.entries.clear()
  }
}

/**
 * Stable, secret-safe cache key. Hashes every request field that determines
 * the response, so two requests collide only when they are truly identical.
 */
export function cacheKey(config: BridgeClientConfig, call: ExternalCall): string {
  return createHash('sha256')
    .update(JSON.stringify([
      config.provider,
      config.baseUrl,
      config.model,
      config.apiKey,
      config.maxOutputTokens,
      call.system ?? '',
      call.messages,
    ]))
    .digest('hex')
}
