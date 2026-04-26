import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import {
  handleCreateDoc,
  handleCreateFolder,
  handleUploadFile,
  handleRename,
  handleMove,
  handleDeleteEntity,
} from '../../src/mcp/tools/tree.js'
import { OtEngine } from '../../src/overleaf/ot.js'
import { FakeSocket } from './fake-socket.js'
import { buildContext } from '../../src/mcp/server.js'
import type { JoinProjectResponse } from '../../src/overleaf/ot.types.js'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function joinResp(): JoinProjectResponse {
  return {
    project: {
      _id: 'p1', name: 'p1', rootDoc_id: 'd-main',
      rootFolder: [{
        _id: 'root', name: 'rootFolder',
        docs: [{ _id: 'd-main', name: 'main.tex' }],
        fileRefs: [],
        folders: [{ _id: 'sub', name: 'subdir', docs: [], fileRefs: [], folders: [] }],
      }],
    },
    permissionsLevel: 'owner', protocolVersion: 2, publicId: 'pub-AGENT',
  }
}

function buildTreeTestCtx() {
  const sock = new FakeSocket()
  const ctx = buildContext({
    url: 'https://o.example',
    sessionCookie: 'overleaf_session2=abc',
    extraHeaders: {},
    debug: false,
    csrfToken: 'csrf',
  })
  const engineCache = new Map<string, OtEngine>()
  ;(ctx as unknown as { ot: { get: (p: string) => Promise<OtEngine> } }).ot = {
    async get(projectId: string) {
      const cached = engineCache.get(projectId)
      if (cached) return cached
      const engine = new OtEngine({ socket: sock, projectId })
      const cp = engine.connect()
      sock.simulate('connectionAccepted', null, 'pub-AGENT')
      sock.simulate('joinProjectResponse', joinResp())
      await cp
      engineCache.set(projectId, engine)
      return engine
    },
  }
  return { ctx, sock }
}

describe('create_folder tool', () => {
  it('resolves parentPath, calls REST, awaits broadcast and returns id', async () => {
    const { ctx, sock } = buildTreeTestCtx()
    server.use(
      http.post('https://o.example/project/p1/folder', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        expect(body).toEqual({ name: 'newdir', parent_folder_id: 'root' })
        // Schedule the broadcast that the engine listens for.
        setTimeout(() => {
          sock.simulate('reciveNewFolder', 'root', {
            _id: 'fold-new', name: 'newdir', docs: [], fileRefs: [], folders: [],
          })
        }, 5)
        return HttpResponse.json({ _id: 'fold-new', name: 'newdir', docs: [], fileRefs: [], folders: [] })
      }),
    )
    const out = await handleCreateFolder(ctx, { projectId: 'p1', parentPath: '', name: 'newdir' })
    expect(out).toEqual({ ok: true, id: 'fold-new', kind: 'folder' })
    // Tree state has been updated by the broadcast.
    const engine = await ctx.ot.get('p1')
    expect(engine.pathToFolderId('newdir')).toBe('fold-new')
  })

  it('uses pathToFolderId for non-root parent', async () => {
    const { ctx, sock } = buildTreeTestCtx()
    server.use(
      http.post('https://o.example/project/p1/folder', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        expect(body).toEqual({ name: 'inner', parent_folder_id: 'sub' })
        setTimeout(() => {
          sock.simulate('reciveNewFolder', 'sub', {
            _id: 'fold-inner', name: 'inner', docs: [], fileRefs: [], folders: [],
          })
        }, 5)
        return HttpResponse.json({ _id: 'fold-inner', name: 'inner', docs: [], fileRefs: [], folders: [] })
      }),
    )
    const out = await handleCreateFolder(ctx, { projectId: 'p1', parentPath: 'subdir', name: 'inner' })
    expect(out.id).toBe('fold-inner')
  })

  it('throws NotFoundError when parentPath does not resolve to a folder', async () => {
    const { ctx } = buildTreeTestCtx()
    await expect(
      handleCreateFolder(ctx, { projectId: 'p1', parentPath: 'main.tex', name: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('create_doc tool', () => {
  it('creates an empty doc when content is omitted', async () => {
    const { ctx, sock } = buildTreeTestCtx()
    server.use(
      http.post('https://o.example/project/p1/doc', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        expect(body).toEqual({ name: 'notes.tex', parent_folder_id: 'root' })
        setTimeout(() => {
          sock.simulate('reciveNewDoc', 'root', { _id: 'd-new', name: 'notes.tex' })
        }, 5)
        return HttpResponse.json({ _id: 'd-new' })
      }),
    )
    const out = await handleCreateDoc(ctx, { projectId: 'p1', parentPath: '', name: 'notes.tex' })
    expect(out).toEqual({ ok: true, id: 'd-new', kind: 'doc' })
    const engine = await ctx.ot.get('p1')
    expect(engine.pathToDocId('notes.tex')).toBe('d-new')
  })

  it('writes content via OT after creation when content is provided', async () => {
    const { ctx, sock } = buildTreeTestCtx()
    let appliedOps: unknown = null
    server.use(
      http.post('https://o.example/project/p1/doc', () => {
        setTimeout(() => {
          sock.simulate('reciveNewDoc', 'root', { _id: 'd-new', name: 'notes.tex' })
        }, 5)
        return HttpResponse.json({ _id: 'd-new' })
      }),
    )
    sock.respondToEmit('joinDoc', () => [null, [''], 0, []])
    sock.respondToEmit('applyOtUpdate', (_docId, update) => {
      appliedOps = (update as { op: unknown }).op
      queueMicrotask(() => sock.simulate('otUpdateApplied', {
        doc: 'd-new',
        op: (update as { op: unknown }).op,
        v: 0,
      }))
      return [null]
    })
    const out = await handleCreateDoc(ctx, {
      projectId: 'p1',
      parentPath: '',
      name: 'notes.tex',
      content: 'Hello v0.3',
    })
    expect(out).toEqual({ ok: true, id: 'd-new', kind: 'doc' })
    expect(appliedOps).toEqual([{ p: 0, i: 'Hello v0.3' }])
  })
})

describe('upload_file tool', () => {
  it('decodes base64 and uploads with the given mimeType', async () => {
    const { ctx, sock } = buildTreeTestCtx()
    let receivedForm: FormData | null = null
    server.use(
      http.post('https://o.example/project/p1/upload', async ({ request }) => {
        receivedForm = await request.formData()
        setTimeout(() => {
          sock.simulate('reciveNewFile', 'root', { _id: 'f-up', name: 'logo.png' })
        }, 5)
        return HttpResponse.json({ success: true, entity_id: 'f-up', entity_type: 'file' })
      }),
    )
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
    const out = await handleUploadFile(ctx, {
      projectId: 'p1',
      parentPath: '',
      name: 'logo.png',
      contentBase64: png,
      mimeType: 'image/png',
    })
    expect(out).toEqual({ ok: true, id: 'f-up', kind: 'file' })
    expect(receivedForm!.get('type')).toBe('image/png')
  })

  it('returns kind=doc when server auto-promotes a .tex upload', async () => {
    const { ctx, sock } = buildTreeTestCtx()
    server.use(
      http.post('https://o.example/project/p1/upload', () => {
        setTimeout(() => {
          sock.simulate('reciveNewDoc', 'root', { _id: 'd-promo', name: 'extra.tex' })
        }, 5)
        return HttpResponse.json({ success: true, entity_id: 'd-promo', entity_type: 'doc' })
      }),
    )
    const tex = Buffer.from('\\section{Extra}\n').toString('base64')
    const out = await handleUploadFile(ctx, {
      projectId: 'p1',
      parentPath: '',
      name: 'extra.tex',
      contentBase64: tex,
      mimeType: 'text/x-tex',
    })
    expect(out).toEqual({ ok: true, id: 'd-promo', kind: 'doc' })
  })
})

describe('rename tool', () => {
  it('resolves path → kind+id and POSTs rename', async () => {
    const { ctx, sock } = buildTreeTestCtx()
    let bodyJson: unknown = null
    server.use(
      http.post('https://o.example/project/p1/doc/d-main/rename', async ({ request }) => {
        bodyJson = await request.json()
        setTimeout(() => {
          sock.simulate('reciveEntityRename', 'd-main', 'renamed.tex')
        }, 5)
        return new HttpResponse(null, { status: 200 })
      }),
    )
    const out = await handleRename(ctx, { projectId: 'p1', path: 'main.tex', newName: 'renamed.tex' })
    expect(out).toEqual({ ok: true, id: 'd-main', kind: 'doc' })
    expect(bodyJson).toEqual({ name: 'renamed.tex' })
    const engine = await ctx.ot.get('p1')
    expect(engine.pathToDocId('renamed.tex')).toBe('d-main')
  })

  it('throws NotFoundError when path does not resolve', async () => {
    const { ctx } = buildTreeTestCtx()
    await expect(
      handleRename(ctx, { projectId: 'p1', path: 'missing.tex', newName: 'x.tex' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('move tool', () => {
  it('resolves path → kind+id and POSTs move with new parent', async () => {
    const { ctx, sock } = buildTreeTestCtx()
    let bodyJson: unknown = null
    server.use(
      http.post('https://o.example/project/p1/doc/d-main/move', async ({ request }) => {
        bodyJson = await request.json()
        setTimeout(() => sock.simulate('reciveEntityMove', 'd-main', 'sub'), 5)
        return new HttpResponse(null, { status: 200 })
      }),
    )
    const out = await handleMove(ctx, { projectId: 'p1', path: 'main.tex', newParentPath: 'subdir' })
    expect(out).toEqual({ ok: true, id: 'd-main', kind: 'doc' })
    expect(bodyJson).toEqual({ folder_id: 'sub' })
  })

  it('throws when newParentPath is not a folder', async () => {
    const { ctx } = buildTreeTestCtx()
    await expect(
      handleMove(ctx, { projectId: 'p1', path: 'main.tex', newParentPath: 'nope' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('delete_entity tool', () => {
  it.each([
    ['main.tex', 'd-main', 'doc'],
    ['subdir', 'sub', 'folder'],
  ] as const)('DELETEs entity at %s', async (path, id, kind) => {
    const { ctx, sock } = buildTreeTestCtx()
    let called = false
    server.use(
      http.delete(`https://o.example/project/p1/${kind}/${id}`, () => {
        called = true
        setTimeout(() => sock.simulate('removeEntity', id), 5)
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const out = await handleDeleteEntity(ctx, { projectId: 'p1', path })
    expect(out).toEqual({ ok: true, id, kind })
    expect(called).toBe(true)
  })

  it('throws NotFoundError on missing path', async () => {
    const { ctx } = buildTreeTestCtx()
    await expect(
      handleDeleteEntity(ctx, { projectId: 'p1', path: 'nope' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('upload_file MIME sniff fallback', () => {
  it('infers image/png from .png when mimeType is omitted', async () => {
    const { ctx, sock } = buildTreeTestCtx()
    let receivedForm: FormData | null = null
    server.use(
      http.post('https://o.example/project/p1/upload', async ({ request }) => {
        receivedForm = await request.formData()
        setTimeout(() => sock.simulate('reciveNewFile', 'root', { _id: 'f-up', name: 'logo.png' }), 5)
        return HttpResponse.json({ success: true, entity_id: 'f-up', entity_type: 'file' })
      }),
    )
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
    const out = await handleUploadFile(ctx, {
      projectId: 'p1', parentPath: '', name: 'logo.png', contentBase64: png,
    })
    expect(out.kind).toBe('file')
    expect(receivedForm!.get('type')).toBe('image/png')
  })

  it('falls back to application/octet-stream for unknown extensions', async () => {
    const { ctx, sock } = buildTreeTestCtx()
    let receivedForm: FormData | null = null
    server.use(
      http.post('https://o.example/project/p1/upload', async ({ request }) => {
        receivedForm = await request.formData()
        setTimeout(() => sock.simulate('reciveNewFile', 'root', { _id: 'f-up', name: 'mystery.bin' }), 5)
        return HttpResponse.json({ success: true, entity_id: 'f-up', entity_type: 'file' })
      }),
    )
    await handleUploadFile(ctx, {
      projectId: 'p1', parentPath: '', name: 'mystery.bin',
      contentBase64: Buffer.from([0xab, 0xcd]).toString('base64'),
    })
    expect(receivedForm!.get('type')).toBe('application/octet-stream')
  })
})
