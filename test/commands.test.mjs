import test from 'node:test'
import assert from 'node:assert/strict'
import { handleBridgeCommand } from '../lib/commands.js'
import { startServer, readBody, json } from './helpers.mjs'

function makeFakeJobs() {
  const records = []
  let seq = 0
  const registry = {
    records,
    attachController() {},
    start(spec) {
      const id = `${spec.kind}-${++seq}`
      const hooks = spec.run()
      const record = {
        id,
        spec,
        hooks,
        snapshot: {
          id,
          kind: spec.kind,
          label: spec.label,
          status: 'running',
          detail: undefined,
          startedAt: Date.now(),
          finishedAt: undefined,
          reported: false,
        },
        output: undefined,
      }
      records.push(record)
      hooks.done.then((outcome) => {
        record.snapshot.status = outcome.status
        record.snapshot.detail = outcome.detail
        record.snapshot.finishedAt = Date.now()
        record.output = outcome.output
      })
      return id
    },
    list() {
      return records.map((r) => ({ ...r.snapshot }))
    },
    read(id) {
      const r = records.find((r) => r.id === id)
      if (!r) throw new Error(`unknown job ${id}`)
      return { text: r.output ?? '', snapshot: { ...r.snapshot } }
    },
    kill(id) {
      const r = records.find((r) => r.id === id)
      if (!r) throw new Error(`unknown job ${id}`)
      r.hooks.cancel('test-cancel')
      return 'requested'
    },
    settle(id) {
      const r = records.find((r) => r.id === id)
      return r.hooks.done
    },
  }
  return registry
}

function makeFakeAgent() {
  const injected = []
  return {
    id: 'sess-1',
    options: {},
    injected,
    session: {
      header: { id: 'sess-1', cwd: process.cwd() },
      deriveMessages: () => [
        { role: 'user', content: [{ type: 'text', text: 'please fix the failing test' }], source: { kind: 'user' } },
        { role: 'assistant', content: [{ type: 'text', text: 'on it' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      ],
    },
    inject(message) {
      injected.push(message)
    },
  }
}

function config(baseUrl) {
  return {
    apiKey: 'test-key',
    baseUrl,
    provider: 'openai',
    model: 'gpt-5-codex',
    timeoutMs: 30_000,
    maxOutputTokens: 100,
  }
}

test('review starts a background job and result returns its output', async () => {
  const server = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req))
    const last = body.messages[body.messages.length - 1]
    json(res, {
      choices: [{ message: { content: `reviewed: ${last.content.slice(0, 30)}` }, finish_reason: 'stop' }],
    })
  })
  const jobs = makeFakeJobs()
  const agent = makeFakeAgent()
  const ctx = { jobs }
  try {
    const started = await handleBridgeCommand(ctx, config(server.baseUrl), {
      rawInput: 'review function foo() { return 42 }',
      agent,
    })
    assert.equal(started.kind, 'success')
    const id = jobs.records[0].id
    assert.match(id, /^ai-bridge-\d+$/)
    assert.match(started.text, new RegExp(id))

    const outcome = await jobs.settle(id)
    assert.equal(outcome.status, 'completed')
    assert.match(outcome.output, /reviewed:/)

    const got = await handleBridgeCommand(ctx, config(server.baseUrl), { rawInput: `result ${id}`, agent })
    assert.equal(got.kind, 'success')
    assert.match(got.text, /reviewed:/)
  } finally {
    await server.close()
  }
})

test('adversarial-review sends the adversarial system prompt', async () => {
  let systemPrompt = ''
  const server = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req))
    systemPrompt = body.messages[0].content
    json(res, { choices: [{ message: { content: '1. why?\n2. how?' }, finish_reason: 'stop' }] })
  })
  const jobs = makeFakeJobs()
  const agent = makeFakeAgent()
  const ctx = { jobs }
  try {
    await handleBridgeCommand(ctx, config(server.baseUrl), {
      rawInput: 'adversarial-review const x = 1',
      agent,
    })
    await jobs.settle(jobs.records[0].id)
    assert.match(systemPrompt, /adversarial/i)
  } finally {
    await server.close()
  }
})

test('rescue injects the delegated result as plugin context', async () => {
  const server = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req))
    const last = body.messages[body.messages.length - 1]
    // The user content must contain both the task and the transcript.
    assert.match(last.content, /fix the failing test/)
    assert.match(last.content, /\[user\] please fix the failing test/)
    json(res, { choices: [{ message: { content: 'here is the fix\u2026' }, finish_reason: 'stop' }] })
  })
  const jobs = makeFakeJobs()
  const agent = makeFakeAgent()
  const ctx = { jobs }
  try {
    const started = await handleBridgeCommand(ctx, config(server.baseUrl), {
      rawInput: 'rescue fix the failing test',
      agent,
    })
    assert.equal(started.kind, 'success')
    await jobs.settle(jobs.records[0].id)

    assert.equal(agent.injected.length, 1)
    const message = agent.injected[0]
    assert.equal(message.role, 'user')
    assert.equal(message.source.kind, 'plugin')
    assert.equal(message.source.plugin, 'ai-bridge')
    assert.match(message.content[0].text, /rescue result/)
  } finally {
    await server.close()
  }
})

test('status lists bridge jobs', async () => {
  const server = await startServer(async (req, res) => {
    json(res, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })
  })
  const jobs = makeFakeJobs()
  const agent = makeFakeAgent()
  const ctx = { jobs }
  try {
    await handleBridgeCommand(ctx, config(server.baseUrl), { rawInput: 'review x', agent })
    const status = await handleBridgeCommand(ctx, config(server.baseUrl), { rawInput: 'status', agent })
    assert.equal(status.kind, 'success')
    assert.match(status.text, /ai-bridge-1 \[ai-bridge\]/)
  } finally {
    await server.close()
  }
})

test('result on a running job reports still-running; cancel kills it', async () => {
  const server = await startServer(() => {
    // Never respond; the request stays in flight until the client aborts.
  })
  const jobs = makeFakeJobs()
  const agent = makeFakeAgent()
  const ctx = { jobs }
  try {
    await handleBridgeCommand(ctx, config(server.baseUrl), { rawInput: 'review hanging', agent })
    const id = jobs.records[0].id

    const still = await handleBridgeCommand(ctx, config(server.baseUrl), { rawInput: `result ${id}`, agent })
    assert.equal(still.kind, 'success')
    assert.match(still.text, /still running/)

    const cancelled = await handleBridgeCommand(ctx, config(server.baseUrl), { rawInput: `cancel ${id}`, agent })
    assert.equal(cancelled.kind, 'success')
    assert.match(cancelled.text, /Requested cancellation/)

    const outcome = await jobs.settle(id)
    assert.equal(outcome.status, 'killed')
  } finally {
    await server.close()
  }
})

test('missing api key returns a clear error', async () => {
  const jobs = makeFakeJobs()
  const agent = makeFakeAgent()
  const ctx = { jobs }
  const result = await handleBridgeCommand(ctx, { ...config('http://127.0.0.1:1'), apiKey: '' }, {
    rawInput: 'review x',
    agent,
  })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /api key/i)
})

test('unknown subcommand and usage help', async () => {
  const ctx = { jobs: makeFakeJobs() }
  const agent = makeFakeAgent()
  const bad = await handleBridgeCommand(ctx, config('http://127.0.0.1:1'), { rawInput: 'frobnicate x', agent })
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /Unknown \/bridge subcommand/)
  const help = await handleBridgeCommand(ctx, config('http://127.0.0.1:1'), { rawInput: '', agent })
  assert.equal(help.kind, 'success')
  assert.match(help.text, /Usage:/)
})
