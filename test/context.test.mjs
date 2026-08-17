import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_FILE_BYTES, readContainedFile, readReviewTarget, serializeMessages } from '../lib/context.js'

test('readReviewTarget reads a workspace-relative file and exposes only the relative path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-'))
  await writeFile(join(dir, 'a.js'), 'const x = 1\n')
  try {
    const out = await readReviewTarget('a.js', dir)
    assert.match(out, /File: a\.js/)
    assert.match(out, /const x = 1/)
    assert.equal(out.includes(dir), false, 'must not leak the absolute path')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readReviewTarget treats non-file input as a code snippet', async () => {
  const snippet = 'function foo() { return 42 }'
  const out = await readReviewTarget(snippet, process.cwd())
  assert.equal(out, snippet)
})

test('readReviewTarget rejects absolute paths', async () => {
  await assert.rejects(() => readReviewTarget('/etc/passwd', process.cwd()), /absolute paths/)
})

test('readContainedFile rejects absolute paths', async () => {
  await assert.rejects(() => readContainedFile('/etc/passwd', process.cwd()), /absolute paths/)
})

test('readContainedFile rejects ../ traversal even when the target exists', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'bridge-p-'))
  const root = join(parent, 'root')
  await mkdir(root)
  await writeFile(join(parent, 'secret.txt'), 'secret')
  try {
    await assert.rejects(() => readContainedFile('../secret.txt', root), /escapes/)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('readContainedFile rejects a symlink that escapes the root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'bridge-out-'))
  const secret = join(outside, 'secret.txt')
  await writeFile(secret, 'secret')
  await symlink(secret, join(root, 'link'))
  try {
    await assert.rejects(() => readContainedFile('link', root), /escapes/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('readContainedFile rejects files over the size cap before reading', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-'))
  const big = join(dir, 'big.txt')
  await writeFile(big, Buffer.alloc(MAX_FILE_BYTES + 1, 0x61))
  try {
    await assert.rejects(() => readContainedFile('big.txt', dir), /too large/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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

test('serializeMessages excludes reasoning and tool results by default', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'reasoning', text: 'secret thinking' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'file contents' }] }], source: { kind: 'tool', callId: 'c1' } },
  ]
  const out = serializeMessages(messages)
  assert.doesNotMatch(out, /secret thinking/)
  assert.doesNotMatch(out, /tool call/)
  assert.doesNotMatch(out, /file contents/)

  const full = serializeMessages(messages, { includeReasoning: true, includeToolResults: true })
  assert.match(full, /secret thinking/)
  assert.match(full, /\[tool call\] read_file/)
  assert.match(full, /\[tool result\] file contents/)
})

test('serializeMessages redacts obvious secrets', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'key sk-abcdefghijklmnop123456 token Bearer tokenXYZ1234567890' }], source: { kind: 'user' } },
  ]
  const out = serializeMessages(messages)
  assert.doesNotMatch(out, /sk-abcdefghijklmnop123456/)
  assert.doesNotMatch(out, /tokenXYZ1234567890/)
  assert.match(out, /\[REDACTED\]/)
})

test('serializeMessages bounds by message count', () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({
    role: 'user',
    content: [{ type: 'text', text: `message ${i}` }],
    source: { kind: 'user' },
  }))
  const out = serializeMessages(messages, { maxMessages: 3, maxChars: 10000 })
  assert.match(out, /message 9/)
  assert.doesNotMatch(out, /message 5/)
})

test('serializeMessages keeps the tail (newest) when the char cap is hit', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'A'.repeat(500) }], source: { kind: 'user' } },
    { role: 'user', content: [{ type: 'text', text: 'LATEST-TAIL' }], source: { kind: 'user' } },
  ]
  const out = serializeMessages(messages, { maxChars: 60 })
  assert.match(out, /LATEST-TAIL/)
  assert.match(out, /earlier context truncated/)
  assert.doesNotMatch(out, /A{500}/)
})
