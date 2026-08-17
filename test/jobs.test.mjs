import test from 'node:test'
import assert from 'node:assert/strict'
import { startBridgeJob } from '../lib/jobs.js'

test('startBridgeJob does not start external work if the registry refuses registration', () => {
  let ran = false
  const ctx = {
    jobs: {
      start() {
        throw new Error('no controller attached for this owner')
      },
    },
  }
  const agent = { id: 's1', session: {} }
  assert.throws(
    () => startBridgeJob(ctx, agent, {
      kind: 'review',
      label: 'x',
      run: () => {
        ran = true
        return Promise.resolve('done')
      },
    }),
    /no controller/,
  )
  assert.equal(ran, false, 'run() must not execute before the job is admitted')
})

test('startBridgeJob invokes run() only inside ctx.jobs.start({ run })', async () => {
  let invoked = false
  let hooks = null
  const ctx = {
    jobs: {
      start(spec) {
        // Registry preflight succeeded; it now calls spec.run() itself.
        hooks = spec.run()
        return 'ai-bridge-1'
      },
    },
  }
  const agent = { id: 's1', session: {} }
  const id = startBridgeJob(ctx, agent, {
    kind: 'review',
    label: 'x',
    run: () => {
      invoked = true
      return Promise.resolve('ok')
    },
  })
  assert.equal(id, 'ai-bridge-1')
  assert.equal(invoked, true, 'run() executes through the registry hook')
  assert.ok(hooks, 'run() returned hooks')
  assert.equal(typeof hooks.cancel, 'function')
  assert.equal((await hooks.done).status, 'completed')
})
