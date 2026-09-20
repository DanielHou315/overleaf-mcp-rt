// Log in by driving the user's own browser instead of asking them to copy a
// cookie out of devtools. Overleaf has no OAuth (or device flow) for
// third-party clients, and hosted instances put CAPTCHA / SSO / 2FA in front
// of the password form, so the only login that always works is the real one
// in a real browser. We launch an installed Chromium-family browser with a
// throwaway profile, let the user sign in, and read the session cookie over
// the DevTools protocol — which, unlike page JavaScript, can see HttpOnly
// cookies. The user's everyday browser profile is never touched.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { AuthFailedError, OverleafError } from '../errors.js'
import { SESSION_COOKIE_NAMES, validateCookie, type SessionIdentity } from './auth.js'

/** The slice of the DevTools protocol we use. */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  close(): Promise<void>
}

export interface BrowserLoginOptions {
  url: string
  extraHeaders: Record<string, string>
  /** Give up after this long (default 5 minutes). */
  timeoutMs?: number
  pollMs?: number
  /** Explicit browser binary; otherwise the first installed Chromium-family browser. */
  executablePath?: string
  /** No window. Only useful for tests — a person can't log in to a headless browser. */
  headless?: boolean
  onStatus?: (message: string) => void
  /** Test seam: supply a DevTools session instead of launching a browser. */
  launch?: (startUrl: string) => Promise<CdpSession>
}

interface CdpCookie {
  name: string
  value: string
  domain: string
}

/**
 * Open a browser at the instance's login page and resolve once the user is
 * signed in, with a validated session cookie and CSRF token.
 */
export async function browserLogin(opts: BrowserLoginOptions): Promise<SessionIdentity> {
  const origin = new URL(opts.url)
  const status = opts.onStatus ?? (() => undefined)
  const pollMs = opts.pollMs ?? 1000
  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000)
  const startUrl = new URL('/login', opts.url + '/').toString()

  const session = await (opts.launch ?? ((u) => launchBrowser(u, opts)))(startUrl)
  status(`Opened a browser window at ${startUrl} — sign in there; this will continue on its own.`)
  try {
    const lastTried = new Map<string, number>()
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs))
      let targets: Array<{ type: string; url: string }>
      let cookies: CdpCookie[]
      try {
        targets = (await session.send('Target.getTargets')).targetInfos as typeof targets
        cookies = (await session.send('Storage.getCookies')).cookies as CdpCookie[]
      } catch {
        throw new AuthFailedError('The browser window was closed before login completed.')
      }

      // Overleaf hands out a session cookie to anonymous visitors too, so a
      // cookie alone proves nothing. Only test it once a tab has landed
      // somewhere other than the login/SSO pages of this instance.
      const signedInTab = targets.some((t) => {
        if (t.type !== 'page') return false
        try {
          const u = new URL(t.url)
          return u.host === origin.host && !/^\/(login|register|sso|saml|oidc|oauth|user\/password)/.test(u.pathname)
        } catch {
          return false
        }
      })
      if (!signedInTab) continue

      const candidates = cookies
        .filter((c) => SESSION_COOKIE_NAMES.includes(c.name) && domainMatches(origin.hostname, c.domain))
        // A cookie scoped to the exact host wins over one for a parent domain.
        .sort((a, b) => b.domain.replace(/^\./, '').length - a.domain.replace(/^\./, '').length)
        .map((c) => `${c.name}=${c.value}`)
      for (const sessionCookie of candidates) {
        // Re-test a rejected cookie only occasionally: some instances upgrade
        // the anonymous session in place on login instead of issuing a new one.
        if (Date.now() - (lastTried.get(sessionCookie) ?? 0) < RETRY_REJECTED_MS) continue
        lastTried.set(sessionCookie, Date.now())
        try {
          const csrfToken = await validateCookie({ url: opts.url, sessionCookie, extraHeaders: opts.extraHeaders })
          return { sessionCookie, csrfToken }
        } catch (err) {
          if (!(err instanceof AuthFailedError)) throw err
          // anonymous / not-yet-upgraded session; keep waiting
        }
      }
    }
    throw new AuthFailedError('Timed out waiting for the browser login to complete.')
  } finally {
    await session.close().catch(() => undefined)
  }
}

const RETRY_REJECTED_MS = 4000

function domainMatches(hostname: string, cookieDomain: string): boolean {
  const d = cookieDomain.replace(/^\./, '')
  return hostname === d || hostname.endsWith(`.${d}`)
}

const BROWSER_CANDIDATES: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge', '/usr/bin/brave-browser',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ],
}

export function findBrowser(explicit?: string): string {
  const candidates = [explicit, process.env.OVERLEAF_BROWSER, ...(BROWSER_CANDIDATES[process.platform] ?? [])]
  const found = candidates.find((p): p is string => !!p && existsSync(p))
  if (!found) {
    throw new OverleafError(
      'INVALID_CONFIG',
      'No Chrome, Chromium, Edge or Brave installation found for browser login. ' +
        'Set OVERLEAF_BROWSER to the browser binary, or use cookie paste instead.',
    )
  }
  return found
}

/** Launch a browser with a throwaway profile and connect to its DevTools endpoint. */
async function launchBrowser(startUrl: string, opts: BrowserLoginOptions): Promise<CdpSession> {
  const executable = findBrowser(opts.executablePath)
  const profileDir = mkdtempSync(join(tmpdir(), 'overleaf-mcp-login-'))
  const child: ChildProcess = spawn(
    executable,
    [
      // Port 0 = pick a free port; the browser only listens on 127.0.0.1.
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(opts.headless ? ['--headless=new'] : []),
      startUrl,
    ],
    { stdio: 'ignore' },
  )
  const cleanup = async () => {
    if (child.exitCode === null) {
      child.kill()
      await new Promise((r) => child.once('exit', r))
    }
    // The profile holds the session we just captured; don't leave it on disk.
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }

  try {
    // The browser writes "<port>\n<browser ws path>" here once DevTools is up.
    const portFile = join(profileDir, 'DevToolsActivePort')
    const startedBy = Date.now() + 20_000
    while (!existsSync(portFile) || readFileSync(portFile, 'utf-8').split('\n').length < 2) {
      if (child.exitCode !== null) throw new OverleafError('OVERLEAF_GENERIC', `${executable} exited before it could be controlled`)
      if (Date.now() > startedBy) throw new OverleafError('OVERLEAF_GENERIC', 'Timed out waiting for the browser to start')
      await new Promise((r) => setTimeout(r, 100))
    }
    const [port, path] = readFileSync(portFile, 'utf-8').trim().split('\n')
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })

    let nextId = 0
    const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>()
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string } }
      const waiter = msg.id !== undefined ? pending.get(msg.id) : undefined
      if (!waiter) return
      pending.delete(msg.id!)
      if (msg.error) waiter.reject(new Error(msg.error.message))
      else waiter.resolve(msg.result ?? {})
    })
    ws.on('close', () => {
      for (const waiter of pending.values()) waiter.reject(new Error('browser closed'))
      pending.clear()
    })

    return {
      send: (method, params = {}) =>
        new Promise((resolve, reject) => {
          if (ws.readyState !== WebSocket.OPEN) return reject(new Error('browser closed'))
          const id = ++nextId
          pending.set(id, { resolve, reject })
          ws.send(JSON.stringify({ id, method, params }))
        }),
      close: async () => {
        ws.close()
        await cleanup()
      },
    }
  } catch (err) {
    await cleanup()
    throw err
  }
}
