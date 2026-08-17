import test from 'node:test'
import assert from 'node:assert/strict'
import { callExternalModel, callExternalModelDetailed, ExternalModelError } from '../lib/client.js'
import { startServer, readBody, json, sse } from './helpers.mjs'

const baseConfig = {
  apiKey: 'test-key',
  baseUrl: '',
  provider: 'openai',
  model: 'gpt-5-codex',
  timeoutMs: 5000,
  maxOutputTokens: 100,
}

test('openai non-streaming call returns text and usage', async () => {
  const server = await startServer(async (req, res) => {
    assert.equal(req.url, '/chat/completions')
    const body = JSON.parse(await readBody(req))
    assert.equal(body.model, 'gpt-5-codex')
    assert.equal(body.messages[0].role, 'system')
    assert.equal(body.messages[1].content, 'hello')
    assert.equal(req.headers.authorization, 'Bearer test-key')
    json(res, {
      model: 'gpt-5-codex',
      choices: [{ message: { content: 'looks good' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    })
  })
  try {
    const result = await callExternalModelDetailed(
      { system: 'sys', messages: [{ role: 'user', content: 'hello' }] },
      { ...baseConfig, baseUrl: server.baseUrl },
    )
    assert.equal(result.text, 'looks good')
    assert.equal(result.finishReason, 'stop')
    assert.equal(result.inputTokens, 10)
    assert.equal(result.outputTokens, 3)
  } finally {
    await server.close()
  }
})

test('openai streaming call accumulates SSE deltas', async () => {
  const server = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req))
    assert.equal(body.stream, true)
    sse(res, [
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])
  })
  try {
    const deltas = []
    const text = await callExternalModel(
      { messages: [{ role: 'user', content: 'x' }] },
      { ...baseConfig, baseUrl: server.baseUrl },
      { onDelta: (d) => deltas.push(d) },
    )
    assert.equal(text, 'Hello')
    assert.deepEqual(deltas, ['Hel', 'lo'])
  } finally {
    await server.close()
  }
})

test('anthropic non-streaming call uses /v1/messages and x-api-key', async () => {
  const server = await startServer(async (req, res) => {
    assert.equal(req.url, '/v1/messages')
    const body = JSON.parse(await readBody(req))
    assert.equal(body.system, 'sys')
    assert.equal(body.model, 'claude-sonnet-4-5')
    assert.equal(req.headers['x-api-key'], 'test-key')
    json(res, {
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'claude says hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 },
    })
  })
  try {
    const result = await callExternalModelDetailed(
      { system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
      { ...baseConfig, provider: 'anthropic', model: 'claude-sonnet-4-5', baseUrl: server.baseUrl },
    )
    assert.equal(result.text, 'claude says hi')
    assert.equal(result.finishReason, 'end_turn')
  } finally {
    await server.close()
  }
})

test('anthropic streaming call accumulates content_block_delta', async () => {
  const server = await startServer(async (_req, res) => {
    sse(res, [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ab' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'cd' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ])
  })
  try {
    const text = await callExternalModel(
      { messages: [{ role: 'user', content: 'hi' }] },
      { ...baseConfig, provider: 'anthropic', baseUrl: server.baseUrl },
      { onDelta: () => {} },
    )
    assert.equal(text, 'abcd')
  } finally {
    await server.close()
  }
})

test('codex (Responses API) non-streaming call', async () => {
  const server = await startServer(async (req, res) => {
    assert.equal(req.url, '/responses')
    const body = JSON.parse(await readBody(req))
    assert.equal(body.model, 'gpt-5-codex')
    assert.equal(body.instructions, 'sys')
    assert.equal(body.input[0].content[0].text, 'review me')
    json(res, {
      model: 'gpt-5-codex',
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'codex says: ' }] },
        { type: 'output_text', text: 'looks good' },
      ],
      usage: { input_tokens: 7, output_tokens: 4 },
    })
  })
  try {
    const result = await callExternalModelDetailed(
      { system: 'sys', messages: [{ role: 'user', content: 'review me' }] },
      { ...baseConfig, provider: 'codex', baseUrl: server.baseUrl },
    )
    assert.equal(result.text, 'codex says: looks good')
    assert.equal(result.finishReason, 'completed')
    assert.equal(result.outputTokens, 4)
  } finally {
    await server.close()
  }
})

test('codex (Responses API) streaming call accumulates output_text deltas', async () => {
  const server = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req))
    assert.equal(body.stream, true)
    sse(res, [
      { type: 'response.output_text.delta', delta: 'Hel' },
      { type: 'response.output_text.delta', delta: 'lo' },
      { type: 'response.completed', response: { status: 'completed', usage: { output_tokens: 2 } } },
    ])
  })
  try {
    const text = await callExternalModel(
      { messages: [{ role: 'user', content: 'x' }] },
      { ...baseConfig, provider: 'codex', baseUrl: server.baseUrl },
      { onDelta: () => {} },
    )
    assert.equal(text, 'Hello')
  } finally {
    await server.close()
  }
})

test('non-2xx response raises ExternalModelError with status', async () => {
  const server = await startServer(async (_req, res) => {
    json(res, { error: { message: 'bad key' } }, 401)
  })
  try {
    await assert.rejects(
      () => callExternalModel({ messages: [{ role: 'user', content: 'x' }] }, { ...baseConfig, baseUrl: server.baseUrl }),
      (err) => err instanceof ExternalModelError && err.status === 401,
    )
  } finally {
    await server.close()
  }
})

test('missing api key raises ExternalModelError before any request', async () => {
  await assert.rejects(
    () => callExternalModel({ messages: [{ role: 'user', content: 'x' }] }, { ...baseConfig, apiKey: '' }),
    (err) => err instanceof ExternalModelError && /api key/i.test(err.message),
  )
})

test('anthropic rejects role "system" inside messages', async () => {
  await assert.rejects(
    () => callExternalModel(
      { messages: [{ role: 'system', content: 'x' }] },
      { ...baseConfig, provider: 'anthropic', baseUrl: 'http://127.0.0.1:1' },
    ),
    (err) => err instanceof ExternalModelError && /system/.test(err.message),
  )
})

test('codex rejects role "system" inside input', async () => {
  await assert.rejects(
    () => callExternalModel(
      { messages: [{ role: 'system', content: 'x' }] },
      { ...baseConfig, provider: 'codex', baseUrl: 'http://127.0.0.1:1' },
    ),
    (err) => err instanceof ExternalModelError && /system/.test(err.message),
  )
})

test('openai throws on malformed (missing content) response', async () => {
  const server = await startServer(async (_req, res) => {
    json(res, { model: 'x', choices: [] })
  })
  try {
    await assert.rejects(
      () => callExternalModel({ messages: [{ role: 'user', content: 'x' }] }, { ...baseConfig, baseUrl: server.baseUrl }),
      (err) => err instanceof ExternalModelError && /malformed/.test(err.message),
    )
  } finally {
    await server.close()
  }
})

test('anthropic throws on malformed (missing content array) response', async () => {
  const server = await startServer(async (_req, res) => {
    json(res, { model: 'x', stop_reason: 'end_turn' })
  })
  try {
    await assert.rejects(
      () => callExternalModel({ messages: [{ role: 'user', content: 'x' }] }, { ...baseConfig, provider: 'anthropic', baseUrl: server.baseUrl }),
      (err) => err instanceof ExternalModelError && /malformed/.test(err.message),
    )
  } finally {
    await server.close()
  }
})

test('streaming flushes a trailing event without a final newline', async () => {
  const server = await startServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n')
    res.write('data: {"choices":[{"delta":{"content":"Bye"}}]}') // no trailing newline
    res.end()
  })
  try {
    let text = ''
    await callExternalModel(
      { messages: [{ role: 'user', content: 'x' }] },
      { ...baseConfig, baseUrl: server.baseUrl },
      { onDelta: (d) => { text += d } },
    )
    assert.equal(text, 'HiBye')
  } finally {
    await server.close()
  }
})

test('non-2xx error body is bounded and prefers the structured message', async () => {
  const server = await startServer(async (_req, res) => {
    json(res, { error: { message: 'invalid api key' }, noise: 'x'.repeat(5000) }, 401)
  })
  try {
    await assert.rejects(
      () => callExternalModel({ messages: [{ role: 'user', content: 'x' }] }, { ...baseConfig, baseUrl: server.baseUrl }),
      (err) => err instanceof ExternalModelError && /invalid api key/.test(err.message) && !err.message.includes('xxxx'),
    )
  } finally {
    await server.close()
  }
})
