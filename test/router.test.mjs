import test from 'node:test'
import assert from 'node:assert/strict'
import { callReview, parseConfidence, stripConfidence, maybeCompressThread } from '../lib/router.js'
import { startServer, readBody, json } from './helpers.mjs'

const baseConfig = {
  apiKey: 'test-key',
  baseUrl: '',
  provider: 'openai',
  model: 'deep-model',
  fastModel: 'fast-model',
  timeoutMs: 5000,
  maxOutputTokens: 100,
}

test('parseConfidence reads high/low and tolerates a missing marker', () => {
  assert.equal(parseConfidence('good\nCONFIDENCE: high'), 'high')
  assert.equal(parseConfidence('risky\nCONFIDENCE: LOW\nmore'), 'low')
  assert.equal(parseConfidence('no marker here'), 'unknown')
})

test('stripConfidence removes only the marker lines', () => {
  assert.equal(stripConfidence('one\nCONFIDENCE: high\ntwo'), 'one\ntwo')
  assert.equal(stripConfidence('unchanged text'), 'unchanged text')
})

test('callReview deep uses the authoritative model', async () => {
  const calls = []
  const server = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req))
    calls.push(body.model)
    json(res, { choices: [{ message: { content: 'deep says ok' }, finish_reason: 'stop' }] })
  })
  try {
    const text = await callReview(
      { system: 'sys', messages: [{ role: 'user', content: 'x' }] },
      { ...baseConfig, baseUrl: server.baseUrl },
      {},
      'deep',
    )
    assert.equal(text, 'deep says ok')
    assert.deepEqual(calls, ['deep-model'])
  } finally {
    await server.close()
  }
})

test('callReview fast uses the cheap model', async () => {
  const calls = []
  const server = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req))
    calls.push(body.model)
    json(res, { choices: [{ message: { content: 'fast says ok' }, finish_reason: 'stop' }] })
  })
  try {
    const text = await callReview(
      { system: 'sys', messages: [{ role: 'user', content: 'x' }] },
      { ...baseConfig, baseUrl: server.baseUrl },
      {},
      'fast',
    )
    assert.equal(text, 'fast says ok')
    assert.deepEqual(calls, ['fast-model'])
  } finally {
    await server.close()
  }
})

test('callReview auto returns the fast review (marker stripped) when confident', async () => {
  const calls = []
  const server = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req))
    calls.push(body.model)
    json(res, { choices: [{ message: { content: 'looks fine\nCONFIDENCE: high' }, finish_reason: 'stop' }] })
  })
  try {
    const text = await callReview(
      { system: 'sys', messages: [{ role: 'user', content: 'x' }] },
      { ...baseConfig, baseUrl: server.baseUrl },
      {},
      'auto',
    )
    assert.equal(text, 'looks fine')
    assert.deepEqual(calls, ['fast-model'])
  } finally {
    await server.close()
  }
})

test('callReview auto escalates to deep on low confidence', async () => {
  const calls = []
  const server = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req))
    calls.push(body.model)
    if (body.model === 'fast-model') {
      json(res, { choices: [{ message: { content: 'sketchy\nCONFIDENCE: low' }, finish_reason: 'stop' }] })
    } else {
      json(res, { choices: [{ message: { content: 'deep re-review' }, finish_reason: 'stop' }] })
    }
  })
  try {
    const text = await callReview(
      { system: 'sys', messages: [{ role: 'user', content: 'x' }] },
      { ...baseConfig, baseUrl: server.baseUrl },
      {},
      'auto',
    )
    assert.equal(text, 'deep re-review')
    assert.deepEqual(calls, ['fast-model', 'deep-model'])
  } finally {
    await server.close()
  }
})

test('callReview auto with a --model override collapses to one call', async () => {
  const calls = []
  const server = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req))
    calls.push(body.model)
    json(res, { choices: [{ message: { content: 'only' }, finish_reason: 'stop' }] })
  })
  try {
    const text = await callReview(
      { system: 'sys', messages: [{ role: 'user', content: 'x' }] },
      { ...baseConfig, baseUrl: server.baseUrl },
      {},
      'auto',
      'only-model',
    )
    assert.equal(text, 'only')
    assert.deepEqual(calls, ['only-model'])
  } finally {
    await server.close()
  }
})

test('maybeCompressThread is a no-op when fast and deep models are the same', async () => {
  const messages = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' },
  ]
  let requested = false
  const server = await startServer(async (_req, res) => {
    requested = true
    json(res, { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] })
  })
  try {
    const out = await maybeCompressThread(
      messages,
      { ...baseConfig, baseUrl: server.baseUrl, fastModel: baseConfig.model },
      undefined,
      1,
    )
    assert.equal(out, messages)
    assert.equal(requested, false)
  } finally {
    await server.close()
  }
})

test('maybeCompressThread summarizes earlier turns and keeps the last two verbatim', async () => {
  const messages = [
    { role: 'user', content: 'task A' },
    { role: 'assistant', content: 'did A' },
    { role: 'user', content: 'task B' },
    { role: 'assistant', content: 'did B' },
    { role: 'user', content: 'task C' },
  ]
  const models = []
  const server = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req))
    models.push(body.model)
    json(res, { choices: [{ message: { content: 'summary' }, finish_reason: 'stop' }] })
  })
  try {
    const out = await maybeCompressThread(
      messages,
      { ...baseConfig, baseUrl: server.baseUrl },
      undefined,
      4,
    )
    assert.deepEqual(models, ['fast-model'])
    assert.equal(out.length, 3)
    assert.match(out[0].content, /Conversation summary/)
    assert.match(out[0].content, /summary/)
    assert.equal(out[1], messages[3])
    assert.equal(out[2], messages[4])
  } finally {
    await server.close()
  }
})

test('maybeCompressThread disabled via afterTurns 0', async () => {
  const messages = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' },
    { role: 'assistant', content: 'd' },
    { role: 'user', content: 'e' },
  ]
  const out = await maybeCompressThread(messages, baseConfig, undefined, 0)
  assert.equal(out, messages)
})
