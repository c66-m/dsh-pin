import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { nativeMonitorArgs } from '../index.js'

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

const { buildPinnedRows, relativeTime, pruneViewedCompleted, pruneStaleTracked, forgetTracked, terminalStateFromEntries, visiblePinnedRows, shouldAutoExpand, readCurrentId, repairCurrentIdStorage, markPinnedAreaActive, windowPositionFromPrefs, progressFromEntries, buildMonitorRows, monitorDetail, installRecentOrder } = exported._test

test('nativeMonitorArgs launches the WPF monitor with origin and script', () => {
  const args = nativeMonitorArgs('http://127.0.0.1:6425', 'C:/plugin/monitor.ps1')
  assert.ok(args.includes('-STA'))
  assert.equal(args[args.indexOf('-File') + 1], 'C:/plugin/monitor.ps1')
  assert.equal(args[args.indexOf('-Origin') + 1], 'http://127.0.0.1:6425')
})

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

test('terminalStateFromEntries treats manual user stop as normal completion', () => {
  const entry = (seq, type, data) => ({ event: { seq, type, data } })
  assert.equal(terminalStateFromEntries([
    entry(1, 'turn/start', {}),
    entry(2, 'turn/end', { reason: { kind: 'completed' } }),
  ]), 'completed')
  assert.equal(terminalStateFromEntries([
    entry(1, 'turn/start', {}),
    entry(2, 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'user' } } }),
  ]), 'completed')
  assert.equal(terminalStateFromEntries([
    entry(1, 'turn/start', {}),
    entry(2, 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'parent' } } }),
  ]), 'interrupted')
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

test('visiblePinnedRows collapses every row so finished-only lists can shrink', () => {
  const rows = [
    { id: 'run1', state: 'running' },
    { id: 'run2', state: 'running' },
    { id: 'done1', state: 'completed' },
    { id: 'failed', state: 'interrupted' },
  ]
  assert.deepEqual(visiblePinnedRows(rows, false), [])
  assert.deepEqual(visiblePinnedRows(rows, true).map((row) => row.id), ['run1', 'run2', 'done1', 'failed'])
  assert.deepEqual(visiblePinnedRows([], false), [])
  assert.deepEqual(visiblePinnedRows([{ id: 'only', state: 'completed' }], false), [])
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

test('apply never calls native pin/unpin and disposes a previous hot-reload mount', () => {
  let touched = false
  let cleaned = 0
  const services = {
    uiWorkspace: {
      pinSession: () => { touched = true },
      unpinSession: () => { touched = true },
    },
  }
  globalThis.window.__dshPinRunningCleanup__ = () => { cleaned += 1 }
  const ctx = { get: (name) => services[name], effect: (fn) => fn() }
  exported.apply(ctx)
  assert.equal(touched, false)
  assert.equal(cleaned, 1)
  assert.equal(globalThis.window.__dshPinRunningCleanup__, undefined)
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

test('forgetTracked removes an interrupted task from every pinned set', () => {
  const tracked = new Set(['failed', 'run'])
  const viewed = new Set(['failed'])
  const interrupted = new Set(['failed'])
  assert.equal(forgetTracked(tracked, viewed, interrupted, 'failed'), true)
  assert.deepEqual([...tracked], ['run'])
  assert.equal(viewed.size, 0)
  assert.equal(interrupted.size, 0)
  assert.equal(forgetTracked(tracked, viewed, interrupted, 'missing'), false)
})

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    dump: () => Object.fromEntries(map),
  }
}

test('readCurrentId prefers live workspace selection over stale persisted state', () => {
  const storage = memoryStorage({
    'dsh.sessions.current': JSON.stringify({ sessionId: 'session-old' }),
  })
  const uiWorkspace = { selection: { getSnapshot: () => ({ sessionId: 'session-live' }) } }
  assert.equal(readCurrentId(uiWorkspace, storage), 'session-live')
})

test('readCurrentId falls back to persisted JSON and legacy bare session ids', () => {
  assert.equal(
    readCurrentId({}, memoryStorage({ 'dsh.sessions.current': JSON.stringify({ sessionId: 'session-json' }) })),
    'session-json',
  )
  assert.equal(
    readCurrentId({}, memoryStorage({ 'dsh.sessions.current': 'session-legacy' })),
    'session-legacy',
  )
  assert.equal(readCurrentId({}, memoryStorage({ 'dsh.sessions.current': 'not-a-session' })), '')
})

test('repairCurrentIdStorage normalizes legacy bare ids and leaves valid DSH state alone', () => {
  const legacy = memoryStorage({ 'dsh.sessions.current': 'session-legacy' })
  assert.equal(repairCurrentIdStorage(legacy), true)
  assert.equal(legacy.getItem('dsh.sessions.current'), JSON.stringify({ sessionId: 'session-legacy' }))
  assert.equal(repairCurrentIdStorage(legacy), false)

  const valid = memoryStorage({ 'dsh.sessions.current': JSON.stringify({ sessionId: 'session-ok' }) })
  assert.equal(repairCurrentIdStorage(valid), false)
  assert.equal(valid.getItem('dsh.sessions.current'), JSON.stringify({ sessionId: 'session-ok' }))
})

test('markPinnedAreaActive deactivates and hides older pinned areas', () => {
  const makeArea = () => ({ attrs: {}, style: {}, setAttribute(key, value) { this.attrs[key] = value } })
  const older = makeArea()
  const area = makeArea()
  markPinnedAreaActive(area, { querySelectorAll: () => [older] })
  assert.equal(older.attrs['data-dsh-pin-active'], 'false')
  assert.equal(older.style.display, 'none')
  assert.equal(area.attrs['data-dsh-pin-active'], 'true')
  assert.equal(area.style.display, '')
})

test('windowPositionFromPrefs ignores coordinates saved by the old window version', () => {
  assert.deepEqual(windowPositionFromPrefs({ v: 2, left: 8, top: 8 }), { left: null, top: null })
  assert.deepEqual(windowPositionFromPrefs({ v: 3, left: 347, top: 47 }), { left: null, top: null })
  assert.deepEqual(windowPositionFromPrefs({ v: 4, left: 433, top: 64 }), { left: 433, top: 64 })
  assert.deepEqual(windowPositionFromPrefs({ v: 4, left: 'bad', top: 64 }), { left: null, top: 64 })
})

test('progressFromEntries reads the latest turn, step, tool and todo state', () => {
  const entry = (type, data) => ({ event: { type, data } })
  const progress = progressFromEntries([
    entry('turn/start', { turn: 1 }),
    entry('step/start', { step: 1 }),
    entry('tool/call', { name: 'read' }),
    entry('todo/write', { todos: [
      { content: '读代码', status: 'completed' },
      { content: '写测试', status: 'in_progress' },
      { content: '改实现', status: 'pending' },
    ] }),
    entry('step/start', { step: 2 }),
    entry('tool/call', { name: 'run_code' }),
  ])
  assert.equal(progress.turn, 1)
  assert.equal(progress.step, 2)
  assert.equal(progress.tool, 'run_code')
  assert.equal(progress.todoDone, 1)
  assert.equal(progress.todoTotal, 3)
  assert.equal(progress.todoText, '写测试')
})

test('progressFromEntries starts the new turn clean but keeps the last todo plan', () => {
  const entry = (type, data) => ({ event: { type, data } })
  const progress = progressFromEntries([
    entry('turn/start', { turn: 1 }),
    entry('todo/write', { todos: [{ content: '发布', status: 'pending' }] }),
    entry('step/start', { step: 2 }),
    entry('tool/call', { name: 'git' }),
    entry('turn/start', { turn: 2 }),
  ])
  assert.equal(progress.turn, 2)
  assert.equal(progress.step, 0)
  assert.equal(progress.tool, '')
  assert.equal(progress.todoTotal, 1)
})

test('buildMonitorRows puts running first, then interrupted, then completed and attaches progress', () => {
  const rows = [
    { id: 'done', state: 'completed', updatedAt: 40 },
    { id: 'run-old', state: 'running', updatedAt: 10 },
    { id: 'failed', state: 'interrupted', updatedAt: 30 },
    { id: 'run-new', state: 'running', updatedAt: 20 },
  ]
  const progress = new Map([['run-new', { turn: 2, step: 3, todoDone: 1, todoTotal: 4, todoText: '写测试' }]])
  const result = buildMonitorRows(rows, progress)
  assert.deepEqual(result.map((row) => row.id), ['run-new', 'run-old', 'failed', 'done'])
  assert.equal(result[0].progress.todoDone, 1)
  assert.equal(result[1].progress, null)
})

test('buildMonitorRows surfaces pending questions first and labels them', () => {
  const rows = [
    { id: 'done', state: 'completed', updatedAt: 40 },
    { id: 'waiting', state: 'running', updatedAt: 10 },
    { id: 'run', state: 'running', updatedAt: 20 },
  ]
  const statuses = new Map([
    ['waiting', { pendingInteraction: { kind: 'question', questions: [{ question: '要选哪一个？' }] } }],
  ])
  const result = buildMonitorRows(rows, new Map(), statuses)
  assert.deepEqual(result.map((row) => row.id), ['waiting', 'run', 'done'])
  assert.equal(result[0].pendingKind, 'question')
  assert.equal(result[0].pendingText, '要选哪一个？')
  assert.equal(monitorDetail(result[0]), '等待回答')
})

test('monitorDetail shows only the task status label', () => {
  assert.equal(monitorDetail({ state: 'running', time: '刚刚' }, { turn: 2, step: 3, tool: 'run_code', todoDone: 1, todoTotal: 4, todoText: '写测试' }), '任务进行中')
  assert.equal(monitorDetail({ state: 'running', time: '刚刚' }, { turn: 2, step: 3, tool: 'run_code' }), '任务进行中')
  assert.equal(monitorDetail({ state: 'running', time: '刚刚' }, null), '任务进行中')
  assert.equal(monitorDetail({ state: 'interrupted', time: '2分钟' }, null), '任务中断')
  assert.equal(monitorDetail({ state: 'completed', time: '3分钟' }, null), '任务完成')
})

test('installRecentOrder switches manual workspace order to recent', () => {
  const previous = globalThis.localStorage
  const values = new Map([['dsh.workspace.view.v5', JSON.stringify({ groupBy: 'workspace', orderBy: 'manual' })]])
  const calls = []
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  }
  const ctx = {
    get(name) {
      if (name !== 'slots') return undefined
      return {
        entries() {
          return [{ store: { create() { return { actions: { setOrderBy(mode) { calls.push(mode) } } } } } }]
        },
      }
    },
  }
  try {
    installRecentOrder(ctx)
    assert.deepEqual(calls, ['updated'])
    assert.equal(values.get('dsh-pin-running.recent-order.v1'), '1')
  } finally {
    globalThis.localStorage = previous
  }
})
