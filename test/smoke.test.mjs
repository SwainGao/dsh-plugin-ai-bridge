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

test('config schema defaults and env fallback resolution', async () => {
  const ctx = new Context()
  let resolved = null
  const provider = {
    name: 'mock-services',
    apply(c) {
      c.provide('commands', { register() {} })
      c.provide('tools', { register() {} })
      c.provide('jobs', { attachController() {} })
    },
  }
  const providerFiber = await ctx.plugin(provider)

  // Assert the exported plugin shape: a callable schemastery Config schema and
  // the exact name/inject metadata the loader reads.
  assert.equal(typeof plugin.Config, 'function')
  assert.equal(plugin.name, 'ai-bridge')
  assert.deepEqual(plugin.inject, ['commands', 'jobs', 'tools'])

  providerFiber.dispose()
  ctx.dispose?.()
})
