import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readReviewTarget, serializeMessages } from '../lib/context.js'

test('readReviewTarget reads a file and wraps it with a path comment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-'))
  const file = join(dir, 'a.js')
  await writeFile(file, 'const x = 1\n')
  try {
    const out = await readReviewTarget(file)
    assert.match(out, /File: /)
    assert.match(out, /const x = 1/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readReviewTarget resolves relative paths against cwd', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-'))
  await writeFile(join(dir, 'b.js'), 'hello()\n')
  try {
    const out = await readReviewTarget('b.js', dir)
    assert.match(out, /hello\(\)/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readReviewTarget treats non-file input as a code snippet', async () => {
  const snippet = 'function foo() { return 42 }'
  const out = await readReviewTarget(snippet)
  assert.equal(out, snippet)
})

test('serializeMessages renders roles and skips empty text', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
    { role: 'assistant', content: [{ type: 'text', text: 'hello' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    { role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } },
  ]
  const out = serializeMessages(messages)
  assert.match(out, /\[user\] hi/)
  assert.match(out, /\[assistant\] hello/)
  assert.equal(out.match(/\[assistant\]/g).length, 1)
})

test('serializeMessages renders tool calls and results inline', () => {
  const messages = [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'file contents' }] }],
      source: { kind: 'tool', callId: 'c1' },
    },
  ]
  const out = serializeMessages(messages)
  assert.match(out, /\[tool call\] read_file/)
  assert.match(out, /\[tool result\] file contents/)
})

test('serializeMessages bounds by message count and character length', () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({
    role: 'user',
    content: [{ type: 'text', text: `message ${i}` }],
    source: { kind: 'user' },
  }))
  const out = serializeMessages(messages, { maxMessages: 3, maxChars: 100 })
  assert.match(out, /message 9/)
  assert.doesNotMatch(out, /message 5/)
})
