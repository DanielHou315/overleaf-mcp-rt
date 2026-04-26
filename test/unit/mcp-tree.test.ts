import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { handleCreateFolder } from '../../src/mcp/tools/tree.js'
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
