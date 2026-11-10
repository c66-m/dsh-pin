import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * dsh-pin-running —— Host 半端。
 *
 * 任务监控不再是 DSH 渲染器里的 DOM 浮层（那种浮层永远出不了 DSH 窗口）。
 * Windows 优先启动插件自带的 WPF 原生小窗；其他平台回退浏览器 --app 窗口，页面由 ctx.webServer 提供：
 *   - 渲染器把置顶任务状态 POST 到 /dsh-pin-running/tasks
 *   - 监控窗口轮询该接口
 *   - 点击监控行 POST /dsh-pin-running/focus，渲染器轮询后调用 uiWorkspace.openSession
 * 这样窗口可以拖出 DSH、铺满桌面，也能用 Win32 保持置顶。
 */
export const name = 'pin-running'
export const inject = ['webServer']

const PREFIX = '/dsh-pin-running'
const MAX_BODY = 256 * 1024
const MONITOR_TITLE = '任务监控'

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > MAX_BODY) throw new Error('request body too large')
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  return JSON.parse(raw)
}

function sanitizeRows(value) {
  if (!Array.isArray(value)) return []
  const states = new Set(['running', 'interrupted', 'completed'])
  return value.slice(0, 100).map((row) => ({
    id: String(row && row.id || '').slice(0, 200),
    title: String(row && row.title || '未命名会话').slice(0, 200),
    state: states.has(row && row.state) ? row.state : 'completed',
    detail: String(row && row.detail || '').slice(0, 240),
    pendingKind: ['approval', 'plan-review', 'question'].includes(row && row.pendingKind) ? row.pendingKind : '',
    pendingText: String(row && row.pendingText || '').slice(0, 400),
    updatedAt: Number(row && row.updatedAt) || 0,
    current: Boolean(row && row.current),
  })).filter((row) => row.id)
}

function browserCandidates() {
  if (process.platform !== 'win32') return []
  const roots = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean)
  const names = [
    ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
    ['Google', 'Chrome', 'Application', 'chrome.exe'],
  ]
  const out = []
  for (const root of roots) {
    for (const parts of names) {
      const candidate = join(root, ...parts)
      if (existsSync(candidate)) out.push(candidate)
    }
  }
  return out
}

function hostPlatform() {
  return process.platform
}

function psScript() {
  return fileURLToPath(new URL('./monitor-window.ps1', import.meta.url))
}

function monitorPsScript() {
  return fileURLToPath(new URL('./monitor.ps1', import.meta.url))
}

export function nativeMonitorArgs(origin, script) {
  return ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, '-Origin', origin]
}

export function apply(ctx) {
  let rows = []
  let updatedAt = 0
  let pendingFocus = null
  let pendingRemove = null
  let monitor = null
  let topmost = true

  const monitorHtml = readFileSync(new URL('./monitor.html', import.meta.url), 'utf8')

  const getOrigin = () => {
    try {
      return ctx.webServer.getOrigin()
    } catch {
      return `http://127.0.0.1:${ctx.webServer.port || 0}`
    }
  }

  const runWindowScript = (action) => {
    if (hostPlatform() !== 'win32') return
    try {
      const args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', psScript(), '-Title', MONITOR_TITLE, '-Action', action]
      spawn('powershell.exe', args, { windowsHide: true, stdio: 'ignore' }).unref()
    } catch (error) {
      console.warn('[dsh-pin-running] monitor window helper failed', error)
    }
  }

  const launchMonitor = () => {
    if (monitor && monitor.child && monitor.child.exitCode === null) return { open: true, topmost }
    if (hostPlatform() === 'win32' && existsSync(monitorPsScript())) {
      try {
        const child = spawn('powershell.exe', nativeMonitorArgs(getOrigin(), monitorPsScript()), { stdio: 'ignore' })
        monitor = { child, kind: 'wpf' }
        child.on('exit', () => {
          if (monitor && monitor.child === child) monitor = null
        })
        return { open: true, topmost }
      } catch (error) {
        console.warn('[dsh-pin-running] native monitor failed', error)
      }
    }
    const url = `${getOrigin()}${PREFIX}/monitor`
    const browsers = browserCandidates()
    const profileDir = join(tmpdir(), `dsh-pin-running-monitor-${process.pid}-${Date.now()}`)
    if (!browsers.length) {
      // 没找到 Chromium 内核浏览器时退回默认浏览器；这种窗口无法由插件精确关闭。
      if (hostPlatform() === 'win32') spawn('cmd.exe', ['/d', '/c', 'start', '', url], { windowsHide: true, stdio: 'ignore' }).unref()
      else if (hostPlatform() === 'darwin') spawn('open', [url], { stdio: 'ignore' }).unref()
      else spawn('xdg-open', [url], { stdio: 'ignore' }).unref()
      return { open: true, external: true, topmost: false }
    }
    try {
      mkdirSync(profileDir, { recursive: true })
      const child = spawn(browsers[0], [
        `--app=${url}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=msEdgeFirstRunExperience',
        '--window-size=320,150',
      ], { stdio: 'ignore' })
      monitor = { child, profileDir, kind: 'browser' }
      child.on('exit', () => {
        if (monitor && monitor.child === child) monitor = null
        try { rmSync(profileDir, { recursive: true, force: true }) } catch {}
      })
      // Chromium 的 --app 窗口建好后再调用 Win32；过早调用会找不到 HWND。
      setTimeout(() => {
        if (monitor && monitor.child === child) runWindowScript('init')
      }, 1200)
      return { open: true, topmost }
    } catch (error) {
      console.warn('[dsh-pin-running] launch monitor failed', error)
      return { open: false, error: String(error && error.message || error) }
    }
  }

  const closeMonitor = () => {
    const current = monitor
    monitor = null
    if (!current) return { open: false }
    try {
      if (hostPlatform() === 'win32') {
        spawn('taskkill.exe', ['/PID', String(current.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref()
      } else {
        current.child.kill()
      }
    } catch {}
    if (current.profileDir) try { rmSync(current.profileDir, { recursive: true, force: true }) } catch {}
    return { open: false }
  }

  const focusDsh = () => {
    if (hostPlatform() === 'win32') {
      // dsh://open 由 DSH 自己注册；只负责把主窗口拉到前台，不带会话参数。
      try {
        spawn('cmd.exe', ['/d', '/c', 'start', '', 'dsh://open'], { windowsHide: true, stdio: 'ignore' }).unref()
      } catch {}
      if (!monitor || monitor.kind !== 'wpf') setTimeout(() => runWindowScript('focus'), 250)
    }
  }

  const windowState = () => ({ open: Boolean(monitor && monitor.child && monitor.child.exitCode === null), topmost })

  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const disposers = []
      const route = (spec) => {
        try {
          const dispose = host.webServer.register(spec)
          if (typeof dispose === 'function') disposers.push(dispose)
        } catch (error) {
          console.warn('[dsh-pin-running] route ' + spec.path + ' failed', error)
        }
      }

      route({
        kind: 'exact',
        path: PREFIX + '/monitor',
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: 'method not allowed' })
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(monitorHtml)
        },
      })

      route({
        kind: 'exact',
        path: PREFIX + '/tasks',
        handler: async (req, res) => {
          if (req.method === 'GET' || req.method === 'HEAD') {
            return json(res, 200, { rows, updatedAt })
          }
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
          try {
            const body = await readJson(req)
            rows = sanitizeRows(body && body.rows)
            updatedAt = Date.now()
            return json(res, 200, { ok: true, count: rows.length })
          } catch (error) {
            return json(res, 400, { ok: false, error: String(error && error.message || error) })
          }
        },
      })

      route({
        kind: 'exact',
        path: PREFIX + '/focus',
        handler: async (req, res) => {
          if (req.method === 'GET' || req.method === 'HEAD') {
            const id = pendingFocus
            pendingFocus = null
            return json(res, 200, { id })
          }
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
          try {
            const body = await readJson(req)
            const id = String(body && body.id || '').slice(0, 200)
            if (!id) return json(res, 400, { ok: false, error: 'id required' })
            pendingFocus = id
            focusDsh()
            return json(res, 200, { ok: true })
          } catch (error) {
            return json(res, 400, { ok: false, error: String(error && error.message || error) })
          }
        },
      })

      route({
        kind: 'exact',
        path: PREFIX + '/remove',
        handler: async (req, res) => {
          if (req.method === 'GET' || req.method === 'HEAD') {
            const id = pendingRemove
            pendingRemove = null
            return json(res, 200, { id })
          }
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
          try {
            const body = await readJson(req)
            const id = String(body && body.id || '').slice(0, 200)
            if (!id) return json(res, 400, { ok: false, error: 'id required' })
            pendingRemove = id
            rows = rows.filter((row) => row.id !== id)
            updatedAt = Date.now()
            return json(res, 200, { ok: true })
          } catch (error) {
            return json(res, 400, { ok: false, error: String(error && error.message || error) })
          }
        },
      })

      route({
        kind: 'exact',
        path: PREFIX + '/window',
        handler: async (req, res) => {
          if (req.method === 'GET' || req.method === 'HEAD') return json(res, 200, windowState())
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
          try {
            const body = await readJson(req)
            const action = String(body && body.action || '')
            if (action === 'open') return json(res, 200, launchMonitor())
            if (action === 'close') return json(res, 200, closeMonitor())
            if (action === 'toggle') return json(res, 200, windowState().open ? closeMonitor() : launchMonitor())
            if (action === 'topmost') {
              topmost = body.on !== false
              runWindowScript(topmost ? 'topmost' : 'normal')
              return json(res, 200, { ok: true, topmost })
            }
            if (action === 'focus') {
              focusDsh()
              return json(res, 200, { ok: true })
            }
            return json(res, 400, { ok: false, error: 'unknown action' })
          } catch (error) {
            return json(res, 400, { ok: false, error: String(error && error.message || error) })
          }
        },
      })

      return () => {
        closeMonitor()
        for (let i = disposers.length - 1; i >= 0; i -= 1) {
          try { disposers[i]() } catch {}
        }
        disposers.length = 0
      }
    }, 'pin-running: monitor routes')
  })
}
