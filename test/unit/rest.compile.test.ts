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
        HttpResponse.text('LaTeX log lines', { headers: { 'Content-Type': 'text/plain' } }),
      ),
    )
    const { bytes, contentType } = await makeRest().downloadOutputFile('/project/p1/build/b1/output/output.log')
    expect(bytes.toString('utf-8')).toBe('LaTeX log lines')
    expect(contentType).toMatch(/^text\/plain/)
  })
})

describe('OverleafRest.downloadFile', () => {
  it('GETs /project/:id/file/:fid and returns bytes + contentType', async () => {
    server.use(
      http.get('https://o.example/project/p1/file/f1', () =>
        HttpResponse.arrayBuffer(new Uint8Array([1, 2, 3]).buffer, {
          headers: { 'Content-Type': 'image/png' },
        }),
      ),
    )
    const { bytes, contentType } = await makeRest().downloadFile('p1', 'f1')
    expect(Array.from(bytes)).toEqual([1, 2, 3])
    expect(contentType).toBe('image/png')
  })
})

describe('OverleafRest.downloadOutputFile (with pdfDownloadDomain)', () => {
  it('joins a relative buildUrl onto pdfDownloadDomain when set', async () => {
    const rest = makeRest()
    server.use(
      http.post('https://o.example/project/p7/compile', () =>
        HttpResponse.json({
          status: 'success',
          pdfDownloadDomain: 'https://cdn.o.example',
          outputFiles: [
            { path: 'output.pdf', url: '/project/p7/build/b/output/output.pdf', type: 'pdf' },
          ],
        }),
      ),
      http.get('https://cdn.o.example/project/p7/build/b/output/output.pdf', () =>
        HttpResponse.arrayBuffer(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer, {
          headers: { 'Content-Type': 'application/pdf' },
        }),
      ),
    )
    const compileRes = await rest.compile('p7')
    expect(compileRes.pdfDownloadDomain).toBe('https://cdn.o.example')

    const url = compileRes.outputFiles.find((f) => f.path === 'output.pdf')!.url
    const { bytes, contentType } = await rest.downloadOutputFile(url, compileRes.pdfDownloadDomain)
    expect(bytes.toString('utf-8').startsWith('%PDF')).toBe(true)
    expect(contentType).toBe('application/pdf')
  })

  it('falls back to the main origin when pdfDownloadDomain is omitted', async () => {
    const rest = makeRest()
    server.use(
      http.get('https://o.example/project/p7/build/b/output/output.pdf', () =>
        HttpResponse.arrayBuffer(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer),
      ),
    )
    const { bytes } = await rest.downloadOutputFile('/project/p7/build/b/output/output.pdf')
    expect(bytes[0]).toBe(0x25)
  })
})
