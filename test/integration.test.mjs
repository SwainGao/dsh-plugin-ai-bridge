import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import * as plugin from '../lib/index.js'

/**
 * End-to-end integration against the REAL DSH command registry: load the
 * plugin into a Cordis context whose `commands` service is the actual
 * `CommandRuntime` (not a mock), then resolve and execute `/bridge` exactly
 * as a Web UI / CLI adapter would.
 */
test('real CommandRuntime resolves and executes /bridge commands', async () => {
  const ctx = new Context()
  const lifecycle = []
  const provider = {
    name: 'mock-services',
    apply(c) {
      // The Service constructor registers itself as ctx.commands.
      new CommandRuntime(c)
      c.provide('jobs', {
        attachController() {},
        list: () => [],
        read: () => ({ text: '', snapshot: { status: 'completed' } }),
        kill: () => 'already-finished',
        start: () => 'ai-bridge-1',
      })
      c.provide('tools', { register() {} })
    },
  }
  const agent = {
    id: 'sess-1',
    session: {
      append(type, data) {
        lifecycle.push([type, data])
        return {}
      },
    },
  }

  const providerFiber = await ctx.plugin(provider)
  const pluginFiber = await ctx.plugin(plugin, { apiKey: 'test-key' })
  try {
    const commands = ctx.get('commands')
    const def = commands.find(agent, 'bridge')
    assert.ok(def, 'bridge command is resolvable through the real registry')
    assert.equal(def.name, 'bridge')
    assert.equal(def.description, 'delegate code review and complex tasks to external AI models')

    const execution = await commands.execute(agent, '/bridge help', new AbortController().signal)
    assert.ok(execution, 'execution returned')
    assert.equal(execution.result.kind, 'success')
    assert.match(execution.result.text, /Usage:/)

    // The lifecycle pairing is appended to the session, proving the real
    // dispatch path (not just my handler) ran.
    assert.ok(lifecycle.some(([type]) => type === 'command/run'))
    assert.ok(lifecycle.some(([type]) => type === 'command/done'))

    // An unknown command name (colon form is not a legal DSH command name).
    const none = await commands.execute(agent, '/bridge:review x', new AbortController().signal)
    assert.equal(none, undefined)
  } finally {
    pluginFiber.dispose()
    providerFiber.dispose()
  }
})
