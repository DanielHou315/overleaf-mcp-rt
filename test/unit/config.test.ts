import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defaultCredentialsPath, loadConfig, loadHosts, saveHost } from '../../src/config.js'
import { InvalidConfigError } from '../../src/errors.js'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

describe('loadConfig', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'overleaf-mcp-rt-test-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('reads URL and cookie from env', () => {
    const cfg = loadConfig({
      env: {
        OVERLEAF_URL: 'https://overleaf.example.com',
        OVERLEAF_SESSION_COOKIE: 'overleaf_session2=abc',
      },
      credentialsPath: join(tmp, 'noexist.json'),
    })
    expect(cfg.url).toBe('https://overleaf.example.com')
    expect(cfg.sessionCookie).toBe('overleaf_session2=abc')
    expect(cfg.extraHeaders).toEqual({})
  })

  it('parses OVERLEAF_EXTRA_HEADERS as JSON', () => {
    const cfg = loadConfig({
      env: {
        OVERLEAF_URL: 'https://o',
        OVERLEAF_SESSION_COOKIE: 'c',
        OVERLEAF_EXTRA_HEADERS: '{"CF-Access-Client-Id":"abc"}',
      },
      credentialsPath: join(tmp, 'noexist.json'),
    })
    expect(cfg.extraHeaders).toEqual({ 'CF-Access-Client-Id': 'abc' })
  })

  it('falls back to credentials file when env missing', () => {
    const path = join(tmp, 'creds.json')
    writeFileSync(
      path,
      JSON.stringify({
        url: 'https://from-file',
        session_cookie: 'overleaf_session2=fromfile',
        extra_headers: { 'X-Foo': 'bar' },
      }),
    )
    const cfg = loadConfig({ env: {}, credentialsPath: path })
    expect(cfg.url).toBe('https://from-file')
    expect(cfg.sessionCookie).toBe('overleaf_session2=fromfile')
    expect(cfg.extraHeaders).toEqual({ 'X-Foo': 'bar' })
  })

  it('env overrides file', () => {
    const path = join(tmp, 'creds.json')
    writeFileSync(path, JSON.stringify({ url: 'https://from-file', session_cookie: 'a' }))
    const cfg = loadConfig({
      env: { OVERLEAF_URL: 'https://from-env', OVERLEAF_SESSION_COOKIE: 'b' },
      credentialsPath: path,
    })
    expect(cfg.url).toBe('https://from-env')
    expect(cfg.sessionCookie).toBe('b')
  })

  it('throws InvalidConfigError when URL missing', () => {
    expect(() =>
      loadConfig({
        env: { OVERLEAF_SESSION_COOKIE: 'c' },
        credentialsPath: join(tmp, 'nope.json'),
      }),
    ).toThrow(InvalidConfigError)
  })

  it('throws InvalidConfigError when cookie missing', () => {
    expect(() =>
      loadConfig({
        env: { OVERLEAF_URL: 'https://o' },
        credentialsPath: join(tmp, 'nope.json'),
      }),
    ).toThrow(InvalidConfigError)
  })

  it('throws on malformed JSON in OVERLEAF_EXTRA_HEADERS', () => {
    expect(() =>
      loadConfig({
        env: {
          OVERLEAF_URL: 'https://o',
          OVERLEAF_SESSION_COOKIE: 'c',
          OVERLEAF_EXTRA_HEADERS: 'not-json',
        },
        credentialsPath: join(tmp, 'nope.json'),
      }),
    ).toThrow(InvalidConfigError)
  })

  it('throws InvalidConfigError when URL has no http(s) scheme', () => {
    expect(() =>
      loadConfig({
        env: {
          OVERLEAF_URL: '192.168.1.10:8080',
          OVERLEAF_SESSION_COOKIE: 'c',
        },
        credentialsPath: join(tmp, 'nope.json'),
      }),
    ).toThrow(/must start with http:\/\/ or https:\/\//)
  })

  it('strips trailing slashes via URL parsing (no corruption of bare https://)', () => {
    const cfg = loadConfig({
      env: { OVERLEAF_URL: 'https://o.example.com/', OVERLEAF_SESSION_COOKIE: 'c' },
      credentialsPath: join(tmp, 'noexist.json'),
    })
    expect(cfg.url).toBe('https://o.example.com')
  })

  it('preserves a configured subpath (no trailing slash)', () => {
    const cfg = loadConfig({
      env: { OVERLEAF_URL: 'https://corp.example.com/overleaf/', OVERLEAF_SESSION_COOKIE: 'c' },
      credentialsPath: join(tmp, 'noexist.json'),
    })
    expect(cfg.url).toBe('https://corp.example.com/overleaf')
  })

  it('throws InvalidConfigError when URL has no host (e.g. bare https://)', () => {
    expect(() =>
      loadConfig({
        env: { OVERLEAF_URL: 'https://', OVERLEAF_SESSION_COOKIE: 'c' },
        credentialsPath: join(tmp, 'nope.json'),
      }),
    ).toThrow(/host/i)
  })

  it('throws InvalidConfigError when URL is malformed', () => {
    expect(() =>
      loadConfig({
        env: { OVERLEAF_URL: 'http:/missing-slashes', OVERLEAF_SESSION_COOKIE: 'c' },
        credentialsPath: join(tmp, 'nope.json'),
      }),
    ).toThrow(/InvalidConfigError|invalid url/i)
  })
})

describe('credentials file location', () => {
  const where = (platform: NodeJS.Platform, env: Record<string, string> = {}, home = platform === 'win32' ? 'C:\\Users\\ada' : '/home/ada') =>
    defaultCredentialsPath({ platform, env, home })

  it('uses ~/.config on Linux and other Unixes', () => {
    expect(where('linux')).toBe('/home/ada/.config/overleaf-mcp-rt/credentials.json')
    expect(where('freebsd')).toBe('/home/ada/.config/overleaf-mcp-rt/credentials.json')
  })

  it('uses ~/Library/Application Support on macOS', () => {
    expect(where('darwin', {}, '/Users/ada')).toBe(
      '/Users/ada/Library/Application Support/overleaf-mcp-rt/credentials.json',
    )
  })

  it('uses %APPDATA% on Windows, falling back to the profile directory', () => {
    expect(where('win32', { APPDATA: 'D:\\Roaming' })).toBe('D:\\Roaming\\overleaf-mcp-rt\\credentials.json')
    expect(where('win32')).toBe('C:\\Users\\ada\\AppData\\Roaming\\overleaf-mcp-rt\\credentials.json')
  })

  it('honours an absolute XDG_CONFIG_HOME on every platform', () => {
    expect(where('linux', { XDG_CONFIG_HOME: '/cfg' })).toBe('/cfg/overleaf-mcp-rt/credentials.json')
    expect(where('darwin', { XDG_CONFIG_HOME: '/cfg' })).toBe('/cfg/overleaf-mcp-rt/credentials.json')
    expect(where('win32', { XDG_CONFIG_HOME: 'E:\\cfg', APPDATA: 'D:\\Roaming' })).toBe(
      'E:\\cfg\\overleaf-mcp-rt\\credentials.json',
    )
  })

  it('ignores a relative or empty XDG_CONFIG_HOME, as the spec requires', () => {
    expect(where('linux', { XDG_CONFIG_HOME: 'cfg' })).toBe('/home/ada/.config/overleaf-mcp-rt/credentials.json')
    expect(where('linux', { XDG_CONFIG_HOME: '' })).toBe('/home/ada/.config/overleaf-mcp-rt/credentials.json')
  })
})

// Permission bits and $HOME mean nothing on Windows.
describe.skipIf(process.platform === 'win32')('writing the credentials file', () => {
  const host = { name: 'a', url: 'https://a.example', sessionCookie: 'c=1', extraHeaders: {} }
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'olmcp-home-'))
    vi.stubEnv('HOME', join(root, 'home'))
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'xdg'))
    vi.stubEnv('OVERLEAF_CREDENTIALS_FILE', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })
  const current = () => join(root, 'xdg', 'overleaf-mcp-rt', 'credentials.json')
  const legacy = () => join(root, 'home', '.config', 'overleaf-mcp-rt', 'credentials.json')
  const mode = (p: string) => statSync(p).mode & 0o777

  it('creates the file 0600 in a 0700 directory, even under a permissive umask, and leaves no temp file', () => {
    const previous = process.umask(0)
    try {
      const saved = saveHost(host)
      expect(saved.path).toBe(current())
      expect(saved.movedFrom).toBeUndefined()
    } finally {
      process.umask(previous)
    }
    expect(mode(current())).toBe(0o600)
    expect(mode(dirname(current()))).toBe(0o700)
    expect(readdirSync(dirname(current()))).toEqual(['credentials.json'])
  })

  it('tightens a directory and file that an earlier version left open', () => {
    mkdirSync(dirname(current()), { recursive: true, mode: 0o755 })
    writeFileSync(current(), '{}', { mode: 0o644 })
    chmodSync(dirname(current()), 0o755)
    chmodSync(current(), 0o644)
    saveHost(host)
    expect(mode(current())).toBe(0o600)
    expect(mode(dirname(current()))).toBe(0o700)
  })

  it('reads a file at the pre-2.3 location, and moves it on the next save', () => {
    mkdirSync(dirname(legacy()), { recursive: true })
    writeFileSync(legacy(), JSON.stringify({ default: 'old', hosts: { old: { url: 'https://old.example', session_cookie: 'c=0' } } }))
    expect(loadHosts({ env: {} }).hosts.map((h) => h.name)).toEqual(['old'])

    const saved = saveHost(host)
    expect(saved).toMatchObject({ path: current(), movedFrom: legacy(), isDefault: false })
    expect(existsSync(legacy())).toBe(false)
    expect(existsSync(dirname(legacy()))).toBe(false)
    expect(loadHosts({ env: {} })).toMatchObject({ defaultHost: 'old', hosts: [{ name: 'old' }, { name: 'a' }] })
  })

  it('prefers the current location once it exists', () => {
    mkdirSync(dirname(legacy()), { recursive: true })
    writeFileSync(legacy(), JSON.stringify({ hosts: { stale: { url: 'https://stale.example', session_cookie: 'c=0' } } }))
    mkdirSync(dirname(current()), { recursive: true })
    writeFileSync(current(), JSON.stringify({ hosts: { fresh: { url: 'https://fresh.example', session_cookie: 'c=9' } } }))
    expect(loadHosts({ env: {} }).hosts.map((h) => h.name)).toEqual(['fresh'])
    expect(saveHost(host).movedFrom).toBeUndefined()
    expect(existsSync(legacy())).toBe(true)
  })

  it('uses an explicit path as given: no fallback, no move, parent directory left alone', () => {
    mkdirSync(dirname(legacy()), { recursive: true })
    writeFileSync(legacy(), JSON.stringify({ hosts: { old: { url: 'https://old.example', session_cookie: 'c=0' } } }))
    const shared = join(root, 'shared')
    mkdirSync(shared, { mode: 0o755 })
    vi.stubEnv('OVERLEAF_CREDENTIALS_FILE', join(shared, 'creds.json'))
    const saved = saveHost(host)
    expect(saved).toMatchObject({ path: join(shared, 'creds.json'), movedFrom: undefined })
    expect(mode(saved.path)).toBe(0o600)
    expect(mode(shared)).toBe(0o755)
    expect(existsSync(legacy())).toBe(true)
    expect(loadHosts({ env: {} }).hosts.map((h) => h.name)).toEqual(['a'])
  })
})
