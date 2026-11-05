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
    const STYLE_ID = 'dsh-pin-running-style'
    const CURRENT_KEY = 'dsh.sessions.current'
    const STORE_KEY = 'dsh-pin-running.tasks.v1'
    const VIEWED_KEY = 'dsh-pin-running.viewed.v1'
    const INTERRUPTED_KEY = 'dsh-pin-running.interrupted.v1'

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

    /** 收起时只藏运行中的多余行；完成/中断行不受收起影响，始终完整显示。 */
    function visiblePinnedRows(rows, expanded) {
      if (expanded) return rows
      const firstRunning = rows.findIndex((row) => row.state === 'running')
      return rows.filter((row, index) => row.state !== 'running' || index === firstRunning)
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
     * 从会话事件里读最后一轮的状态：completed 以外（error/aborted/interrupted/
     * max-tokens/blocked）或只有 turn/start 没有 turn/end，都算中断。
     */
    function terminalStateFromEntries(entries) {
      let state
      for (const entry of entries || []) {
        const event = entry && entry.event
        if (!event) continue
        if (event.type === 'turn/start') state = 'interrupted'
        else if (event.type === 'turn/end') {
          const kind = event.data && event.data.reason && event.data.reason.kind
          state = kind === 'completed' ? 'completed' : 'interrupted'
        }
      }
      return state
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
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
        .dsh-pin-running-area { display: flex; flex-direction: column; gap: 1px; padding: 0 8px 6px; flex: 0 0 auto; max-height: min(40vh, 320px); overflow-y: auto; }
        .dsh-pin-running-area[hidden] { display: none; }
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
        .dsh-pin-running-notice { padding: 4px 8px 6px; font-size: 11px; opacity: .6; }
        @keyframes dsh-pin-running-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
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
      let currentId = localStorage.getItem(CURRENT_KEY) || ''
      let expanded = false
      const previousStates = new Map()
      let mountWarned = false

      installStyle()
      const area = document.createElement('div')
      area.className = 'dsh-pin-running-area'
      area.hidden = true

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

      const interrupted = loadInterrupted()
      const watchers = new Map()

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
            const state = terminalStateFromEntries(source.getSnapshot().entries)
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

      const render = () => {
        ensureMounted()
        const list = sessions.list.getSnapshot()
        const registry = workspaces.list.getSnapshot()
        if (!list || list.phase !== 'ready' || !registry || registry.phase !== 'ready') {
          area.hidden = true
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
        area.replaceChildren()

        const collapsedRows = visiblePinnedRows(rows, false)
        const canToggle = collapsedRows.length < rows.length
        const head = document.createElement('button')
        head.type = 'button'
        head.className = 'dsh-pin-running-head'
        head.dataset.expanded = String(expanded)
        head.title = canToggle ? (expanded ? '收起置顶' : '展开置顶') : ''
        const label = document.createElement('span')
        label.textContent = '置顶'
        const count = document.createElement('span')
        count.className = 'dsh-pin-running-count'
        count.textContent = canToggle && !expanded ? collapsedRows.length + '/' + rows.length : String(rows.length)
        head.append(label, count)
        if (canToggle) {
          const chevron = document.createElement('span')
          chevron.className = 'dsh-pin-running-chevron'
          chevron.textContent = '▾'
          head.append(chevron)
          head.addEventListener('click', () => {
            expanded = !expanded
            render()
          })
        }
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
          button.addEventListener('click', () => {
            const listNow = sessions.list.getSnapshot()
            const statusNow = statuses ? statuses.getSnapshot() : undefined
            const runningById = (id) => isRunning(listNow.byId[id], statusNow && statusNow.get(id))
            // 切到别的任务时，才把「已完成且点开看过」的旧项清掉。
            if (currentId && currentId !== row.id && pruneViewedCompleted(tracked, viewed, runningById, row.id, isInterruptedNow)) {
              saveTracked(tracked)
              saveViewed(viewed)
            }
            currentId = row.id
            localStorage.setItem(CURRENT_KEY, row.id)
            // 运行中的点击只打开；失败/中断的要一直停留；完成的先留壳，等下次切换再清。
            if (!row.running && !row.interrupted) {
              viewed.add(row.id)
              saveViewed(viewed)
            }
            render()
            open(row.id)
          })
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
        const stored = localStorage.getItem(CURRENT_KEY) || ''
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
      const onStatuses = statuses ? statuses.subscribe(scheduleRender) : () => {}
      const remote = ctx.get('remote')
      const offError = remote && typeof remote.$on === 'function'
        ? remote.$on('api-session/error', (id) => setInterrupted(id, true))
        : () => {}
      // 原生列表点走别的会话不会触发我们的订阅，轮询 localStorage 兜底。
      const timer = setInterval(() => {
        if (syncCurrent()) render()
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
        if (frame) cancelAnimationFrame(frame)
        onSessions()
        onWorkspaces()
        onStatuses()
        offError()
        for (const id of [...watchers.keys()]) unwatch(id)
        area.remove()
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

    const inject = ['sessions', 'workspaces', 'uiWorkspace', 'uiSession', 'slots']

    function apply(ctx) {
      ctx.effect(() => installRestoreGrouping(ctx), 'pin-running: restore grouping')
      if (typeof document !== 'undefined') {
        ctx.effect(() => installPinnedArea(ctx), 'pin-running: pinned section')
      }
    }

    return { inject, apply, _test: { buildPinnedRows, visiblePinnedRows, shouldAutoExpand, relativeTime, pruneViewedCompleted, pruneStaleTracked, terminalStateFromEntries } }
  },
})