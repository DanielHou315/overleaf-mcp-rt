import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { hostNameForUrl, loadConfig, loadHosts, saveHost } from '../../src/config.js'
import { fetchStickyCookies, resolvePastedCookie } from '../../src/overleaf/auth.js'
import { HostRegistry, type ServerContext } from '../../src/mcp/server.js'
import { registerAllTools } from '../../src/mcp/tools/index.js'
import { AuthFailedError } from '../../src/errors.js'
import type { HostConfig } from '../../src/config.js'
import { makeToolHarness } from './fake-overleaf.js'

const csrfMetaHtml = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'csrf-meta.html'),
  'utf-8',
)

function credsFile(content?: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'olmcp-')), 'credentials.json')
  if (content !== undefined) writeFileSync(path, JSON.stringify(content))
  return path
}

describe('multi-host credentials', () => {
  it('names hosts after their hostname, dropping www.', () => {
    expect(hostNameForUrl('https://www.overleaf.com')).toBe('overleaf.com')
    expect(hostNameForUrl('https://tex.example.org:8443/latex')).toBe('tex.example.org')
  })

  it('reads a legacy single-host file as one default host', () => {
    const credentialsPath = credsFile({ url: 'https://tex.example.org', session_cookie: 'overleaf.sid=a' })
    expect(loadHosts({ env: {}, credentialsPath })).toEqual({
      defaultHost: 'tex.example.org',
      hosts: [{ name: 'tex.example.org', url: 'https://tex.example.org', sessionCookie: 'overleaf.sid=a', extraHeaders: {}, debug: false }],
    })
  })

  it('adding a second host upgrades the legacy file and keeps the first as default', () => {
    const credentialsPath = credsFile({ url: 'https://tex.example.org', session_cookie: 'overleaf.sid=a' })
    const saved = saveHost(
      { name: 'overleaf.com', url: 'https://www.overleaf.com', sessionCookie: 'overleaf_session2=b', extraHeaders: {} },
      { credentialsPath },
    )
    expect(saved.isDefault).toBe(false)
    const cfg = loadHosts({ env: {}, credentialsPath })
    expect(cfg.defaultHost).toBe('tex.example.org')
    expect(cfg.hosts.map((h) => [h.name, h.sessionCookie])).toEqual([
      ['tex.example.org', 'overleaf.sid=a'],
      ['overleaf.com', 'overleaf_session2=b'],
    ])
    expect(statSync(credentialsPath).mode & 0o777).toBe(0o600)
  })

  it('re-logging in to a host replaces only that host; --default moves the default', () => {
    const credentialsPath = credsFile()
    saveHost({ name: 'a', url: 'https://a.example', sessionCookie: 'c=1', extraHeaders: {} }, { credentialsPath })
    saveHost({ name: 'b', url: 'https://b.example', sessionCookie: 'c=2', extraHeaders: {} }, { credentialsPath })
    saveHost({ name: 'a', url: 'https://a.example', sessionCookie: 'c=3', extraHeaders: {} }, { credentialsPath })
    expect(loadConfig({ env: {}, credentialsPath }).sessionCookie).toBe('c=3')
    expect(loadConfig({ env: {}, credentialsPath, host: 'b' }).url).toBe('https://b.example')
    saveHost({ name: 'b', url: 'https://b.example', sessionCookie: 'c=2', extraHeaders: {} }, { credentialsPath, makeDefault: true })
    expect(loadHosts({ env: {}, credentialsPath }).defaultHost).toBe('b')
  })

  it('OVERLEAF_URL in the environment becomes the default host without hiding file hosts', () => {
    const credentialsPath = credsFile({ default: 'a', hosts: { a: { url: 'https://a.example', session_cookie: 'c=1' } } })
    const cfg = loadHosts({
      env: { OVERLEAF_URL: 'https://www.overleaf.com', OVERLEAF_SESSION_COOKIE: 'overleaf_session2=x' },
      credentialsPath,
    })
    expect(cfg.defaultHost).toBe('overleaf.com')
    expect(cfg.hosts.map((h) => h.name).sort()).toEqual(['a', 'overleaf.com'])
  })

  it('rejects an unknown host by listing the known ones', () => {
    const credentialsPath = credsFile({ default: 'a', hosts: { a: { url: 'https://a.example', session_cookie: 'c=1' } } })
    expect(() => loadConfig({ env: {}, credentialsPath, host: 'nope' })).toThrow(/Known hosts: a/)
  })
})

describe('overleaf.com session plumbing', () => {
  const server = setupServer()
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  it('picks up the load balancer stickiness cookie from the socket.io endpoint', async () => {
    server.use(
      http.get('https://www.overleaf.example/socket.io/socket.io.js', () =>
        new HttpResponse('/* js */', { headers: { 'Set-Cookie': 'GCLB=pod-7; path=/; HttpOnly' } }),
      ),
    )
    expect(
      await fetchStickyCookies({ url: 'https://www.overleaf.example', sessionCookie: 'overleaf_session2=s', extraHeaders: {} }),
    ).toBe('GCLB=pod-7')
  })

  it('returns nothing for a single-node instance, or when the endpoint is unreachable', async () => {
    server.use(
      http.get('https://ce.example/socket.io/socket.io.js', () => new HttpResponse('/* js */')),
      http.get('https://down.example/socket.io/socket.io.js', () => HttpResponse.error()),
    )
    expect(await fetchStickyCookies({ url: 'https://ce.example', sessionCookie: 'a=b', extraHeaders: {} })).toBe('')
    expect(await fetchStickyCookies({ url: 'https://down.example', sessionCookie: 'a=b', extraHeaders: {} })).toBe('')
  })

  it('accepts a bare cookie value and finds the cookie name the instance uses', async () => {
    const tried: string[] = []
    server.use(
      http.get('https://ce.example/project', ({ request }) => {
        const cookie = request.headers.get('cookie') ?? ''
        tried.push(cookie.split('=')[0]!)
        return cookie.startsWith('overleaf.sid=')
          ? HttpResponse.html(csrfMetaHtml)
          : HttpResponse.text('', { status: 302, headers: { Location: '/login' } })
      }),
    )
    const id = await resolvePastedCookie({ url: 'https://ce.example', pasted: '  s%3Aabc.def  ', extraHeaders: {} })
    expect(id).toEqual({ sessionCookie: 'overleaf.sid=s%3Aabc.def', csrfToken: 'POST-CSRF-TOKEN' })
    expect(tried).toEqual(['overleaf_session2', 'overleaf.sid'])
  })

  it('uses a pasted name=value pair as-is and reports a bad cookie as an auth failure', async () => {
    server.use(
      http.get('https://ce.example/project', () =>
        HttpResponse.text('', { status: 302, headers: { Location: '/login' } }),
      ),
    )
    await expect(
      resolvePastedCookie({ url: 'https://ce.example', pasted: 'Cookie: overleaf_session2=bad', extraHeaders: {} }),
    ).rejects.toBeInstanceOf(AuthFailedError)
  })
})

describe('HostRegistry', () => {
  const hosts: HostConfig[] = [
    { name: 'home', url: 'https://tex.example.org', sessionCookie: 'c=1', extraHeaders: {}, debug: false },
    { name: 'overleaf.com', url: 'https://www.overleaf.com', sessionCookie: 'c=2', extraHeaders: {}, debug: false },
  ]
  const fakeCtx = (tag: string) => ({ tag, ot: { closeAll: async () => undefined } }) as unknown as ServerContext

  it('connects each host lazily, once, and routes by name with a default', async () => {
    const connected: string[] = []
    const reg = new HostRegistry(
      () => ({ hosts, defaultHost: 'home' }),
      async (h) => (connected.push(h.name), fakeCtx(h.name)),
    )
    expect(reg.list().map((h) => [h.name, h.isDefault, h.connected])).toEqual([
      ['home', true, false], ['overleaf.com', false, false],
    ])
    expect(await reg.get()).toMatchObject({ tag: 'home' })
    expect(await reg.get('overleaf.com')).toMatchObject({ tag: 'overleaf.com' })
    await reg.get('home')
    expect(connected).toEqual(['home', 'overleaf.com'])
  })

  it('does not cache a failed connection, and picks up a refreshed cookie without a restart', async () => {
    let cookie = 'c=expired'
    let attempts = 0
    const reg = new HostRegistry(
      () => ({ hosts: [{ ...hosts[0]!, sessionCookie: cookie }], defaultHost: 'home' }),
      async (h) => {
        attempts++
        if (h.sessionCookie === 'c=expired') throw new AuthFailedError('expired')
        return fakeCtx(h.sessionCookie)
      },
    )
    await expect(reg.get()).rejects.toBeInstanceOf(AuthFailedError)
    await expect(reg.get()).rejects.toBeInstanceOf(AuthFailedError)
    cookie = 'c=fresh' // user ran `login` in another terminal
    expect(await reg.get()).toMatchObject({ tag: 'c=fresh' })
    expect(attempts).toBe(3)
  })

  it('names the configured hosts when asked for one that does not exist', () => {
    const reg = new HostRegistry(() => ({ hosts, defaultHost: 'home' }), async () => fakeCtx('x'))
    expect(() => reg.get('typo')).toThrow(/Configured hosts: home, overleaf\.com/)
  })
})

describe('MCP tools with several hosts', () => {
  async function agent() {
    const home = await makeToolHarness({ main: 'home text' })
    const cloud = await makeToolHarness({ main: 'cloud text' })
    const source = {
      list: () => [
        { name: 'home', url: 'https://tex.example.org', isDefault: true, connected: true },
        { name: 'overleaf.com', url: 'https://www.overleaf.com', isDefault: false, connected: false },
      ],
      get: async (name?: string) => {
        if (name && name !== 'home' && name !== 'overleaf.com') throw new AuthFailedError(`unknown ${name}`)
        return name === 'overleaf.com' ? cloud.ctx : home.ctx
      },
    }
    const server = new Server({ name: 't', version: '0' }, { capabilities: { tools: {} } })
    registerAllTools(server, source)
    const client = new Client({ name: 'a', version: '0' }, { capabilities: {} })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args })
      return JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as Record<string, any>
    }
    return { client, call, home, cloud }
  }

  it('advertises overleaf_list_hosts and a host argument on every other tool', async () => {
    const { client } = await agent()
    const { tools } = await client.listTools()
    expect(tools[0]!.name).toBe('overleaf_list_hosts')
    for (const tool of tools.slice(1)) {
      expect(tool.inputSchema.properties, tool.name).toHaveProperty('host')
      expect(tool.inputSchema.required ?? [], tool.name).not.toContain('host')
    }
  })

  it('routes each call to the requested host, defaulting when host is omitted', async () => {
    const { call, home, cloud } = await agent()
    expect((await call('overleaf_list_hosts', {})).hosts.map((h: { name: string }) => h.name)).toEqual(['home', 'overleaf.com'])
    expect((await call('overleaf_read_doc', { projectId: 'p1', path: 'main.tex' })).content).toBe('home text')
    expect((await call('overleaf_read_doc', { projectId: 'p1', path: 'main.tex', host: 'overleaf.com' })).content).toBe('cloud text')

    await call('overleaf_edit_doc', {
      projectId: 'p1', path: 'main.tex', host: 'overleaf.com',
      edits: [{ old_string: 'cloud', new_string: 'production' }],
    })
    expect(cloud.server.text('main')).toBe('production text')
    expect(home.server.text('main')).toBe('home text')
  })

  it('returns a structured error for an unknown host', async () => {
    const { call } = await agent()
    expect((await call('overleaf_read_doc', { projectId: 'p1', path: 'main.tex', host: 'typo' })).code).toBe('OVERLEAF_AUTH_FAILED')
  })
})
