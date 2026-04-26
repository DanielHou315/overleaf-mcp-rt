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

describe('OverleafRest.uploadFile', () => {
  it('posts multipart with targetFolderId/name/type/qqfile and returns id+kind', async () => {
    let receivedForm: FormData | null = null
    server.use(
      http.post('https://o.example/project/p1/upload', async ({ request }) => {
        const url = new URL(request.url)
        expect(url.searchParams.get('folder_id')).toBe('root')
        receivedForm = await request.formData()
        return HttpResponse.json({ success: true, entity_id: 'f-up', entity_type: 'file' })
      }),
    )
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const out = await makeRest().uploadFile('p1', 'root', 'logo.png', bytes, 'image/png')
    expect(out).toEqual({ id: 'f-up', kind: 'file' })
    expect(receivedForm!.get('targetFolderId')).toBe('root')
    expect(receivedForm!.get('name')).toBe('logo.png')
    expect(receivedForm!.get('type')).toBe('image/png')
    const upload = receivedForm!.get('qqfile')
    expect(upload).toBeInstanceOf(File)
  })

  it('passes through entity_type: doc when server auto-promotes', async () => {
    server.use(
      http.post('https://o.example/project/p1/upload', () =>
        HttpResponse.json({ success: true, entity_id: 'd-promo', entity_type: 'doc' }),
      ),
    )
    const out = await makeRest().uploadFile('p1', 'root', 'main.tex', new Uint8Array([1]), 'text/plain')
    expect(out).toEqual({ id: 'd-promo', kind: 'doc' })
  })

  it('throws on non-OK response', async () => {
    server.use(
      http.post('https://o.example/project/p1/upload', () =>
        HttpResponse.text('quota', { status: 413 }),
      ),
    )
    await expect(
      makeRest().uploadFile('p1', 'root', 'big.bin', new Uint8Array([1]), 'application/octet-stream'),
    ).rejects.toThrow(/413/)
  })
})

describe('OverleafRest.renameEntity', () => {
  it.each([
    ['doc', 'd-x'],
    ['file', 'f-x'],
    ['folder', 'fold-x'],
  ] as const)('POSTs to /project/p1/%s/:id/rename', async (kind, id) => {
    let bodyJson: unknown = null
    server.use(
      http.post(`https://o.example/project/p1/${kind}/${id}/rename`, async ({ request }) => {
        bodyJson = await request.json()
        return new HttpResponse(null, { status: 200 })
      }),
    )
    await makeRest().renameEntity('p1', kind, id, 'new-name')
    expect(bodyJson).toEqual({ name: 'new-name' })
  })

  it('throws on non-OK', async () => {
    server.use(
      http.post('https://o.example/project/p1/doc/d-x/rename', () =>
        HttpResponse.text('bad', { status: 400 }),
      ),
    )
    await expect(makeRest().renameEntity('p1', 'doc', 'd-x', 'y')).rejects.toThrow(/400/)
  })
})
