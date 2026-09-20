import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDiagnose } from '../../src/cli.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '..', 'fixtures')
const csrfMetaHtml = readFileSync(join(FIXTURES, 'csrf-meta.html'), 'utf-8')

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('runDiagnose', () => {
  it('reports each step with ✓ on a healthy connection', async () => {
    server.use(
      http.get('https://o.example/project', () => HttpResponse.html(csrfMetaHtml)),
    )
    const lines: string[] = []
    const result = await runDiagnose(
      {
        url: 'https://o.example',
        sessionCookie: 'overleaf_session2=abc',
        extraHeaders: {},
      },
      { writeLine: (s) => lines.push(s), skipOt: true },
    )
    expect(result.ok).toBe(true)
    expect(lines.join('\n')).toMatch(/✓ config/i)
    expect(lines.join('\n')).toMatch(/✓ REST handshake/i)
    expect(lines.join('\n')).toMatch(/✓ project listing/i)
  })

  it('reports ✗ + AuthFailedError when the cookie is invalid', async () => {
    server.use(
      http.get('https://o.example/project', () =>
        HttpResponse.text('', { status: 302, headers: { Location: '/login' } }),
      ),
    )
    const lines: string[] = []
    const result = await runDiagnose(
      {
        url: 'https://o.example',
        sessionCookie: 'overleaf_session2=expired',
        extraHeaders: {},
      },
      { writeLine: (s) => lines.push(s), skipOt: true },
    )
    expect(result.ok).toBe(false)
    expect(lines.join('\n')).toMatch(/✗ REST handshake/i)
    expect(lines.join('\n')).toMatch(/OVERLEAF_AUTH_FAILED/i)
  })

  it('says nothing about a CDN that sits in front of a working instance', async () => {
    server.use(
      http.get('https://o.example/project', () =>
        HttpResponse.html(csrfMetaHtml, { headers: { 'cf-ray': 'abc-LHR' } }),
      ),
    )
    const lines: string[] = []
    const result = await runDiagnose(
      {
        url: 'https://o.example',
        sessionCookie: 'overleaf_session2=abc',
        extraHeaders: {},
      },
      { writeLine: (s) => lines.push(s), skipOt: true },
    )
    expect(result.ok).toBe(true)
    expect(result.steps.every((s) => s.status === 'ok')).toBe(true)
    expect(lines.join('\n')).not.toMatch(/⚠|proxy/i)
  })

  it('reports PROXY_AUTH_FAILED with a header hint when redirected to a proxy sign-in page', async () => {
    server.use(
      http.get('https://o.example/project', () =>
        HttpResponse.text('', { status: 302, headers: { Location: 'https://team.cloudflareaccess.example/cdn-cgi/access/login' } }),
      ),
    )
    const lines: string[] = []
    const result = await runDiagnose(
      { url: 'https://o.example', sessionCookie: 'overleaf_session2=abc', extraHeaders: {} },
      { writeLine: (s) => lines.push(s), skipOt: true },
    )
    expect(result.ok).toBe(false)
    const out = lines.join('\n')
    expect(out).toMatch(/✗ REST handshake — PROXY_AUTH_FAILED/)
    expect(out).toMatch(/team\.cloudflareaccess\.example/)
    expect(out).toMatch(/login --header/)
    expect(out).not.toMatch(/OVERLEAF_AUTH_FAILED/)
  })

  it('reports PROXY_AUTH_FAILED on a 403 challenge, and points at the configured headers when there are some', async () => {
    server.use(
      http.get('https://o.example/project', () =>
        HttpResponse.text('blocked', { status: 403, headers: { 'cf-mitigated': 'challenge' } }),
      ),
    )
    const lines: string[] = []
    const result = await runDiagnose(
      { url: 'https://o.example', sessionCookie: 'overleaf_session2=abc', extraHeaders: { 'CF-Access-Client-Id': 'x' } },
      { writeLine: (s) => lines.push(s), skipOt: true },
    )
    expect(result.ok).toBe(false)
    const out = lines.join('\n')
    expect(out).toMatch(/PROXY_AUTH_FAILED/)
    expect(out).toMatch(/configured extra headers/)
    expect(out).not.toMatch(/login --header/)
  })
})
