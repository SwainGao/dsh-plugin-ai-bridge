import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleBridgeCommand } from '../lib/commands.js'
import { ThreadStore } from '../lib/threads.js'
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

function makeFakeAgent(cwd = process.cwd()) {
  const injected = []
  return {
    id: 'sess-1',
    options: {},
    injected,
    session: {
      header: { id: 'sess-1', cwd },
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

function makeStore() {
  const dir = join(tmpdir(), `bridge-threads-${Math.random().toString(36).slice(2)}`)
  return new ThreadStore(join(dir, 'threads.json'))
}

function config(baseUrl) {
  return {
    apiKey: 'test-key',
    baseUrl,
    provider: 'openai',
    model: 'gpt-5-codex',
    timeoutMs: 30_000,
    maxOutputTokens: 100,
    injectRescueResult: false,
    reviewGate: false,
    threadsDir: '/tmp/bridge-test-threads',
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
  const store = makeStore()
  const ctx = { jobs }
  try {
    const started = await handleBridgeCommand(ctx, config(server.baseUrl), store, {
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

    const got = await handleBridgeCommand(ctx, config(server.baseUrl), store, { rawInput: `result ${id}`, agent })
    assert.equal(got.kind, 'success')
    assert.match(got.text, /reviewed:/)
  } finally {
    await server.close()
  }
})

test('review --wait returns the result inline without a background job', async () => {
  const server = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req))
    const last = body.messages[body.messages.length - 1]
    json(res, { choices: [{ message: { content: `reviewed: ${last.content.slice(0, 20)}` }, finish_reason: 'stop' }] })
  })
  const jobs = makeFakeJobs()
  const agent = makeFakeAgent()
  const store = makeStore()
  const ctx = { jobs }
  try {
    const result = await handleBridgeCommand(ctx, config(server.baseUrl), store, {
      rawInput: 'review --wait function foo() {}',
      agent,
    })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /reviewed:/)
    assert.equal(jobs.records.length, 0, '--wait must not create a background job')
  } finally {
    await server.close()
  }
})

test('review --model overrides the model for the call', async () => {
  let model
  const server = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req))
    model = body.model
    json(res, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })
  })
  const jobs = makeFakeJobs()
  const agent = makeFakeAgent()
  const store = makeStore()
  const ctx = { jobs }
  try {
    await handleBridgeCommand(ctx, config(server.baseUrl), store, {
      rawInput: 'review --wait --model gpt-5.5 function foo() {}',
      agent,
    })
    assert.equal(model, 'gpt-5.5')
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
  const store = makeStore()
  const ctx = { jobs }
  try {
    await handleBridgeCommand(ctx, config(server.baseUrl), store, {
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
    assert.match(last.content, /fix the failing test/)
    assert.match(last.content, /\[user\] please fix the failing test/)
    json(res, { choices: [{ message: { content: 'here is the fix\u2026' }, finish_reason: 'stop' }] })
  })
  const jobs = makeFakeJobs()
  const agent = makeFakeAgent()
  const store = makeStore()
  const ctx = { jobs }
  try {
    const started = await handleBridgeCommand(ctx, { ...config(server.baseUrl), injectRescueResult: true }, store, {
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
    assert.match(message.content[0].text, /UNTRUSTED EXTERNAL OUTPUT/)
  } finally {
    await server.close()
  }
})

test('rescue does not auto-inject by default (injectRescueResult false)', async () => {
  const server = await startServer(async (req, res) => {
    json(res, { choices: [{ message: { content: 'here is the fix\u2026' }, finish_reason: 'stop' }] })
  })
  const jobs = makeFakeJobs()
  const agent = makeFakeAgent()
  const store = makeStore()
  const ctx = { jobs }
  try {
    const started = await handleBridgeCommand(ctx, config(server.baseUrl), store, {
      rawInput: 'rescue fix the failing test',
      agent,
    })
    assert.equal(started.kind, 'success')
    assert.match(started.text, /NOT be auto-injected/)
    await jobs.settle(jobs.records[0].id)
    assert.equal(agent.injected.length, 0, 'no injection by default')

    const got = await handleBridgeCommand(ctx, config(server.baseUrl), store, { rawInput: `result ${jobs.records[0].id}`, agent })
    assert.equal(got.kind, 'success')
    assert.match(got.text, /here is the fix/)
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
  const store = makeStore()
  const ctx = { jobs }
  try {
    await handleBridgeCommand(ctx, config(server.baseUrl), store, { rawInput: 'review x', agent })
    const status = await handleBridgeCommand(ctx, config(server.baseUrl), store, { rawInput: 'status', agent })
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
  const store = makeStore()
  const ctx = { jobs }
  try {
    await handleBridgeCommand(ctx, config(server.baseUrl), store, { rawInput: 'review hanging', agent })
    const id = jobs.records[0].id

    const still = await handleBridgeCommand(ctx, config(server.baseUrl), store, { rawInput: `result ${id}`, agent })
    assert.equal(still.kind, 'success')
    assert.match(still.text, /still running/)

    const cancelled = await handleBridgeCommand(ctx, config(server.baseUrl), store, { rawInput: `cancel ${id}`, agent })
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
  const store = makeStore()
  const ctx = { jobs }
  const result = await handleBridgeCommand(ctx, { ...config('http://127.0.0.1:1'), apiKey: '' }, store, {
    rawInput: 'review x',
    agent,
  })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /api key/i)
})

test('unknown subcommand and usage help', async () => {
  const ctx = { jobs: makeFakeJobs() }
  const agent = makeFakeAgent()
  const store = makeStore()
  const bad = await handleBridgeCommand(ctx, config('http://127.0.0.1:1'), store, { rawInput: 'frobnicate x', agent })
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /Unknown \/bridge subcommand/)
  const help = await handleBridgeCommand(ctx, config('http://127.0.0.1:1'), store, { rawInput: '', agent })
  assert.equal(help.kind, 'success')
  assert.match(help.text, /Usage:/)
})

test('review rejects absolute paths before starting any job', async () => {
  const jobs = makeFakeJobs()
  const agent = makeFakeAgent()
  const store = makeStore()
  const ctx = { jobs }
  const result = await handleBridgeCommand(ctx, config('http://127.0.0.1:1'), store, { rawInput: 'review /etc/passwd', agent })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Absolute paths/)
  assert.equal(jobs.records.length, 0, 'no background job should be started')
})

test('rescue --resume continues the latest thread', async () => {
  const server = await startServer(async (req, res) => {
    json(res, { choices: [{ message: { content: 'continued' }, finish_reason: 'stop' }] })
  })
  const jobs = makeFakeJobs()
  const agent = makeFakeAgent()
  const store = makeStore()
  const ctx = { jobs }
  try {
    // First rescue creates a thread.
    await handleBridgeCommand(ctx, config(server.baseUrl), store, { rawInput: 'rescue first task', agent })
    await jobs.settle(jobs.records[0].id)

    const resumed = await handleBridgeCommand(ctx, config(server.baseUrl), store, { rawInput: 'rescue --resume keep going', agent })
    assert.equal(resumed.kind, 'success')
    assert.match(resumed.text, /Resuming thread/)
  } finally {
    await server.close()
  }
})

test('transfer saves the session as a resumable thread', async () => {
  const store = makeStore()
  const ctx = { jobs: makeFakeJobs() }
  const agent = makeFakeAgent()
  const result = await handleBridgeCommand(ctx, config('http://127.0.0.1:1'), store, { rawInput: 'transfer', agent })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /rescue thread th-/)
  assert.match(result.text, /--thread/)
})

test('review redacts secrets by default and --raw disables it', async () => {
  let sent = ''
  const server = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req))
    sent = body.messages[body.messages.length - 1].content
    json(res, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })
  })
  const jobs = makeFakeJobs()
  const agent = makeFakeAgent()
  const store = makeStore()
  const ctx = { jobs }
  try {
    const secret = 'sk-abcdefghijklmnop123456'
    await handleBridgeCommand(ctx, config(server.baseUrl), store, { rawInput: `review --wait const key = "${secret}"`, agent })
    assert.match(sent, /\[REDACTED\]/)
    assert.doesNotMatch(sent, /abcdefghijklmnop123456/)

    await handleBridgeCommand(ctx, config(server.baseUrl), store, { rawInput: `review --wait --raw const key = "${secret}"`, agent })
    assert.match(sent, /abcdefghijklmnop123456/)
    assert.doesNotMatch(sent, /\[REDACTED\]/)
  } finally {
    await server.close()
  }
})

test('review sends the full multi-word inline code (not just the first word)', async () => {
  let sent = ''
  const server = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req))
    sent = body.messages[body.messages.length - 1].content
    json(res, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })
  })
  const jobs = makeFakeJobs()
  const agent = makeFakeAgent()
  const store = makeStore()
  const ctx = { jobs }
  try {
    await handleBridgeCommand(ctx, config(server.baseUrl), store, { rawInput: 'review --wait function add(a,b){return a-b}', agent })
    assert.match(sent, /function add\(a,b\)\{return a-b\}/)
  } finally {
    await server.close()
  }
})
