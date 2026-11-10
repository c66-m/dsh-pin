/**
 * dsh-pin-running —— 浏览器半端
 * ============================================================================
 * 在侧栏「工作区」标题下渲染一个独立的置顶区，不按目录分组，也不把会话从
 * 原文件夹移走。运行中的会话自动进入；跑完/中断/失败继续留着，已完成项点开
 * 后切到别的任务才移除；置顶栏收起时只藏运行中的多余条目，完成/中断/失败
 * 条目始终完整显示；点击一律调用
 * uiWorkspace.openSession，由 DSH 回到原 workspace/cwd。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-pin-running',
  factory: () => {
    const NAME = '[pin-running]'
    const STYLE_ID = 'dsh-pin-running-style-v4'
    const CURRENT_KEY = 'dsh.sessions.current'
    const STORE_KEY = 'dsh-pin-running.tasks.v1'
    const VIEWED_KEY = 'dsh-pin-running.viewed.v1'
    const INTERRUPTED_KEY = 'dsh-pin-running.interrupted.v1'
    const WINDOW_KEY = 'dsh-pin-running.window.v1'
    const MONITOR_PREFIX = '/dsh-pin-running'

    /** 和 Host 半端通信：任务快照、焦点队列、独立窗口开关。 */
    function monitorRequest(path, body) {
      if (typeof fetch !== 'function') return Promise.resolve(null)
      const init = body === undefined
        ? { cache: 'no-store' }
        : { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      return fetch(MONITOR_PREFIX + path, init)
        .then((response) => response.ok ? response.json() : null)
        .catch(() => null)
    }

    /** 运行状态以 uiSession.sessionStatus 为准，缺失时退回会话摘要。 */
    function isRunning(session, status) {
      if (!session) return false
      if (status) return status.running === true
      return session.running === true || (Number(session.runningSubagentCount) || 0) > 0
    }

    function loadIds(key) {
      try {
        const value = JSON.parse(localStorage.getItem(key) || '[]')
        return new Set(Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [])
      } catch {
        return new Set()
      }
    }

    function saveIds(key, ids, label) {
      try {
        localStorage.setItem(key, JSON.stringify([...ids]))
      } catch (error) {
        console.warn(NAME, 'save ' + label + ' failed', error)
      }
    }

    const loadTracked = () => loadIds(STORE_KEY)
    const loadViewed = () => loadIds(VIEWED_KEY)
    const loadInterrupted = () => loadIds(INTERRUPTED_KEY)
    const saveTracked = (ids) => saveIds(STORE_KEY, ids, 'tasks')
    const saveViewed = (ids) => saveIds(VIEWED_KEY, ids, 'viewed')
    const saveInterrupted = (ids) => saveIds(INTERRUPTED_KEY, ids, 'interrupted')

    /** 从 DSH 持久化值里解析 sessionId：新格式是 {"sessionId":"..."}，旧版插件可能留下裸 id。 */
    function parseCurrentId(raw) {
      if (!raw) return ''
      try {
        const parsed = JSON.parse(raw)
        if (typeof parsed === 'string') return parsed.startsWith('session-') ? parsed : ''
        if (parsed && typeof parsed === 'object' && typeof parsed.sessionId === 'string' && parsed.sessionId) {
          return parsed.sessionId
        }
      } catch {
        return raw.startsWith('session-') ? raw : ''
      }
      return ''
    }

    /** 当前会话优先读 uiWorkspace.selection；它才是 DSH 的真实状态，localStorage 只做回退。 */
    function readCurrentId(uiWorkspace, storage) {
      try {
        const selection = uiWorkspace && uiWorkspace.selection
        const snapshot = selection && typeof selection.getSnapshot === 'function' ? selection.getSnapshot() : null
        if (snapshot && typeof snapshot.sessionId === 'string' && snapshot.sessionId) return snapshot.sessionId
      } catch {}
      return parseCurrentId(storage && typeof storage.getItem === 'function' ? storage.getItem(CURRENT_KEY) : '')
    }

    /** 旧版插件把裸 sessionId 写进 DSH 的持久化键，启动时修回对象格式，避免下次刷新丢当前会话。 */
    function repairCurrentIdStorage(storage) {
      if (!storage || typeof storage.getItem !== 'function') return false
      let raw
      try {
        raw = storage.getItem(CURRENT_KEY)
      } catch {
        return false
      }
      if (!raw) return false
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        if (!raw.startsWith('session-')) return false
        try {
          storage.setItem(CURRENT_KEY, JSON.stringify({ sessionId: raw }))
          return true
        } catch {
          return false
        }
      }
      if (typeof parsed === 'string' && parsed.startsWith('session-')) {
        try {
          storage.setItem(CURRENT_KEY, JSON.stringify({ sessionId: parsed }))
          return true
        } catch {
          return false
        }
      }
      return false
    }

    /** 同一页面只让最新一块置顶区可见；旧 HMR 实例留下的区域由 CSS 兜底隐藏。 */
    function markPinnedAreaActive(area, root) {
      const doc = root || (typeof document !== 'undefined' ? document : null)
      if (doc && typeof doc.querySelectorAll === 'function') {
        for (const existing of doc.querySelectorAll('.dsh-pin-running-area')) {
          existing.setAttribute('data-dsh-pin-active', 'false')
          if (existing !== area && existing.style) existing.style.display = 'none'
        }
      }
      area.setAttribute('data-dsh-pin-active', 'true')
      if (area.style) area.style.display = ''
    }

    /**
     * 切到别的任务时才消费：已完成、且点开看过的项从置顶区移除。
     * keepId 是刚切过去的任务，不能在同一拍被清掉。
     */
    function pruneViewedCompleted(tracked, viewed, isRunningById, keepId, isInterruptedById) {
      let changed = false
      for (const id of [...viewed]) {
        if (id === keepId) continue
        if (!tracked.has(id)) {
          viewed.delete(id)
          changed = true
          continue
        }
        // 失败/中断的任务要一直留在置顶区，不能像已完成项那样看过就消费。
        if (!isRunningById(id) && !(isInterruptedById && isInterruptedById(id))) {
          tracked.delete(id)
          viewed.delete(id)
          changed = true
        }
      }
      return changed
    }

    /**
     * 清掉已不在列表里的 tracked 项：被归档、被删、变空白或变成 subagent 的
     * 会话不再进置顶区，也不应继续占着 localStorage。只在列表 phase=ready
     * 时调用，避免刷新间隙误删。
     */
    function pruneStaleTracked(tracked, viewed, list) {
      const byId = (list && list.byId) || {}
      let changed = false
      for (const id of [...tracked]) {
        const session = byId[id]
        if (!session || session.archived || session.blank || session.origin === 'subagent') {
          tracked.delete(id)
          viewed.delete(id)
          changed = true
        }
      }
      return changed
    }

    /** 用户从小窗/置顶区删掉一个任务：三个持久化集合一起清，避免残留。 */
    function forgetTracked(tracked, viewed, interrupted, id) {
      const had = tracked.delete(id)
      viewed.delete(id)
      interrupted.delete(id)
      return had
    }

    /** 收起时整区只留标题；展开时显示全部行。 */
    function visiblePinnedRows(rows, expanded) {
      return expanded ? rows : []
    }

    /** 运行中的任务刚结束（完成/失败/中断）时强制展开，别让完成状态被收起遮住。 */
    function shouldAutoExpand(previousStates, rows) {
      for (const row of rows) {
        if (previousStates.get(row.id) === 'running' && row.state !== 'running') return true
      }
      return false
    }

    /** 相对时间，够用即可；原生行也是分钟/小时/天。 */
    function relativeTime(updatedAt, now) {
      const stamp = Number(updatedAt) || 0
      if (!stamp) return ''
      const minutes = Math.floor(Math.max(0, now - stamp) / 60000)
      if (minutes < 1) return '刚刚'
      if (minutes < 60) return minutes + '分钟'
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return hours + '小时'
      return Math.floor(hours / 24) + '天'
    }

    /**
     * 从会话事件里读最后一轮的状态：completed 和用户手动停止（aborted/user）
     * 算正常完成；error/aborted/interrupted/max-tokens/blocked 等或只有
     * turn/start 没有 turn/end，都算中断。
     */
    function terminalStateFromEntries(entries) {
      let state
      for (const entry of entries || []) {
        const event = entry && entry.event
        if (!event) continue
        if (event.type === 'turn/start') state = 'interrupted'
        else if (event.type === 'turn/end') {
          const reason = event.data && event.data.reason
          const kind = reason && reason.kind
          const manualStop = kind === 'aborted' && reason.reason && reason.reason.kind === 'user'
          state = kind === 'completed' || manualStop ? 'completed' : 'interrupted'
        }
      }
      return state
    }

    /**
     * 从事件流里读最近一轮的进度：轮次、步骤、最近工具、todo 完成数。
     * 所有字段都只用于小窗口展示，不参与置顶/清理判断。
     */
    function progressFromEntries(entries) {
      let turn = 0
      let step = 0
      let tool = ''
      let todos = null
      for (const entry of entries || []) {
        const event = entry && entry.event
        if (!event) continue
        const data = event.data || {}
        if (event.type === 'turn/start') {
          turn = Number(data.turn) || 0
          step = 0
          tool = ''
        } else if (event.type === 'step/start') {
          step = Number(data.step) || 0
          tool = ''
        } else if (event.type === 'tool/call') {
          tool = typeof data.name === 'string' ? data.name : ''
        } else if (event.type === 'todo/write' && Array.isArray(data.todos)) {
          todos = data.todos
        }
      }
      const total = todos ? todos.length : 0
      const done = todos ? todos.filter((todo) => todo && todo.status === 'completed').length : 0
      const active = todos ? todos.find((todo) => todo && todo.status === 'in_progress') : null
      return { turn, step, tool, todoDone: done, todoTotal: total, todoText: (active && active.content) || '' }
    }

    const PENDING_LABELS = { approval: '等待审批', 'plan-review': '计划待审', question: '等待回答' }

    /** 只把 DSH 认得的交互类型带到小窗；未知交互不打扰。 */
    function pendingKindOf(status) {
      const kind = status && status.pendingInteraction && status.pendingInteraction.kind
      return PENDING_LABELS[kind] ? kind : ''
    }

    /** 小窗能显示的具体问题/审批原因，点击整行仍走 DSH 原生交互。 */
    function pendingTextOf(status) {
      const interaction = status && status.pendingInteraction
      if (!interaction) return ''
      const question = Array.isArray(interaction.questions) ? interaction.questions[0] : null
      if (question && typeof question.question === 'string') return question.question
      if (typeof interaction.displayReason === 'string') return interaction.displayReason
      if (typeof interaction.reason === 'string') return interaction.reason
      return ''
    }

    function monitorStatusLabel(row) {
      if (row && row.pendingKind) return PENDING_LABELS[row.pendingKind] || '等待选择'
      if (!row) return ''
      if (row.state === 'interrupted') return '任务中断'
      if (row.state === 'completed') return '任务完成'
      return '任务进行中'
    }

    /** 小窗口按「待选择 → 运行中 → 中断 → 完成」排；完成项也保留但排最后。 */
    function buildMonitorRows(rows, progressById, statusMap) {
      const rank = { pending: 0, running: 1, interrupted: 2, completed: 3 }
      return [...(rows || [])].map((row) => {
        const status = statusMap && typeof statusMap.get === 'function' ? statusMap.get(row.id) : null
        const pendingKind = pendingKindOf(status)
        return {
          ...row,
          pendingKind,
          pendingText: pendingKind ? pendingTextOf(status) : '',
          progress: progressById && typeof progressById.get === 'function' ? progressById.get(row.id) || null : null,
        }
      }).sort((a, b) => {
        const ar = a.pendingKind ? rank.pending : rank[a.state]
        const br = b.pendingKind ? rank.pending : rank[b.state]
        return ar - br || b.updatedAt - a.updatedAt
      })
    }

    /** 小窗第二行只显示状态，不再显示轮次/步骤明细。 */
    function monitorDetail(row, progress) {
      return monitorStatusLabel(row)
    }

    /** 同一页面只让最新一个小窗口可见，旧 HMR 实例留下的窗口由 CSS 兜底隐藏。 */
    function markTaskWindowActive(win, root) {
      const doc = root || (typeof document !== 'undefined' ? document : null)
      if (doc && typeof doc.querySelectorAll === 'function') {
        for (const existing of doc.querySelectorAll('.dsh-task-window')) {
          existing.setAttribute('data-dsh-task-active', 'false')
          if (existing !== win && existing.style) existing.style.display = 'none'
        }
      }
      win.setAttribute('data-dsh-task-active', 'true')
      if (win.style) win.style.display = ''
    }

    function loadWindowPrefs() {
      try {
        const value = JSON.parse(localStorage.getItem(WINDOW_KEY) || 'null')
        return value && typeof value === 'object' ? value : {}
      } catch {
        return {}
      }
    }

    /** 只有 v3 起保存的坐标可信；旧版把窗口钳到左上角 8,8，不能恢复。 */
    function windowPositionFromPrefs(prefs) {
      const trusted = prefs && prefs.v === 4
      return {
        left: trusted && Number.isFinite(Number(prefs.left)) ? Number(prefs.left) : null,
        top: trusted && Number.isFinite(Number(prefs.top)) ? Number(prefs.top) : null,
      }
    }

    function saveWindowPrefs(prefs) {
      try {
        localStorage.setItem(WINDOW_KEY, JSON.stringify(prefs))
      } catch (error) {
        console.warn(NAME, 'save window prefs failed', error)
      }
    }

    /**
     * 生成置顶区行：trackedIds 是插件记住的任务。完成的任务排最上面（常绿），
     * 之后是运行中，最后是中断（黄点常亮）；原文件夹里的行保持不动。
     */
    function buildPinnedRows(list, registry, currentId, now, trackedIds, statuses, interruptedIds) {
      const ids = Array.isArray(list && list.ids) ? list.ids : []
      const byId = (list && list.byId) || {}
      const archived = new Set((registry && registry.archivedSessionIds) || [])
      const workspaces = Array.isArray(registry && registry.items) ? registry.items : []
      const workspaceOf = new Map()
      for (const workspace of workspaces) {
        for (const sessionId of workspace.sessionIds || []) workspaceOf.set(sessionId, workspace)
      }

      const rows = []
      for (const id of ids) {
        const session = byId[id]
        if (!session || !trackedIds.has(id) || archived.has(id) || session.archived) continue
        if (session.blank || session.origin === 'subagent') continue
        const workspace = workspaceOf.get(id)
        const running = isRunning(session, statuses && statuses.get(id))
        const interrupted = !running && Boolean(interruptedIds && interruptedIds.has(id))
        rows.push({
          id,
          title: (session.title && session.title.trim()) || '未命名会话',
          running,
          interrupted,
          state: running ? 'running' : interrupted ? 'interrupted' : 'completed',
          updatedAt: Number(session.updatedAt) || 0,
          path: (workspace && workspace.path) || session.cwd || '',
          current: id === currentId,
          time: relativeTime(session.updatedAt, now),
        })
      }
      const rank = { completed: 0, running: 1, interrupted: 2 }
      rows.sort((a, b) => rank[a.state] - rank[b.state] || b.updatedAt - a.updatedAt)
      return rows
    }

    /** 注入一次样式；颜色走 currentColor/透明度，亮暗主题都能用。 */
    function installStyle() {
      if (document.getElementById(STYLE_ID)) return
      for (const id of ['dsh-pin-running-style', 'dsh-pin-running-style-v2', 'dsh-pin-running-style-v3']) {
        const old = document.getElementById(id)
        if (old) old.remove()
      }
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
        .dsh-pin-running-area { display: flex; flex-direction: column; gap: 1px; padding: 0 8px 6px; flex: 0 0 auto; max-height: min(40vh, 320px); overflow-y: auto; }
        .dsh-pin-running-area[hidden] { display: none; }
        .dsh-pin-running-area:not([data-dsh-pin-active="true"]) { display: none !important; }
        .dsh-pin-running-head { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px; border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit; font-size: 11px; letter-spacing: .08em; text-align: left; cursor: pointer; opacity: .55; }
        .dsh-pin-running-head:hover { background: color-mix(in srgb, currentColor 8%, transparent); opacity: .8; }
        .dsh-pin-running-head[data-expanded="true"] { opacity: .7; }
        .dsh-pin-running-count { margin-left: auto; font-variant-numeric: tabular-nums; }
        .dsh-pin-running-chevron { font-size: 10px; transition: transform .15s ease; }
        .dsh-pin-running-head[data-expanded="true"] .dsh-pin-running-chevron { transform: rotate(180deg); }
        .dsh-pin-running-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 8px; border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
        .dsh-pin-running-row:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
        .dsh-pin-running-row[data-current="true"] { background: color-mix(in srgb, currentColor 14%, transparent); }
        .dsh-pin-running-dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: #2fbf71; box-shadow: 0 0 0 3px rgba(47, 191, 113, .16); }
        .dsh-pin-running-dot[data-state="running"] { animation: dsh-pin-running-pulse 1.4s ease-in-out infinite; }
        .dsh-pin-running-dot[data-state="interrupted"] { background: #e0a400; box-shadow: 0 0 0 3px rgba(224, 164, 0, .22); }
        .dsh-pin-running-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .dsh-pin-running-time { flex: none; font-size: 11px; opacity: .5; font-variant-numeric: tabular-nums; }
        .dsh-pin-running-remove { flex: none; width: 15px; height: 15px; display: grid; place-items: center; border-radius: 4px; font-size: 13px; line-height: 1; opacity: .5; }
        .dsh-pin-running-remove:hover { background: color-mix(in srgb, currentColor 14%, transparent); opacity: 1; }
        .dsh-pin-running-notice { padding: 4px 8px 6px; font-size: 11px; opacity: .6; }
        @keyframes dsh-pin-running-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }

        .dsh-task-window-toggle { display: none; position: fixed; top: 8px; right: 140px; z-index: 2147483000; width: 30px; height: 24px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; place-items: center; opacity: .5; -webkit-app-region: no-drag; }
        html[data-windows-titlebar] .dsh-task-window-toggle { display: grid; }
        .dsh-task-window-toggle:hover { background: color-mix(in srgb, currentColor 12%, transparent); opacity: .9; }
        .dsh-task-window-toggle[data-active="true"] { opacity: 1; color: #e0a400; }
        .dsh-task-window-toggle svg { width: 14px; height: 14px; }

        .dsh-task-window { position: fixed; z-index: 30; width: 268px; box-sizing: border-box; border: .5px solid var(--dsw-alias-border-l3, rgba(127, 127, 127, .3)); border-radius: 12px; background: color-mix(in srgb, var(--dsw-alias-bg-base, #fff) 94%, transparent); color: var(--dsw-alias-text-primary, inherit); box-shadow: 0 8px 28px rgba(0, 0, 0, .18); backdrop-filter: blur(16px); font-family: var(--dsh-font-family-text, inherit); font-size: 12px; overflow: hidden; pointer-events: auto; }
        .dsh-task-window[data-pinned="true"] { z-index: 999; box-shadow: 0 12px 36px rgba(0, 0, 0, .24); }
        .dsh-task-window[data-pinned="false"] { opacity: .9; }
        .dsh-task-window:not([data-dsh-task-active="true"]) { display: none !important; }
        .dsh-task-window[data-open="false"] { display: none !important; }
        .dsh-task-window[data-collapsed="true"] { width: 156px; }
        .dsh-task-window[data-collapsed="true"] .dsh-task-window-body { display: none; }
        .dsh-task-window-head { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 6px 0 9px; cursor: move; user-select: none; }
        .dsh-task-window-head:active { cursor: grabbing; }
        .dsh-task-window-title { font-size: 11px; letter-spacing: .04em; opacity: .68; white-space: nowrap; }
        .dsh-task-window-count { padding: 1px 5px; border-radius: 999px; background: color-mix(in srgb, currentColor 10%, transparent); font-size: 10px; line-height: 14px; font-variant-numeric: tabular-nums; opacity: .65; }
        .dsh-task-window-spacer { flex: 1; }
        .dsh-task-window-btn { display: grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit; font-size: 13px; line-height: 1; cursor: pointer; opacity: .5; }
        .dsh-task-window-btn:hover { background: color-mix(in srgb, currentColor 10%, transparent); opacity: .9; }
        .dsh-task-window-pin[aria-pressed="true"] { opacity: 1; color: #e0a400; }
        .dsh-task-window-body { display: flex; flex-direction: column; gap: 1px; max-height: 232px; overflow-y: auto; padding: 0 6px 7px; }
        .dsh-task-window-row { display: flex; align-items: flex-start; gap: 7px; width: 100%; padding: 6px; border: 0; border-radius: 7px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
        .dsh-task-window-row:hover { background: color-mix(in srgb, currentColor 9%, transparent); }
        .dsh-task-window-row[data-current="true"] { background: color-mix(in srgb, currentColor 13%, transparent); }
        .dsh-task-window-row .dsh-pin-running-dot { margin-top: 4px; }
        .dsh-task-window-main { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 2px; }
        .dsh-task-window-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 15px; }
        .dsh-task-window-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; line-height: 13px; opacity: .48; font-variant-numeric: tabular-nums; }
        .dsh-task-window-row[data-state="interrupted"] .dsh-task-window-detail { color: #e0a400; opacity: .82; }
        .dsh-task-window-empty { padding: 5px 6px 8px; font-size: 11px; opacity: .45; }
      `
      document.head.appendChild(style)
    }

    /**
     * 找到侧栏 WorkspaceBrowser 的挂载点。类名带构建哈希，按语义后缀匹配：
     * 新版桌面是 regionArea > sectionHeader("工作区") + 列表，插到 header 之后；
     * 旧版 CLI 是 regionArea > root > listArea，插到 listArea 之前。
     */
    function findMount() {
      const root = document.querySelector('.hHd-Xa_regionArea .bhn1Oq_root')
      if (root) {
        const listArea = root.querySelector('.bhn1Oq_listArea')
        return { parent: root, ref: listArea, position: 'before' }
      }
      const region = document.querySelector('[class*="_regionArea"]')
      if (!region) return
      const header = region.querySelector('[class*="_sectionHeader"]')
      if (header && header.parentElement) return { parent: header.parentElement, ref: header, position: 'after' }
      return { parent: region, ref: null, position: 'first' }
    }

    /** 置顶区 + 数据订阅 + React 重渲染后的自动复位。 */
    function installPinnedArea(ctx) {
      const sessions = ctx.get('sessions')
      const workspaces = ctx.get('workspaces')
      const uiWorkspace = ctx.get('uiWorkspace')
      const statuses = ctx.get('uiSession')?.sessionStatus
      let tracked = loadTracked()
      const viewed = loadViewed()
      const storage = typeof localStorage !== 'undefined' ? localStorage : null
      if (storage) repairCurrentIdStorage(storage)
      let currentId = readCurrentId(uiWorkspace, storage)
      let expanded = true
      const previousStates = new Map()
      let mountWarned = false

      installStyle()
      const area = document.createElement('div')
      area.className = 'dsh-pin-running-area'
      area.hidden = true
      markPinnedAreaActive(area)

      // 任务监控是独立的本机浏览器 --app 窗口，由 Host 半端启动。渲染器里
      // 只保留标题栏入口；旧版 DOM 浮层（含 HMR 残留）在安装时清掉。
      for (const stale of document.querySelectorAll('.dsh-task-window, .dsh-task-window-toggle')) stale.remove()
      const toggleBtn = document.createElement('button')
      toggleBtn.type = 'button'
      toggleBtn.className = 'dsh-task-window-toggle'
      toggleBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="12" height="9" rx="2"></rect><rect x="9" y="10" width="12" height="9" rx="2"></rect></svg>'
      document.body.appendChild(toggleBtn)

      let monitorOpen = false
      const applyMonitorChrome = () => {
        toggleBtn.dataset.active = String(monitorOpen)
        toggleBtn.title = monitorOpen ? '关闭任务监控窗口' : '打开任务监控窗口'
        toggleBtn.setAttribute('aria-label', toggleBtn.title)
        toggleBtn.setAttribute('aria-pressed', String(monitorOpen))
      }
      const setMonitorOpen = (open) => {
        monitorOpen = Boolean(open)
        applyMonitorChrome()
      }
      toggleBtn.addEventListener('click', async () => {
        const state = await monitorRequest('/window', { action: monitorOpen ? 'close' : 'open' })
        if (state) setMonitorOpen(state.open)
      })
      monitorRequest('/window').then((state) => { if (state) setMonitorOpen(state.open) })

      const ensureMounted = () => {
        const mount = findMount()
        if (!mount) {
          if (!mountWarned) {
            mountWarned = true
            console.warn(NAME, 'sidebar mount not found, pinned area hidden; DSH sidebar structure may have changed')
          }
          return false
        }
        mountWarned = false
        const placed =
          area.parentElement === mount.parent &&
          (mount.position === 'first'
            ? area.previousElementSibling === null
            : mount.position === 'after'
              ? area.previousElementSibling === mount.ref
              : area.nextElementSibling === mount.ref)
        if (!placed) {
          const before = mount.position === 'after' ? mount.ref.nextSibling : mount.ref
          mount.parent.insertBefore(area, before)
        }
        return true
      }

      const showNotice = (message) => {
        const note = document.createElement('div')
        note.className = 'dsh-pin-running-notice'
        note.textContent = message
        // 点击处理会先 render()：会话已消失时 render 会把置顶区藏起来，
        // 提示必须先把区打开，否则写进了隐藏的区里用户看不到。
        area.hidden = false
        area.appendChild(note)
        setTimeout(() => note.remove(), 3000)
      }

      const open = (id) => {
        const list = sessions.list.getSnapshot()
        if (list.phase === 'ready' && list.byId[id]) {
          uiWorkspace.openSession(id)
          return
        }
        Promise.resolve(sessions.refresh()).then(() => {
          const next = sessions.list.getSnapshot()
          if (next.phase === 'ready' && next.byId[id]) {
            uiWorkspace.openSession(id)
          } else {
            console.warn(NAME, 'open session failed, session no longer in list', id)
            showNotice('该会话已不在列表中')
          }
        }).catch((error) => {
          console.warn(NAME, 'open session failed', id, error)
          showNotice('打开会话失败，请重试')
        })
      }

      // 监控窗口点任务时把 id 塞进 Host 的 pendingFocus，这里取一次就清空。
      const focusTimer = setInterval(async () => {
        const data = await monitorRequest('/focus')
        if (data && typeof data.id === 'string' && data.id) open(data.id)
      }, 700)

      let lastMonitorPayload = ''
      /** 从小窗删除一个任务：只删置顶壳子，不碰 DSH 会话本身。 */
      const removeTracked = (id) => {
        if (!forgetTracked(tracked, viewed, interrupted, id)) return
        saveTracked(tracked)
        saveViewed(viewed)
        saveInterrupted(interrupted)
        progressById.delete(id)
        unwatch(id)
        lastMonitorPayload = ''
        render()
      }

      // 小窗的「删除置顶」按钮写入 Host 的 pendingRemove，这里取一次就清空。
      const removeTimer = setInterval(async () => {
        const data = await monitorRequest('/remove')
        if (data && typeof data.id === 'string' && data.id) removeTracked(data.id)
      }, 700)

      const interrupted = loadInterrupted()
      const watchers = new Map()
      const progressById = new Map()

      /** 会话此刻是否仍在跑。运行中的行本来就显示绿点，不该判成「中断」。 */
      const isRunningNow = (id) => {
        const list = sessions.list.getSnapshot()
        const statusMap = statuses ? statuses.getSnapshot() : undefined
        return isRunning(list && list.byId ? list.byId[id] : undefined, statusMap && statusMap.get(id))
      }

      const isInterruptedNow = (id) => interrupted.has(id)

      const setInterrupted = (id, on) => {
        if (!tracked.has(id)) return
        // 关键：运行中不落「中断」标记。否则 render() 里清标记、check() 里又置标记，
        // 一来一回就是死循环（事件流越密圈转得越快，最终把渲染进程内存撑爆）。
        if (on && isRunningNow(id)) return
        if (on ? interrupted.has(id) : !interrupted.has(id)) return
        if (on) interrupted.add(id)
        else interrupted.delete(id)
        saveInterrupted(interrupted)
        scheduleRender()
      }

      const unwatch = (id) => {
        const holder = watchers.get(id)
        if (!holder) return
        holder.cancelled = true
        watchers.delete(id)
        try { if (holder.unsubscribe) holder.unsubscribe() } catch {}
        try { if (holder.ref && holder.ref.release) holder.ref.release() } catch {}
      }

      /** 把一个 tracked 会话的 turn 事件接进来，读最后一次 turn/end。 */
      const watch = (id) => {
        if (watchers.has(id)) return
        let ref
        try {
          ref = sessions.retain(id, { source: 'pin-running' })
        } catch (error) {
          console.warn(NAME, 'retain session failed', id, error)
          return
        }
        const holder = { ref, unsubscribe: null, cancelled: false }
        watchers.set(id, holder)
        Promise.resolve(ref.ready).then((binding) => {
          if (holder.cancelled) return
          const source = binding && binding.eventSource
          if (!source || typeof source.getSnapshot !== 'function') return
          const check = () => {
            if (holder.cancelled) return
            const entries = source.getSnapshot().entries
            const state = terminalStateFromEntries(entries)
            const progress = progressFromEntries(entries)
            const last = progressById.get(id)
            if (!last || JSON.stringify(last) !== JSON.stringify(progress)) {
              progressById.set(id, progress)
              scheduleRender()
            }
            if (state === 'interrupted') setInterrupted(id, true)
            else if (state === 'completed') setInterrupted(id, false)
          }
          if (typeof source.subscribe === 'function') holder.unsubscribe = source.subscribe(check)
          check()
        }).catch((error) => {
          console.warn(NAME, 'watch session failed', id, error)
          unwatch(id)
        })
      }

      /** 侧栏和窗口共用同一套点击语义：切走时消费已看完成的旧项，运行/中断项保留。 */
      const activate = (row) => {
        const listNow = sessions.list.getSnapshot()
        const statusNow = statuses ? statuses.getSnapshot() : undefined
        const runningById = (id) => isRunning(listNow.byId[id], statusNow && statusNow.get(id))
        if (currentId && currentId !== row.id && pruneViewedCompleted(tracked, viewed, runningById, row.id, isInterruptedNow)) {
          saveTracked(tracked)
          saveViewed(viewed)
        }
        currentId = row.id
        // 运行中的点击只打开；失败/中断的要一直停留；完成的先留壳，等下次切换再清。
        if (!row.running && !row.interrupted) {
          viewed.add(row.id)
          saveViewed(viewed)
        }
        render()
        open(row.id)
      }

      let pendingKey = ''
      const publishMonitor = (rows, statusMap) => {
        const monitorRows = buildMonitorRows(rows, progressById, statusMap).map((row) => ({
          id: row.id,
          title: row.title,
          state: row.state,
          current: Boolean(row.current),
          path: row.path || '',
          detail: row.pendingKind ? monitorDetail(row) + (row.pendingText ? '|' + row.pendingText : '') : monitorDetail(row, row.progress),
          pendingKind: row.pendingKind || '',
          pendingText: row.pendingText || '',
        }))
        const payload = JSON.stringify({ rows: monitorRows })
        if (payload === lastMonitorPayload) return
        lastMonitorPayload = payload
        monitorRequest('/tasks', { rows: monitorRows })
        const nextPendingKey = monitorRows.filter((row) => row.pendingKind).map((row) => row.id + ':' + row.pendingKind).join(',')
        if (nextPendingKey && nextPendingKey !== pendingKey) {
          pendingKey = nextPendingKey
          monitorRequest('/window', { action: 'open' }).then((state) => { if (state) setMonitorOpen(state.open) })
        } else if (!nextPendingKey) {
          pendingKey = ''
        }
      }

      const render = () => {
        ensureMounted()
        const list = sessions.list.getSnapshot()
        const registry = workspaces.list.getSnapshot()
        if (!list || list.phase !== 'ready' || !registry || registry.phase !== 'ready') {
          area.hidden = true
          publishMonitor([])
          return
        }
        const statusMap = statuses ? statuses.getSnapshot() : undefined
        let changed = false
        if (pruneStaleTracked(tracked, viewed, list)) changed = true
        let interruptedChanged = false
        for (const id of list.ids) {
          const session = list.byId[id]
          if (!session || session.archived || session.blank || session.origin === 'subagent') continue
          const running = isRunning(session, statusMap && statusMap.get(id))
          if (running && !tracked.has(id)) {
            tracked.add(id)
            changed = true
          }
          if (running && interrupted.delete(id)) interruptedChanged = true
        }
        if (changed) {
          saveTracked(tracked)
          saveViewed(viewed)
        }
        if (interruptedChanged) saveInterrupted(interrupted)

        const rows = buildPinnedRows(list, registry, currentId, Date.now(), tracked, statusMap, interrupted)
        if (shouldAutoExpand(previousStates, rows)) expanded = true
        for (const row of rows) previousStates.set(row.id, row.state)
        const visible = new Set(rows.map((row) => row.id))
        for (const row of rows) watch(row.id)
        for (const id of [...watchers.keys()]) {
          if (!visible.has(id)) unwatch(id)
        }
        area.hidden = rows.length === 0
        publishMonitor(rows, statusMap)
        area.replaceChildren()

        const head = document.createElement('button')
        head.type = 'button'
        head.className = 'dsh-pin-running-head'
        head.dataset.expanded = String(expanded)
        head.title = expanded ? '收起置顶' : '展开置顶'
        const label = document.createElement('span')
        label.textContent = '置顶'
        const count = document.createElement('span')
        count.className = 'dsh-pin-running-count'
        count.textContent = String(rows.length)
        const chevron = document.createElement('span')
        chevron.className = 'dsh-pin-running-chevron'
        chevron.textContent = '▾'
        head.append(label, count, chevron)
        head.addEventListener('click', () => {
          expanded = !expanded
          render()
        })
        area.appendChild(head)

        for (const row of visiblePinnedRows(rows, expanded)) {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'dsh-pin-running-row'
          button.dataset.current = String(row.current)
          button.title = row.path || row.title
          const dot = document.createElement('span')
          dot.className = 'dsh-pin-running-dot'
          dot.dataset.state = row.state
          const title = document.createElement('span')
          title.className = 'dsh-pin-running-title'
          title.textContent = row.title
          const time = document.createElement('span')
          time.className = 'dsh-pin-running-time'
          time.textContent = row.time
          button.append(dot, title, time)
          if (row.interrupted) {
            const remove = document.createElement('span')
            remove.className = 'dsh-pin-running-remove'
            remove.textContent = '×'
            remove.title = '从置顶移除（不删除会话）'
            remove.setAttribute('role', 'button')
            remove.addEventListener('click', (event) => {
              event.stopPropagation()
              removeTracked(row.id)
            })
            button.appendChild(remove)
          }
          button.addEventListener('click', () => activate(row))
          area.appendChild(button)
        }
      }

      /**
       * 把同一批通知合并成一次渲染：订阅回调里不再直接 render()，
       * 避免「渲染 → 订阅回调 → 渲染」的同步递归。
       */
      let scheduled = false
      const scheduleRender = () => {
        if (scheduled) return
        scheduled = true
        const flush = () => {
          scheduled = false
          render()
        }
        if (typeof setTimeout === 'function') setTimeout(flush, 16)
        else flush()
      }

      const syncCurrent = () => {
        const stored = readCurrentId(uiWorkspace, storage)
        if (!stored || stored === currentId) return false
        const list = sessions.list.getSnapshot()
        const statusMap = statuses ? statuses.getSnapshot() : undefined
        if (list && list.phase === 'ready') {
          const runningById = (id) => isRunning(list.byId[id], statusMap && statusMap.get(id))
          if (pruneViewedCompleted(tracked, viewed, runningById, stored, isInterruptedNow)) {
            saveTracked(tracked)
            saveViewed(viewed)
          }
        }
        currentId = stored
        return true
      }

      const onSessions = sessions.list.subscribe(scheduleRender)
      const onWorkspaces = workspaces.list.subscribe(scheduleRender)
      const selectionStore = uiWorkspace && uiWorkspace.selection
      const onSelection = selectionStore && typeof selectionStore.subscribe === 'function'
        ? selectionStore.subscribe(() => { if (syncCurrent()) scheduleRender() })
        : () => {}
      const onStatuses = statuses ? statuses.subscribe(scheduleRender) : () => {}
      const remote = ctx.get('remote')
      const offError = remote && typeof remote.$on === 'function'
        ? remote.$on('api-session/error', (id) => setInterrupted(id, true))
        : () => {}
      // 原生列表点走别的会话不会触发我们的订阅，轮询 localStorage 兜底。
      const timer = setInterval(() => {
        if (syncCurrent()) render()
        else if (!area.isConnected) render()
      }, 1000)
      render()

      let frame = 0
      const observer = new MutationObserver(() => {
        if (frame) return
        frame = requestAnimationFrame(() => {
          frame = 0
          if (!area.isConnected) render()
        })
      })
      observer.observe(document.body, { childList: true, subtree: true })

      return () => {
        observer.disconnect()
        clearInterval(timer)
        clearInterval(focusTimer)
        clearInterval(removeTimer)
        if (frame) cancelAnimationFrame(frame)
        onSessions()
        onWorkspaces()
        onSelection()
        onStatuses()
        offError()
        for (const id of [...watchers.keys()]) unwatch(id)
        area.remove()
        toggleBtn.remove()
      }
    }

    /**
     * 早期版本曾强制 groupBy=flat。这里做一次性迁移：只有持久化视图仍是 flat、
     * 且从未迁移过时，才切回原生文件夹分组（workspace）；用户以后手动选 flat 不再干预。
     */
    const GROUP_FLAG = 'dsh-pin-running.grouped-restored.v1'
    const VIEW_KEY = 'dsh.workspace.view.v5'

    function installRestoreGrouping(ctx) {
      if (typeof localStorage === 'undefined') return
      if (localStorage.getItem(GROUP_FLAG)) return
      let stored
      try {
        stored = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null')
      } catch {
        stored = null
      }
      if (!stored || stored.groupBy !== 'flat') {
        localStorage.setItem(GROUP_FLAG, '1')
        return
      }
      const slots = ctx.get('slots')
      if (!slots || typeof slots.entries !== 'function') return
      let tries = 0
      let timer = 0
      const tick = () => {
        timer = 0
        const entry = slots.entries('sidebar.workspaces').find((item) => item && item.store && typeof item.store.create === 'function')
        if (entry) {
          try {
            const store = entry.store.create()
            // store 有两种形态：直接带 actions，或要再 create 一次才拿到 actions。
            // 短路保证第二种 create 只在第一种不存在时调用一次。
            const fallback = store && !store.actions && typeof store.create === 'function' ? store.create() : null
            const actions = (store && store.actions) || (fallback && fallback.actions)
            if (actions && typeof actions.setGroupBy === 'function') {
              actions.setGroupBy('workspace')
              localStorage.setItem(GROUP_FLAG, '1')
              return
            }
          } catch (error) {
            console.warn(NAME, 'restore grouping failed', error)
          }
        }
        if (++tries < 50) timer = setTimeout(tick, 200)
      }
      tick()
      return () => {
        if (timer) clearTimeout(timer)
      }
    }

    const ORDER_FLAG = 'dsh-pin-running.recent-order.v1'

    /**
     * DSH 原生「按最近更新」排序会按每个 workspace 内的 session.updatedAt 排；
     * 旧版插件或用户手动选过「手动排序」时，持久化值为 manual。这里做一次
     * 升级迁移，切回最近更新，之后用户仍可在 DSH 里手动选择排序方式。
     */
    function installRecentOrder(ctx) {
      if (typeof localStorage === 'undefined') return
      if (localStorage.getItem(ORDER_FLAG)) return
      let stored
      try {
        stored = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null')
      } catch {
        stored = null
      }
      if (!stored || stored.orderBy === 'updated') {
        localStorage.setItem(ORDER_FLAG, '1')
        return
      }
      const slots = ctx.get('slots')
      if (!slots || typeof slots.entries !== 'function') return
      let tries = 0
      let timer = 0
      const tick = () => {
        timer = 0
        const entry = slots.entries('sidebar.workspaces').find((item) => item && item.store && typeof item.store.create === 'function')
        if (entry) {
          try {
            const store = entry.store.create()
            // store 有两种形态：直接带 actions，或要再 create 一次才拿到 actions。
            const fallback = store && !store.actions && typeof store.create === 'function' ? store.create() : null
            const actions = (store && store.actions) || (fallback && fallback.actions)
            if (actions && typeof actions.setOrderBy === 'function') {
              actions.setOrderBy('updated')
              localStorage.setItem(ORDER_FLAG, '1')
              return
            }
          } catch (error) {
            console.warn(NAME, 'restore recent order failed', error)
          }
        }
        if (++tries < 50) timer = setTimeout(tick, 200)
      }
      tick()
      return () => {
        if (timer) clearTimeout(timer)
      }
    }

    const inject = ['sessions', 'workspaces', 'uiWorkspace', 'uiSession', 'slots']

    /** HMR 重新执行模块时先拆掉上一份挂载，避免侧栏叠出两个「置顶」区。 */
    const CLEANUP_KEY = '__dshPinRunningCleanup__'

    function apply(ctx) {
      if (typeof window !== 'undefined') {
        const previous = window[CLEANUP_KEY]
        if (typeof previous === 'function') {
          try { previous() } catch {}
          window[CLEANUP_KEY] = undefined
        }
      }
      ctx.effect(() => installRestoreGrouping(ctx), 'pin-running: restore grouping')
      ctx.effect(() => installRecentOrder(ctx), 'pin-running: recent order')
      if (typeof document !== 'undefined') {
        ctx.effect(() => {
          const cleanup = installPinnedArea(ctx)
          if (typeof window !== 'undefined') window[CLEANUP_KEY] = cleanup
          return () => {
            if (typeof window !== 'undefined' && window[CLEANUP_KEY] === cleanup) window[CLEANUP_KEY] = undefined
            cleanup()
          }
        }, 'pin-running: pinned section')
      }
    }

    return { inject, apply, _test: { buildPinnedRows, visiblePinnedRows, shouldAutoExpand, relativeTime, pruneViewedCompleted, pruneStaleTracked, forgetTracked, terminalStateFromEntries, readCurrentId, repairCurrentIdStorage, markPinnedAreaActive, windowPositionFromPrefs, progressFromEntries, buildMonitorRows, monitorDetail, markTaskWindowActive, installRecentOrder } }
  },
})