/**
 * External-model HTTP client for `dsh-plugin-ai-bridge`.
 *
 * Speaks two wire protocols behind one interface:
 *  - OpenAI-compatible `/chat/completions` (Codex, GPT, DeepSeek, and most
 *    third-party gateways), and
 *  - Anthropic `/v1/messages` (Claude).
 *
 * Both streaming (SSE) and non-streaming responses are supported. The client is
 * deliberately dependency-free beyond the platform `fetch`, so it can be unit
 * tested against a local mock server.
 *
 * @module dsh-plugin-ai-bridge/client
 */

export type BridgeProvider = 'openai' | 'anthropic' | 'generic'

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
  anthropic: 'https://api.anthropic.com',
  generic: 'https://api.openai.com/v1',
}

function resolveBaseUrl(config: BridgeClientConfig): string {
  const base = config.baseUrl.trim() || DEFAULT_BASE_URLS[config.provider]
  return base.replace(/\/+$/, '')
}

function endpointFor(config: BridgeClientConfig): string {
  const base = resolveBaseUrl(config)
  return config.provider === 'anthropic' ? `${base}/v1/messages` : `${base}/chat/completions`
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
    const snippet = body.length > 2000 ? `${body.slice(0, 2000)}\u2026` : body
    throw new ExternalModelError(
      `external model request failed with HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`,
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
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim()
        if (data && data !== '[DONE]') onEvent(data)
      }
    }
  }
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
  return {
    text: typeof content === 'string' ? content : '',
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
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxOutputTokens,
    messages: call.messages.map((m) => ({ role: m.role, content: m.content })),
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
  const text = Array.isArray(data.content)
    ? data.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text ?? '').join('')
    : ''
  return {
    text,
    model: typeof data.model === 'string' ? data.model : config.model,
    finishReason: data.stop_reason,
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
      'no external-model API key configured (set ai-bridge.apiKey or BRIDGE_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY)',
    )
  }
  const stream = opts.stream ?? typeof opts.onDelta === 'function'
  return config.provider === 'anthropic'
    ? callAnthropic(config, call, { ...opts, stream })
    : callOpenAI(config, call, { ...opts, stream })
}
