import test from 'node:test'
import assert from 'node:assert/strict'
import { callExternalModelDetailed } from '../lib/client.js'
import { ResponseCache } from '../lib/cache.js'
import { startServer, json } from './helpers.mjs'

const baseConfig = {
  apiKey: 'test-key',
  baseUrl: '',
  provider: 'openai',
  model: 'gpt-5-codex',
  timeoutMs: 5000,
  maxOutputTokens: 100,
}

test('ResponseCache is disabled when ttl <= 0', () => {
  const c = new ResponseCache(0)
  assert.equal(c.disabled, true)
  c.set('k', { text: 'x' })
  assert.equal(c.get('k'), undefined)
})

test('ResponseCache returns entries within ttl and drops expired ones', async () => {
  const c = new ResponseCache(10)
  c.set('k', { text: 'x' })
  assert.equal(c.get('k').text, 'x')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(c.get('k'), undefined)
})

test('identical requests are served from cache (single provider hit)', async () => {
  let hits = 0
  const server = await startServer(async (_req, res) => {
    hits++
    json(res, { choices: [{ message: { content: 'cached answer' }, finish_reason: 'stop' }] })
  })
  const cache = new ResponseCache(60_000)
  const config = { ...baseConfig, baseUrl: server.baseUrl, cache }
  try {
    const call = { system: 'sys', messages: [{ role: 'user', content: 'x' }] }
    const a = await callExternalModelDetailed(call, config)
    const b = await callExternalModelDetailed(call, config)
    assert.equal(a.text, 'cached answer')
    assert.equal(b.text, 'cached answer')
    assert.equal(b.inputTokens, undefined, 'cache hit must not report stale usage')
    assert.equal(hits, 1)
  } finally {
    await server.close()
  }
})

test('different requests bypass the cache', async () => {
  let hits = 0
  const server = await startServer(async (_req, res) => {
    hits++
    json(res, { choices: [{ message: { content: `answer ${hits}` }, finish_reason: 'stop' }] })
  })
  const cache = new ResponseCache(60_000)
  const config = { ...baseConfig, baseUrl: server.baseUrl, cache }
  try {
    await callExternalModelDetailed({ messages: [{ role: 'user', content: 'a' }] }, config)
    await callExternalModelDetailed({ messages: [{ role: 'user', content: 'b' }] }, config)
    assert.equal(hits, 2)
  } finally {
    await server.close()
  }
})

test('cache key distinguishes models', async () => {
  let hits = 0
  const server = await startServer(async (_req, res) => {
    hits++
    json(res, { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] })
  })
  const cache = new ResponseCache(60_000)
  const config = { ...baseConfig, baseUrl: server.baseUrl, cache }
  try {
    await callExternalModelDetailed({ messages: [{ role: 'user', content: 'x' }] }, { ...config, model: 'm1' })
    await callExternalModelDetailed({ messages: [{ role: 'user', content: 'x' }] }, { ...config, model: 'm2' })
    assert.equal(hits, 2)
  } finally {
    await server.close()
  }
})

test('cache key distinguishes providers and system prompts', async () => {
  let hits = 0
  const server = await startServer(async (_req, res) => {
    hits++
    json(res, { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] })
  })
  const cache = new ResponseCache(60_000)
  const config = { ...baseConfig, baseUrl: server.baseUrl, cache }
  try {
    await callExternalModelDetailed({ system: 'sys-a', messages: [{ role: 'user', content: 'x' }] }, config)
    await callExternalModelDetailed({ system: 'sys-b', messages: [{ role: 'user', content: 'x' }] }, config)
    assert.equal(hits, 2)
  } finally {
    await server.close()
  }
})
