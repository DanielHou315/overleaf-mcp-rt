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

describe('OverleafRest.createDoc', () => {
  it('POSTs name + parent_folder_id and returns the new id', async () => {
    server.use(
      http.post('https://o.example/project/p1/doc', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        expect(body).toEqual({ name: 'notes.tex', parent_folder_id: 'root' })
        expect(request.headers.get('x-csrf-token')).toBe('csrf')
        return HttpResponse.json({ _id: 'd-new' })
      }),
    )
    const out = await makeRest().createDoc('p1', 'root', 'notes.tex')
    expect(out).toEqual({ id: 'd-new' })
  })

  it('throws OverleafError on non-OK response', async () => {
    server.use(
      http.post('https://o.example/project/p1/doc', () =>
        HttpResponse.text('forbidden', { status: 403 }),
      ),
    )
    await expect(makeRest().createDoc('p1', 'root', 'x.tex')).rejects.toThrow(/403/)
  })
})

describe('OverleafRest.createFolder', () => {
  it('POSTs name + parent_folder_id and returns the new id', async () => {
    server.use(
      http.post('https://o.example/project/p1/folder', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        expect(body).toEqual({ name: 'chapters', parent_folder_id: 'root' })
        return HttpResponse.json({ _id: 'fold-new', name: 'chapters', docs: [], fileRefs: [], folders: [] })
      }),
    )
    const out = await makeRest().createFolder('p1', 'root', 'chapters')
    expect(out).toEqual({ id: 'fold-new' })
  })

  it('throws on non-OK response', async () => {
    server.use(
      http.post('https://o.example/project/p1/folder', () =>
        HttpResponse.text('bad', { status: 400 }),
      ),
    )
    await expect(makeRest().createFolder('p1', 'root', 'x')).rejects.toThrow(/400/)
  })
})
