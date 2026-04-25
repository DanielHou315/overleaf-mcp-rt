import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { OverleafHttp } from '../../src/overleaf/http.js'
import { OverleafRest } from '../../src/overleaf/rest.js'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function makeRest() {
  return new OverleafRest(
    new OverleafHttp({
      url: 'https://o.example',
      sessionCookie: 'overleaf_session2=abc',
      csrfToken: 'csrf',
      extraHeaders: {},
    }),
  )
}

describe('OverleafRest.compile', () => {
  it('POSTs and returns the parsed compile response', async () => {
    server.use(
      http.post('https://o.example/project/p1/compile', async ({ request }) => {
        const url = new URL(request.url)
        expect(url.searchParams.get('auto_compile')).toBe('true')
        const body = (await request.json()) as Record<string, unknown>
        expect(body.draft).toBe(false)
        expect(body.stopOnFirstError).toBe(false)
        return HttpResponse.json({
          status: 'success',
          outputFiles: [
            { path: 'output.pdf', url: '/project/p1/build/b1/output/output.pdf', type: 'pdf' },
            { path: 'output.log', url: '/project/p1/build/b1/output/output.log', type: 'log' },
          ],
        })
      }),
    )
    const result = await makeRest().compile('p1')
    expect(result.status).toBe('success')
    expect(result.outputFiles.map((f) => f.path)).toEqual(['output.pdf', 'output.log'])
  })

  it('passes draft and stopOnFirstError', async () => {
    server.use(
      http.post('https://o.example/project/p1/compile', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        expect(body.draft).toBe(true)
        expect(body.stopOnFirstError).toBe(true)
        return HttpResponse.json({ status: 'success', outputFiles: [] })
      }),
    )
    await makeRest().compile('p1', { draft: true, stopOnFirstError: true })
  })
})

describe('OverleafRest.downloadOutputFile', () => {
  it('returns the bytes', async () => {
    server.use(
      http.get('https://o.example/project/p1/build/b1/output/output.log', () =>
        HttpResponse.text('LaTeX log lines'),
      ),
    )
    const buf = await makeRest().downloadOutputFile('/project/p1/build/b1/output/output.log')
    expect(buf.toString('utf-8')).toBe('LaTeX log lines')
  })
})

describe('OverleafRest.downloadFile', () => {
  it('GETs /project/:id/file/:fid and returns bytes', async () => {
    server.use(
      http.get('https://o.example/project/p1/file/f1', () =>
        HttpResponse.arrayBuffer(new Uint8Array([1, 2, 3]).buffer),
      ),
    )
    const buf = await makeRest().downloadFile('p1', 'f1')
    expect(Array.from(buf)).toEqual([1, 2, 3])
  })
})
