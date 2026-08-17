import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getBranchDiff, getUncommittedDiff } from '../lib/git.js'

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-git-'))
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 't@example.com'])
  git(['config', 'user.name', 't'])
  await writeFile(join(dir, 'a.txt'), 'one\n')
  git(['add', 'a.txt'])
  git(['commit', '-q', '-m', 'init'])
  return { dir, git }
}

test('getUncommittedDiff returns the working-tree diff', async () => {
  const { dir } = await makeRepo()
  try {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\n')
    const r = await getUncommittedDiff(dir)
    assert.equal(r.kind, 'diff')
    assert.match(r.text, /\+two/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('getUncommittedDiff is empty on a clean tree', async () => {
  const { dir } = await makeRepo()
  try {
    const r = await getUncommittedDiff(dir)
    assert.equal(r.kind, 'empty')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('getBranchDiff diffs a base branch', async () => {
  const { dir, git } = await makeRepo()
  try {
    git(['checkout', '-q', '-b', 'feature'])
    await writeFile(join(dir, 'a.txt'), 'one\nfeature\n')
    git(['add', 'a.txt'])
    git(['commit', '-q', '-m', 'feature'])
    const r = await getBranchDiff(dir, 'main')
    assert.equal(r.kind, 'diff')
    assert.match(r.text, /\+feature/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('getUncommittedDiff reports an error outside a repo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-nogit-'))
  try {
    const r = await getUncommittedDiff(dir)
    assert.equal(r.kind, 'error')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
