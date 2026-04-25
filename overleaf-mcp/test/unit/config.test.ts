import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { InvalidConfigError } from '../../src/errors.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('loadConfig', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'overleaf-mcp-test-'))
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
})
