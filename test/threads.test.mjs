import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ThreadStore } from '../lib/threads.js'

test('ThreadStore persists and resumes threads per cwd', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-threads-'))
  const file = join(dir, 'threads.json')
  try {
    const store = new ThreadStore(file)
    await store.load()
    const thread = store.create('/repo/a')
    await store.append(thread, { role: 'user', content: 'task' }, { role: 'assistant', content: 'answer' })

    // A fresh store reads the same persisted state.
    const reloaded = new ThreadStore(file)
    await reloaded.load()
    const latest = reloaded.latest('/repo/a')
    assert.equal(latest.id, thread.id)
    assert.equal(latest.messages.length, 2)
    assert.equal(latest.messages[1].content, 'answer')
    assert.equal(reloaded.latest('/repo/b'), undefined)
    assert.equal(reloaded.get(thread.id).id, thread.id)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ThreadStore latest sorts by recency', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-threads-'))
  const file = join(dir, 'threads.json')
  try {
    const store = new ThreadStore(file)
    await store.load()
    const first = store.create('/repo')
    const second = store.create('/repo')
    // Bump the first thread's updatedAt past the second via append.
    await store.append(first, { role: 'user', content: 'again' })
    assert.equal(store.latest('/repo').id, first.id)
    assert.equal(store.get(second.id).id, second.id)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
