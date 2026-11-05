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

const { buildPinnedRows, relativeTime, pruneViewedCompleted, pruneStaleTracked, terminalStateFromEntries, visiblePinnedRows, shouldAutoExpand } = exported._test

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
  assert.deepEqual(rows.map((row) => row.id), ['done', 'newer', 'run'])
  assert.equal(rows[0].path, 'C:/proj')
  assert.equal(rows[0].current, true)
  assert.equal(rows[0].running, false)
  assert.equal(rows[1].time, '1分钟')
  assert.equal(rows[2].time, '9分钟')
})

test('buildPinnedRows puts completed tasks above running and interrupted ones', () => {
  const list = {
    ids: ['run', 'failed', 'done-old', 'done-new'],
    byId: {
      run: { id: 'run', title: '运行', running: true, updatedAt: 300 },
      failed: { id: 'failed', title: '失败', running: false, updatedAt: 200 },
      'done-old': { id: 'done-old', title: '早完成', running: false, updatedAt: 400 },
      'done-new': { id: 'done-new', title: '刚完成', running: false, updatedAt: 500 },
    },
  }
  const rows = buildPinnedRows(list, { archivedSessionIds: [], items: [] }, '', 1000, new Set(list.ids), undefined, new Set(['failed']))
  assert.deepEqual(rows.map((row) => row.id), ['done-new', 'done-old', 'run', 'failed'])
  assert.deepEqual(rows.map((row) => row.state), ['completed', 'completed', 'running', 'interrupted'])
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

test('terminalStateFromEntries marks abnormal or unfinished turns as interrupted', () => {
  const entry = (seq, type, data) => ({ event: { seq, type, data } })
  assert.equal(terminalStateFromEntries([
    entry(1, 'turn/start', {}),
    entry(2, 'turn/end', { reason: { kind: 'completed' } }),
  ]), 'completed')
  assert.equal(terminalStateFromEntries([
    entry(1, 'turn/start', {}),
    entry(2, 'turn/end', { reason: { kind: 'interrupted' } }),
  ]), 'interrupted')
  assert.equal(terminalStateFromEntries([
    entry(1, 'turn/start', {}),
    entry(2, 'turn/end', { reason: { kind: 'error', error: { message: 'boom' } } }),
  ]), 'interrupted')
  assert.equal(terminalStateFromEntries([entry(1, 'turn/start', {})]), 'interrupted')
})

test('buildPinnedRows marks interrupted tasks with steady yellow state', () => {
  const list = {
    ids: ['stopped', 'done', 'run'],
    byId: {
      stopped: { id: 'stopped', title: '中断', running: false, updatedAt: 300 },
      done: { id: 'done', title: '完成', running: false, updatedAt: 200 },
      run: { id: 'run', title: '运行', running: true, updatedAt: 100 },
    },
  }
  const rows = buildPinnedRows(list, { archivedSessionIds: [], items: [] }, '', 1000, new Set(['stopped', 'done', 'run']), undefined, new Set(['stopped']))
  assert.deepEqual(rows.map((row) => row.id), ['done', 'run', 'stopped'])
  assert.equal(rows[0].state, 'completed')
  assert.equal(rows[1].state, 'running')
  assert.equal(rows[2].state, 'interrupted')
  assert.equal(rows[2].interrupted, true)
})

test('failed/interrupted viewed items stay pinned after switching to another task', () => {
  const tracked = new Set(['failed', 'done', 'running'])
  const viewed = new Set(['failed', 'done'])
  const running = { failed: false, done: false, running: true }
  const changed = pruneViewedCompleted(tracked, viewed, (id) => running[id], 'other', (id) => id === 'failed')
  assert.equal(changed, true)
  assert.deepEqual([...tracked].sort(), ['failed', 'running'])
  assert.deepEqual([...viewed].sort(), ['failed'])
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

test('visiblePinnedRows collapses running rows but keeps finished rows fully visible', () => {
  const rows = [
    { id: 'run1', state: 'running' },
    { id: 'run2', state: 'running' },
    { id: 'done1', state: 'completed' },
    { id: 'failed', state: 'interrupted' },
  ]
  assert.deepEqual(visiblePinnedRows(rows, false).map((row) => row.id), ['run1', 'done1', 'failed'])
  assert.deepEqual(visiblePinnedRows(rows, true).map((row) => row.id), ['run1', 'run2', 'done1', 'failed'])
  assert.deepEqual(visiblePinnedRows([], false), [])
  assert.deepEqual(visiblePinnedRows([{ id: 'only', state: 'completed' }], false).map((row) => row.id), ['only'])
})

test('completed transition auto-expands the collapsed pinned bar', () => {
  const previous = new Map([['run', 'running'], ['done', 'completed']])
  assert.equal(shouldAutoExpand(previous, [
    { id: 'run', state: 'completed' },
    { id: 'done', state: 'completed' },
  ]), true)
  assert.equal(shouldAutoExpand(new Map([['done', 'completed']]), [
    { id: 'done', state: 'completed' },
  ]), false)
  assert.equal(shouldAutoExpand(new Map(), [{ id: 'first', state: 'completed' }]), false)
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