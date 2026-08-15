import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'

test('plugin loads into a cordis context and registers command, tools, and controller', async () => {
  const ctx = new Context()
  const seen = { commands: [], tools: [], controller: null }

  const provider = {
    name: 'mock-services',
    apply(c) {
      c.provide('commands', {
        register(definition) {
          seen.commands.push(definition)
        },
      })
      c.provide('tools', {
        register(definition) {
          seen.tools.push(definition)
        },
      })
      c.provide('jobs', {
        attachController(name) {
          seen.controller = name
        },
      })
    },
  }

  const providerFiber = await ctx.plugin(provider)
  const pluginFiber = await ctx.plugin(plugin, { apiKey: 'test-key', provider: 'openai' })

  try {
    assert.equal(seen.controller, 'ai-bridge')
    assert.ok(seen.commands.some((c) => c.name === 'bridge'), 'bridge command registered')
    assert.equal(seen.tools.length, 2, 'two model-facing tools registered')
    assert.ok(seen.tools.some((t) => t.name === 'ai_bridge_review'))
    assert.ok(seen.tools.some((t) => t.name === 'ai_bridge_delegate'))
  } finally {
    pluginFiber.dispose()
    providerFiber.dispose()
  }
})

test('exported plugin shape: name, inject, callable Config schema', () => {
  assert.equal(typeof plugin.Config, 'function')
  assert.equal(plugin.name, 'ai-bridge')
  assert.deepEqual(plugin.inject, ['commands', 'jobs', 'tools'])
})

test('resolveConfig honors cc-switch / relay environment variables', () => {
  const saved = { ...process.env }
  const set = (k, v) => {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    // Anthropic relay: ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL (cc-switch style).
    set('ANTHROPIC_AUTH_TOKEN', 'relay-token')
    set('ANTHROPIC_BASE_URL', 'https://claude-relay.example.com')
    set('BRIDGE_API_KEY', '')
    set('OPENAI_API_KEY', '')
    const anthropic = plugin.resolveConfig({ provider: 'anthropic' })
    assert.equal(anthropic.apiKey, 'relay-token')
    assert.equal(anthropic.baseUrl, 'https://claude-relay.example.com')

    // Codex / OpenAI relay: OPENAI_BASE_URL + OPENAI_API_KEY.
    set('ANTHROPIC_AUTH_TOKEN', undefined)
    set('ANTHROPIC_BASE_URL', undefined)
    set('OPENAI_BASE_URL', 'https://openai-relay.example.com/v1')
    set('OPENAI_API_KEY', 'openai-relay-token')
    const codex = plugin.resolveConfig({ provider: 'codex', defaultModel: 'gpt-5-codex' })
    assert.equal(codex.apiKey, 'openai-relay-token')
    assert.equal(codex.baseUrl, 'https://openai-relay.example.com/v1')
    assert.equal(codex.provider, 'codex')

    // Explicit config beats environment.
    const explicit = plugin.resolveConfig({ provider: 'generic', baseUrl: 'https://x/v1', apiKey: 'cfg' })
    assert.equal(explicit.apiKey, 'cfg')
    assert.equal(explicit.baseUrl, 'https://x/v1')
  } finally {
    for (const [k, v] of Object.entries(saved)) set(k, v)
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) set(k, undefined)
    }
  }
})
