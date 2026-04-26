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

  it('warns when CF-Access-style headers are detected but extraHeaders is empty', async () => {
    server.use(
      http.get('https://o.example/project', () =>
        HttpResponse.html(csrfMetaHtml, { headers: { 'cf-ray': 'abc-LHR' } }),
      ),
    )
    const lines: string[] = []
    await runDiagnose(
      {
        url: 'https://o.example',
        sessionCookie: 'overleaf_session2=abc',
        extraHeaders: {},
      },
      { writeLine: (s) => lines.push(s), skipOt: true },
    )
    expect(lines.join('\n')).toMatch(/⚠.*CF/i)
  })
})
