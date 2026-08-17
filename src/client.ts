/**
 * External-model HTTP client for `dsh-plugin-ai-bridge`.
 *
 * Speaks three wire protocols behind one interface:
 *  - OpenAI-compatible `/chat/completions` (GPT, DeepSeek, and most
 *    third-party relay gateways),
 *  - OpenAI `/responses` (the native Codex Responses API), and
 *  - Anthropic `/v1/messages` (Claude).
 *
 * Both streaming (SSE) and non-streaming responses are supported. The client is
 * deliberately dependency-free beyond the platform `fetch`, so it can be unit
 * tested against a local mock server.
 *
 * @module dsh-plugin-ai-bridge/client
 */

export type BridgeProvider = 'openai' | 'codex' | 'anthropic' | 'generic'

/** Resolved, runtime-ready bridge configuration (env fallbacks already applied). */
export interface BridgeClientConfig {
  apiKey: string
  baseUrl: string
  provider: BridgeProvider
  model: string
  timeoutMs: number
  maxOutputTokens: number
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ExternalCall {
  system?: string
  messages: ChatMessage[]
}

export interface CallOptions {
  signal?: AbortSignal
  /** Force streaming on/off. Defaults to on when `onDelta` is provided. */
  stream?: boolean
  onDelta?: (delta: string) => void
}

export interface CallResult {
  text: string
  model?: string
  finishReason?: string
  inputTokens?: number
  outputTokens?: number
}

/** Raised for transport/protocol failures and non-2xx provider responses. */
export class ExternalModelError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ExternalModelError'
    this.status = status
  }
}

const DEFAULT_BASE_URLS: Record<BridgeProvider, string> = {
  openai: 'https://api.openai.com/v1',
  codex: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  generic: 'https://api.openai.com/v1',
}

function resolveBaseUrl(config: BridgeClientConfig): string {
  const base = config.baseUrl.trim() || DEFAULT_BASE_URLS[config.provider]
  return base.replace(/\/+$/, '')
}

function endpointFor(config: BridgeClientConfig): string {
  const base = resolveBaseUrl(config)
  if (config.provider === 'anthropic') return `${base}/v1/messages`
  if (config.provider === 'codex') return `${base}/responses`
  return `${base}/chat/completions`
}

function authHeaders(config: BridgeClientConfig): Record<string, string> {
  if (config.provider === 'anthropic') {
    return {
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    }
  }
  return {
    authorization: `Bearer ${config.apiKey}`,
    'content-type': 'application/json',
  }
}

function combinedSignal(config: BridgeClientConfig, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(config.timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/**
 * Extract a short, safe error message from a provider error body. Prefers the
 * structured `error.message` / `message` field; falls back to a bounded raw
 * excerpt. Avoids dumping the full upstream body (which may echo metadata).
 */
function extractErrorDetail(body: string): string {
  if (!body) return ''
  try {
    const parsed = JSON.parse(body)
    const message = parsed?.error?.message ?? parsed?.message
    if (typeof message === 'string' && message.trim()) {
      return `: ${message.slice(0, 300)}`
    }
  } catch {
    // not JSON — fall through to a bounded raw excerpt
  }
  return `: ${body.slice(0, 200)}`
}

async function request(url: string, init: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new ExternalModelError(`external model request failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ExternalModelError(
      `external model request failed with HTTP ${res.status}${extractErrorDetail(body)}`,
      res.status,
    )
  }
  return res
}

/**
 * Consume a Server-Sent-Events body, invoking `onEvent` for each non-empty
 * `data:` payload. `[DONE]` is skipped.
 */
async function collectSse(res: Response, onEvent: (data: string) => void): Promise<void> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines: string[] = []
  const flushEvent = () => {
    if (dataLines.length === 0) return
    const data = dataLines.join('\n').trim()
    dataLines = []
    if (data && data !== '[DONE]') onEvent(data)
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line === '') {
        // A blank line terminates one SSE event.
        flushEvent()
      } else if (line.startsWith('data:')) {
        // Multiple `data:` lines in one event are joined with `\n`.
        dataLines.push(line.slice(5).replace(/^ /, ''))
      }
      // Other fields (event:, id:, retry:, comments) are ignored.
    }
  }
  // A final chunk may end without a trailing newline; treat the leftover
  // buffer as one last line before flushing.
  if (buffer.length > 0) {
    let tail = buffer
    if (tail.endsWith('\r')) tail = tail.slice(0, -1)
    if (tail.startsWith('data:')) {
      dataLines.push(tail.slice(5).replace(/^ /, ''))
    }
  }
  // Flush any trailing event that lacked a terminating blank line.
  flushEvent()
}

async function callOpenAI(
  config: BridgeClientConfig,
  call: ExternalCall,
  opts: CallOptions,
): Promise<CallResult> {
  const messages: ChatMessage[] = []
  if (call.system) messages.push({ role: 'system', content: call.system })
  messages.push(...call.messages)
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    max_tokens: config.maxOutputTokens,
  }
  if (opts.stream) {
    const res = await request(endpointFor(config), {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({ ...body, stream: true }),
      signal: combinedSignal(config, opts.signal),
    })
    let text = ''
    let finishReason: string | undefined
    await collectSse(res, (data) => {
      let parsed: any
      try {
        parsed = JSON.parse(data)
      } catch {
        return
      }
      const delta = parsed.choices?.[0]?.delta?.content
      if (typeof delta === 'string') {
        text += delta
        opts.onDelta?.(delta)
      }
      if (typeof parsed.choices?.[0]?.finish_reason === 'string') {
        finishReason = parsed.choices[0].finish_reason
      }
    })
    return { text, model: config.model, finishReason }
  }
  const res = await request(endpointFor(config), {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify(body),
    signal: combinedSignal(config, opts.signal),
  })
  const data: any = await res.json()
  const content = data.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new ExternalModelError('openai: malformed response (missing choices[0].message.content)')
  }
  return {
    text: content,
    model: typeof data.model === 'string' ? data.model : config.model,
    finishReason: data.choices?.[0]?.finish_reason,
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
  }
}

async function callAnthropic(
  config: BridgeClientConfig,
  call: ExternalCall,
  opts: CallOptions,
): Promise<CallResult> {
  const messages = call.messages.map((m) => {
    if (m.role === 'system') {
      throw new ExternalModelError('anthropic: role "system" is not allowed in messages; pass it via `system`')
    }
    return { role: m.role, content: m.content }
  })
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxOutputTokens,
    messages,
  }
  if (call.system) body.system = call.system
  if (opts.stream) {
    const res = await request(endpointFor(config), {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({ ...body, stream: true }),
      signal: combinedSignal(config, opts.signal),
    })
    let text = ''
    let finishReason: string | undefined
    let outputTokens: number | undefined
    await collectSse(res, (data) => {
      let parsed: any
      try {
        parsed = JSON.parse(data)
      } catch {
        return
      }
      if (parsed.type === 'content_block_delta') {
        const delta = parsed.delta?.text
        if (typeof delta === 'string') {
          text += delta
          opts.onDelta?.(delta)
        }
      } else if (parsed.type === 'message_delta') {
        if (typeof parsed.delta?.stop_reason === 'string') finishReason = parsed.delta.stop_reason
        if (typeof parsed.usage?.output_tokens === 'number') outputTokens = parsed.usage.output_tokens
      }
    })
    return { text, model: config.model, finishReason, outputTokens }
  }
  const res = await request(endpointFor(config), {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify(body),
    signal: combinedSignal(config, opts.signal),
  })
  const data: any = await res.json()
  if (!Array.isArray(data.content)) {
    throw new ExternalModelError('anthropic: malformed response (missing content array)')
  }
  const text = data.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text ?? '').join('')
  return {
    text,
    model: typeof data.model === 'string' ? data.model : config.model,
    finishReason: data.stop_reason,
    inputTokens: data.usage?.input_tokens,
    outputTokens: data.usage?.output_tokens,
  }
}

/** Extract concatenated text from a non-streaming Responses API payload. */
function extractResponsesText(data: any): string {
  if (!Array.isArray(data.output)) return ''
  const parts: string[] = []
  for (const item of data.output) {
    if (item?.type === 'output_text' && typeof item.text === 'string') {
      parts.push(item.text)
    } else if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (block?.type === 'output_text' && typeof block.text === 'string') parts.push(block.text)
      }
    }
  }
  return parts.join('')
}

/** Codex Responses API (`POST /responses`) client, streaming and non-streaming. */
async function callCodex(
  config: BridgeClientConfig,
  call: ExternalCall,
  opts: CallOptions,
): Promise<CallResult> {
  const input = call.messages.map((m) => {
    if (m.role === 'system') {
      throw new ExternalModelError('codex: role "system" is not allowed in input; pass it via `system`')
    }
    return { role: m.role, content: [{ type: 'input_text', text: m.content }] }
  })
  const body: Record<string, unknown> = {
    model: config.model,
    input,
    max_output_tokens: config.maxOutputTokens,
  }
  if (call.system) body.instructions = call.system
  if (opts.stream) {
    const res = await request(endpointFor(config), {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({ ...body, stream: true }),
      signal: combinedSignal(config, opts.signal),
    })
    let text = ''
    let finishReason: string | undefined
    let outputTokens: number | undefined
    await collectSse(res, (data) => {
      let parsed: any
      try {
        parsed = JSON.parse(data)
      } catch {
        return
      }
      if (parsed.type === 'response.output_text.delta') {
        const delta = parsed.delta
        if (typeof delta === 'string') {
          text += delta
          opts.onDelta?.(delta)
        }
      } else if (parsed.type === 'response.completed') {
        if (typeof parsed.response?.status === 'string') finishReason = parsed.response.status
        if (typeof parsed.response?.usage?.output_tokens === 'number') {
          outputTokens = parsed.response.usage.output_tokens
        }
      }
    })
    return { text, model: config.model, finishReason, outputTokens }
  }
  const res = await request(endpointFor(config), {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify(body),
    signal: combinedSignal(config, opts.signal),
  })
  const data: any = await res.json()
  if (!Array.isArray(data.output)) {
    throw new ExternalModelError('codex: malformed response (missing output array)')
  }
  return {
    text: extractResponsesText(data),
    model: typeof data.model === 'string' ? data.model : config.model,
    finishReason: data.status,
    inputTokens: data.usage?.input_tokens,
    outputTokens: data.usage?.output_tokens,
  }
}

/**
 * Call the configured external model and return its complete text response.
 * @throws {ExternalModelError} on missing key, transport failure, or non-2xx.
 */
export async function callExternalModel(
  call: ExternalCall,
  config: BridgeClientConfig,
  opts: CallOptions = {},
): Promise<string> {
  const result = await callExternalModelDetailed(call, config, opts)
  return result.text
}

/** Like {@link callExternalModel} but returns usage/finish metadata as well. */
export async function callExternalModelDetailed(
  call: ExternalCall,
  config: BridgeClientConfig,
  opts: CallOptions = {},
): Promise<CallResult> {
  if (!config.apiKey) {
    throw new ExternalModelError(
      'no external-model API key configured (set ai-bridge.apiKey or BRIDGE_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN)',
    )
  }
  const stream = opts.stream ?? typeof opts.onDelta === 'function'
  if (config.provider === 'anthropic') return callAnthropic(config, call, { ...opts, stream })
  if (config.provider === 'codex') return callCodex(config, call, { ...opts, stream })
  return callOpenAI(config, call, { ...opts, stream })
}
