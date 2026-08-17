import test from 'node:test'
import assert from 'node:assert/strict'
import { parseGateVerdict, registerReviewGate } from '../lib/gate.js'

test('parseGateVerdict reads the last PASS/FAIL verdict', () => {
  assert.equal(parseGateVerdict('...\nVERDICT: PASS'), 'pass')
  assert.equal(parseGateVerdict('VERDICT: FAIL\nVERDICT: PASS'), 'pass')
  assert.equal(parseGateVerdict('verdict: fail'), 'fail')
  assert.equal(parseGateVerdict('no verdict here'), 'unknown')
})

const baseConfig = {
  apiKey: 'x',
  baseUrl: '',
  provider: 'openai',
  model: 'm',
  timeoutMs: 1,
  maxOutputTokens: 1,
  injectRescueResult: false,
  reviewGate: false,
  threadsDir: '',
}

test('registerReviewGate is a no-op when disabled', () => {
  const ctx = { on() { throw new Error('must not subscribe') } }
  registerReviewGate(ctx, baseConfig)
})

test('registerReviewGate subscribes to agent/turn-stopping when enabled', () => {
  let event = null
  const ctx = { on(name, handler) { event = { name, handler } } }
  registerReviewGate(ctx, { ...baseConfig, reviewGate: true })
  assert.equal(event.name, 'agent/turn-stopping')
  assert.equal(typeof event.handler, 'function')
})
