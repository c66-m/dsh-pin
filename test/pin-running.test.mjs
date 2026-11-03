import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
let exported
globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      exported = factory((name) => {
        throw new Error('unexpected require ' + name)
      })
    },
  },
}
new Function('window', source)(globalThis.window)

const { buildPinnedRows, relativeTime, pruneViewedCompleted, pruneStaleTracked } = exported._test

test('buildPinnedRows lists tracked sessions, completed ones stay until consumed', () => {
  const now = 1000 * 60 * 10
  const list = {
    ids: ['run', 'newer', 'done', 'archived', 'blank', 'subagent', 'untracked'],
    byId: {
      run: { id: 'run', title: '运行中', running: true, updatedAt: now - 9 * 60000, cwd: 'C:/a' },
      newer: { id: 'newer', title: '刚跑', running: true, updatedAt: now - 60000 },
      done: { id: 'done', title: '已完成', running: false, updatedAt: now - 8 * 60000, cwd: 'C:/b' },
      archived: { id: 'archived', title: '归档', running: false, updatedAt: now - 60000 },
      blank: { id: 'blank', blank: true, running: false, updatedAt: now - 60000 },
      subagent: { id: 'subagent', title: '子代理', running: false, origin: 'subagent', updatedAt: now - 60000 },
      untracked: { id: 'untracked', title: '没进清单', running: true, updatedAt: now - 60000 },
    },
  }
  const registry = {
    archivedSessionIds: ['archived'],
    items: [{ workspaceId: 'w', path: 'C:/proj', title: 'proj', sessionIds: ['run', 'newer', 'done'] }],
  }
  const tracked = new Set(['run', 'newer', 'done', 'archived', 'blank', 'subagent'])
  const rows = buildPinnedRows(list, registry, 'done', now, tracked)
  assert.deepEqual(rows.map((row) => row.id), ['newer', 'run', 'done'])
  assert.equal(rows[0].path, 'C:/proj')
  assert.equal(rows[2].current, true)
  assert.equal(rows[2].running, false)
  assert.equal(rows[1].time, '9分钟')
})

test('buildPinnedRows trusts live status over stale summary running flag', () => {
  const list = {
    ids: ['stale'],
    byId: { stale: { id: 'stale', title: '早跑完了', running: true, updatedAt: 100 } },
  }
  const registry = { archivedSessionIds: [], items: [] }
  const done = buildPinnedRows(list, registry, '', 1000, new Set(['stale']), new Map([['stale', { running: false }]]))
  assert.equal(done.length, 1)
  assert.equal(done[0].running, false)
})

test('completed viewed items are consumed only after switching to another task', () => {
  const tracked = new Set(['done', 'running', 'keep'])
  const viewed = new Set(['done', 'running', 'keep'])
  const running = { done: false, running: true, keep: false }
  const changed = pruneViewedCompleted(tracked, viewed, (id) => running[id], 'keep')
  assert.equal(changed, true)
  assert.deepEqual([...tracked].sort(), ['keep', 'running'])
  assert.deepEqual([...viewed].sort(), ['keep', 'running'])

  pruneViewedCompleted(tracked, viewed, (id) => running[id], 'running')
  assert.deepEqual([...tracked], ['running'])
  assert.deepEqual([...viewed], ['running'])
})

test('relativeTime switches units', () => {
  assert.equal(relativeTime(0, 1000), '')
  assert.equal(relativeTime(1000, 1000 + 30 * 1000), '刚刚')
  assert.equal(relativeTime(1000, 1000 + 2 * 3600 * 1000), '2小时')
  assert.equal(relativeTime(1000, 1000 + 3 * 24 * 3600 * 1000), '3天')
})

test('apply never calls native pin/unpin', () => {
  let touched = false
  const services = {
    uiWorkspace: {
      pinSession: () => { touched = true },
      unpinSession: () => { touched = true },
    },
  }
  const ctx = { get: (name) => services[name], effect: (fn) => fn() }
  exported.apply(ctx)
  assert.equal(touched, false)
})

test('pruneStaleTracked drops archived, missing, blank and subagent ids', () => {
  const tracked = new Set(['gone', 'archived', 'blank', 'subagent', 'run', 'done'])
  const viewed = new Set(['gone', 'archived', 'run'])
  const list = {
    ids: ['archived', 'blank', 'subagent', 'run', 'done'],
    byId: {
      archived: { id: 'archived', archived: true },
      blank: { id: 'blank', blank: true },
      subagent: { id: 'subagent', origin: 'subagent' },
      run: { id: 'run', running: true },
      done: { id: 'done', running: false },
    },
  }
  assert.equal(pruneStaleTracked(tracked, viewed, list), true)
  assert.deepEqual([...tracked].sort(), ['done', 'run'])
  assert.deepEqual([...viewed].sort(), ['run'])
  assert.equal(pruneStaleTracked(tracked, viewed, list), false)
})