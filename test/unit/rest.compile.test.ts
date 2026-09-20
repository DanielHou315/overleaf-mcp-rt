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
        // Not an editor keystroke-compile: those are throttled server-wide.
        expect(new URL(request.url).searchParams.has('auto_compile')).toBe(false)
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

describe('OverleafRest.compile when the project was compiled less than a second ago', () => {
  // Found by the live suite: compile → read_compile_log back to back got
  // {status: 'too-recently-compiled', outputFiles: []} and reported "no log".
  it('waits out the server\'s one-second window and compiles again', async () => {
    let calls = 0
    server.use(
      http.post('https://o.example/project/p1/compile', () => {
        calls += 1
        return calls === 1
          ? HttpResponse.json({ status: 'too-recently-compiled', outputFiles: [] })
          : HttpResponse.json({ status: 'success', outputFiles: [{ path: 'output.log', url: '/l', type: 'log' }] })
      }),
    )
    const rest = makeRest()
    rest.compileRetryDelayMs = 5
    const result = await rest.compile('p1')
    expect(calls).toBe(2)
    expect(result.status).toBe('success')
    expect(result.outputFiles).toHaveLength(1)
  })

  it('retries once only, and hands back the status if the server still refuses', async () => {
    let calls = 0
    server.use(
      http.post('https://o.example/project/p1/compile', () => {
        calls += 1
        return HttpResponse.json({ status: 'too-recently-compiled', outputFiles: [] })
      }),
    )
    const rest = makeRest()
    rest.compileRetryDelayMs = 5
    expect((await rest.compile('p1')).status).toBe('too-recently-compiled')
    expect(calls).toBe(2)
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
    const { bytes, contentType } = await rest.downloadOutputFile(url, compileRes)
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

  // Found by the live suite on overleaf.com: without these the download 404s,
  // because the build only exists on the compile server that ran it.
  it('routes the download to the compile server that holds the build', async () => {
    let seen: URL | undefined
    server.use(
      http.get('https://cdn.o.example/zone/c/project/p7/build/b/output/output.log', ({ request }) => {
        seen = new URL(request.url)
        return HttpResponse.text('log')
      }),
    )
    await makeRest().downloadOutputFile('/project/p7/build/b/output/output.log', {
      pdfDownloadDomain: 'https://cdn.o.example/zone/c', compileGroup: 'standard', clsiServerId: 'clsi-7',
    })
    expect(seen!.searchParams.get('clsiserverid')).toBe('clsi-7')
    expect(seen!.searchParams.get('compileGroup')).toBe('standard')
  })

  it('keeps the session cookie and proxy headers on the Overleaf origin', async () => {
    const headersAt: Record<string, Headers> = {}
    server.use(
      http.get('https://cdn.o.example/project/p7/build/b/output/output.log', ({ request }) => {
        headersAt.cdn = request.headers
        return HttpResponse.text('log')
      }),
      http.get('https://o.example/project/p7/build/b/output/output.log', ({ request }) => {
        headersAt.origin = request.headers
        return HttpResponse.text('log')
      }),
    )
    const rest = makeRest()
    await rest.downloadOutputFile('/project/p7/build/b/output/output.log', { pdfDownloadDomain: 'https://cdn.o.example' })
    await rest.downloadOutputFile('/project/p7/build/b/output/output.log')
    expect(headersAt.cdn!.get('cookie')).toBeNull()
    expect(headersAt.origin!.get('cookie')).toContain('=')
  })
})
