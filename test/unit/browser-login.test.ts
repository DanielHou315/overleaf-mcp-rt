import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { browserLogin, findBrowser, type CdpSession } from '../../src/overleaf/browser-login.js'

const CSRF_PAGE = '<html><head><meta name="ol-csrfToken" content="CSRF-123"></head><body>projects</body></html>'

/**
 * Just enough of Overleaf's login behaviour: anonymous visitors get a session
 * cookie too; logging in issues a new HttpOnly one; /project bounces anyone
 * who isn't signed in back to /login.
 */
function fakeOverleaf(opts: { autoSubmitAfterMs?: number } = {}): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const cookie = req.headers.cookie ?? ''
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/login') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'overleaf.sid=anonymous; Path=/; HttpOnly' })
      const auto = opts.autoSubmitAfterMs
      res.end(`<html><body>login form${auto !== undefined ? `<script>setTimeout(() => location.href = '/do-login', ${auto})</script>` : ''}</body></html>`)
    } else if (path === '/do-login') {
      res.writeHead(302, { Location: '/project', 'Set-Cookie': 'overleaf.sid=signed-in; Path=/; HttpOnly' })
      res.end()
    } else if (path === '/project') {
      if (cookie.includes('overleaf.sid=signed-in')) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(CSRF_PAGE)
      } else {
        res.writeHead(302, { Location: '/login' })
        res.end()
      }
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }),
    ),
  )
}

let servers: Server[] = []
afterEach(() => {
  for (const s of servers) s.close()
  servers = []
})

describe('browserLogin (scripted DevTools session)', () => {
  /** A fake browser whose tab URL and cookie jar the test scripts over time. */
  function scriptedBrowser(steps: Array<{ url: string; cookies: Array<{ name: string; value: string; domain: string }> }>) {
    let polls = 0
    let closed = false
    const session: CdpSession = {
      send: async (method) => {
        const step = steps[Math.min(Math.floor(polls / 2), steps.length - 1)]!
        polls++
        if (method === 'Target.getTargets') return { targetInfos: [{ type: 'page', url: step.url }] }
        return { cookies: step.cookies }
      },
      close: async () => { closed = true },
    }
    return { session, isClosed: () => closed }
  }

  it('waits through the login page, ignores the anonymous session, and returns the signed-in cookie', async () => {
    const { url, server } = await fakeOverleaf()
    servers.push(server)
    const browser = scriptedBrowser([
      { url: `${url}/login`, cookies: [{ name: 'overleaf.sid', value: 'anonymous', domain: '127.0.0.1' }] },
      { url: `${url}/login`, cookies: [{ name: 'overleaf.sid', value: 'anonymous', domain: '127.0.0.1' }] },
      { url: `${url}/project`, cookies: [
        { name: 'unrelated', value: 'x', domain: '127.0.0.1' },
        { name: 'overleaf.sid', value: 'signed-in', domain: '127.0.0.1' },
        { name: 'overleaf.sid', value: 'other-site', domain: 'example.org' },
      ] },
    ])
    const id = await browserLogin({ url, extraHeaders: {}, pollMs: 5, launch: async () => browser.session })
    expect(id).toEqual({ sessionCookie: 'overleaf.sid=signed-in', csrfToken: 'CSRF-123' })
    expect(browser.isClosed()).toBe(true)
  })

  it('fails clearly when the user closes the window', async () => {
    const session: CdpSession = {
      send: async () => { throw new Error('browser closed') },
      close: async () => undefined,
    }
    await expect(
      browserLogin({ url: 'http://127.0.0.1:9', extraHeaders: {}, pollMs: 5, launch: async () => session }),
    ).rejects.toThrow(/window was closed/)
  })

  it('times out if login never completes, and still closes the browser', async () => {
    const { url, server } = await fakeOverleaf()
    servers.push(server)
    const browser = scriptedBrowser([{ url: `${url}/login`, cookies: [] }])
    await expect(
      browserLogin({ url, extraHeaders: {}, pollMs: 5, timeoutMs: 60, launch: async () => browser.session }),
    ).rejects.toThrow(/Timed out/)
    expect(browser.isClosed()).toBe(true)
  })
})

const installedBrowser = (() => {
  try { return findBrowser() } catch { return null }
})()

describe.skipIf(!installedBrowser)('browserLogin (real headless browser)', () => {
  it('launches the browser, reads the HttpOnly session cookie over DevTools, and cleans up its profile', async () => {
    const profilesBefore = readdirSync(tmpdir()).filter((d) => d.startsWith('overleaf-mcp-login-'))
    // The page "submits the login form" by itself after a moment, standing in for the user.
    const { url, server } = await fakeOverleaf({ autoSubmitAfterMs: 600 })
    servers.push(server)

    const messages: string[] = []
    const id = await browserLogin({
      url, extraHeaders: {}, headless: true, pollMs: 200, timeoutMs: 30_000,
      onStatus: (m) => messages.push(m),
    })

    expect(id).toEqual({ sessionCookie: 'overleaf.sid=signed-in', csrfToken: 'CSRF-123' })
    expect(messages[0]).toContain(`${url}/login`)
    const profilesAfter = readdirSync(tmpdir()).filter((d) => d.startsWith('overleaf-mcp-login-'))
    expect(profilesAfter).toEqual(profilesBefore) // throwaway profile (which held the session) is gone
  }, 45_000)
})
