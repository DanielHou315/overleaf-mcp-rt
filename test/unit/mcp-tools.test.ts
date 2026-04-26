import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { vi } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildContext } from '../../src/mcp/server.js'
import { handleListProjects, handleGetProjectTree } from '../../src/mcp/tools/projects.js'
import { handleReadDoc, handleReadFile, handleWriteDoc } from '../../src/mcp/tools/docs.js'
import {
  handleCompile,
  handleReadCompileLog,
  handleDownloadPdf,
} from '../../src/mcp/tools/compile.js'
import { OtEngine } from '../../src/overleaf/ot.js'
import { FakeSocket } from './fake-socket.js'
import type { JoinProjectResponse } from '../../src/overleaf/ot.types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '..', 'fixtures')
const projectListHtml = readFileSync(join(FIXTURES, 'project-list.html'), 'utf-8')
const projectZip = readFileSync(join(FIXTURES, 'project.zip'))

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const ctx = buildContext({
  url: 'https://o.example',
  sessionCookie: 'overleaf_session2=abc',
  extraHeaders: {},
  debug: false,
  csrfToken: 'csrf',
})

function arrayBufferOf(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

function buildOtTestCtx() {
  const sock = new FakeSocket()
  const ctx = buildContext({
    url: 'https://o.example',
    sessionCookie: 'overleaf_session2=abc',
    extraHeaders: {},
    debug: false,
    csrfToken: 'csrf',
  })
  // Override the OT factory to inject our FakeSocket for tests
  const engineCache = new Map<string, OtEngine>()
  ;(ctx as unknown as { ot: { get: (p: string) => Promise<OtEngine> } }).ot = {
    async get(projectId: string) {
      const cached = engineCache.get(projectId)
      if (cached) return cached
      const engine = new OtEngine({ socket: sock, projectId })
      const cp = engine.connect()
      sock.simulate('connectionAccepted', null, 'pub-AGENT')
      sock.simulate('joinProjectResponse', minimalJoinResponse(projectId))
      await cp
      engineCache.set(projectId, engine)
      return engine
    },
  }
  return { ctx, sock }
}

function minimalJoinResponse(projectId: string): JoinProjectResponse {
  return {
    project: {
      _id: projectId, name: projectId, rootDoc_id: 'd-main',
      rootFolder: [{
        _id: 'root', name: 'rootFolder',
        docs: [{ _id: 'd-main', name: 'main.tex' }],
        fileRefs: [{ _id: 'f-img', name: 'figures.png' }],
        folders: [],
      }],
    },
    permissionsLevel: 'owner', protocolVersion: 2, publicId: 'pub-AGENT',
  }
}

describe('list_projects tool', () => {
  it('returns id+name list', async () => {
    server.use(
      http.get('https://o.example/project', () => HttpResponse.html(projectListHtml)),
    )
    const out = await handleListProjects(ctx, {})
    expect(out.projects).toHaveLength(2)
    expect(out.projects[0]).toMatchObject({ id: 'p1', name: 'Thesis' })
  })
})

describe('get_project_tree tool (OT-backed)', () => {
  it('returns the live tree from OT state', async () => {
    const { ctx } = buildOtTestCtx()
    const out = await handleGetProjectTree(ctx, { projectId: 'p1' })
    expect(out.tree.files.sort()).toEqual(['figures.png', 'main.tex'])
    expect(Object.keys(out.tree.folders)).toEqual([])
  })

  it('reflects mid-session tree mutations from other clients', async () => {
    const { ctx, sock } = buildOtTestCtx()
    // First get caches the engine
    const engine = await ctx.ot.get('p1')
    sock.simulate('reciveNewDoc', 'root', { _id: 'd2', name: 'extra.tex' })
    const out = await handleGetProjectTree(ctx, { projectId: 'p1' })
    expect(out.tree.files.sort()).toEqual(['extra.tex', 'figures.png', 'main.tex'])
    void engine
  })
})

describe('read_doc tool (OT-backed)', () => {
  it('returns text content via joinDoc', async () => {
    const { ctx, sock } = buildOtTestCtx()
    sock.respondToEmit('joinDoc', () => [null, ['\\documentclass{article}\n', 'Hello.'], 7, []])
    const out = await handleReadDoc(ctx, { projectId: 'p2', path: 'main.tex' })
    expect(out.content).toContain('\\documentclass')
  })

  it('throws NotFoundError when path is not in tree', async () => {
    const { ctx } = buildOtTestCtx()
    await expect(handleReadDoc(ctx, { projectId: 'p2', path: 'missing.tex' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})

describe('read_file tool (REST-backed via OT tree)', () => {
  it('looks up fileId via OT tree and fetches via REST', async () => {
    const { ctx } = buildOtTestCtx()
    server.use(
      http.get('https://o.example/project/p1/file/f-img', () =>
        HttpResponse.arrayBuffer(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer), // PNG magic
      ),
    )
    const out = await handleReadFile(ctx, { projectId: 'p1', path: 'figures.png' })
    const decoded = Buffer.from(out.contentBase64, 'base64')
    expect(decoded[0]).toBe(0x89)
    expect(decoded[1]).toBe(0x50)
  })

  it('throws NotFoundError when path is not a binary in the tree', async () => {
    const { ctx } = buildOtTestCtx()
    await expect(
      handleReadFile(ctx, { projectId: 'p1', path: 'main.tex' }), // tex is a doc, not a file
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('write_doc tool (OT)', () => {
  it('emits applyOtUpdate and bumps baseline on successful echo', async () => {
    const { ctx, sock } = buildOtTestCtx()
    sock.respondToEmit('joinDoc', () => [null, ['hello'], 0, []])
    sock.respondToEmit('applyOtUpdate', () => {
      queueMicrotask(() => sock.simulate('otUpdateApplied', {
        doc: 'd-main',
        op: [{ p: 5, i: ' world' }],
        v: 0,
        meta: { source: 'pub-AGENT', ts: 0, user_id: 'u' },
      }))
      return [null]
    })

    const out = await handleWriteDoc(ctx, {
      projectId: 'p1',
      path: 'main.tex',
      content: 'hello world',
    })
    expect(out.ok).toBe(true)
    expect(sock.emitsOf('applyOtUpdate')).toHaveLength(1)
  })

  it('throws NotFoundError when path is not a doc', async () => {
    const { ctx } = buildOtTestCtx()
    await expect(
      handleWriteDoc(ctx, { projectId: 'p1', path: 'figures.png', content: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('compile tool', () => {
  it('triggers compile and returns log + pdf URLs', async () => {
    server.use(
      http.post('https://o.example/project/p4/compile', () =>
        HttpResponse.json({
          status: 'success',
          outputFiles: [
            { path: 'output.pdf', url: '/project/p4/build/b/output/output.pdf', type: 'pdf' },
            { path: 'output.log', url: '/project/p4/build/b/output/output.log', type: 'log' },
          ],
        }),
      ),
    )
    const out = await handleCompile(ctx, { projectId: 'p4' })
    expect(out.status).toBe('success')
    expect(out.logUrl).toBe('/project/p4/build/b/output/output.log')
    expect(out.pdfUrl).toBe('/project/p4/build/b/output/output.pdf')
  })
})

describe('read_compile_log tool', () => {
  it('returns log text', async () => {
    server.use(
      http.post('https://o.example/project/p5/compile', () =>
        HttpResponse.json({
          status: 'success',
          outputFiles: [{ path: 'output.log', url: '/project/p5/build/b/output/output.log', type: 'log' }],
        }),
      ),
      http.get('https://o.example/project/p5/build/b/output/output.log', () =>
        HttpResponse.text('LaTeX Warning: blah'),
      ),
    )
    const out = await handleReadCompileLog(ctx, { projectId: 'p5' })
    expect(out.log).toContain('LaTeX Warning')
  })
})

describe('download_pdf tool', () => {
  it('returns base64-encoded pdf bytes', async () => {
    server.use(
      http.post('https://o.example/project/p6/compile', () =>
        HttpResponse.json({
          status: 'success',
          outputFiles: [{ path: 'output.pdf', url: '/project/p6/build/b/output/output.pdf', type: 'pdf' }],
        }),
      ),
      http.get('https://o.example/project/p6/build/b/output/output.pdf', () =>
        HttpResponse.arrayBuffer(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer),
      ),
    )
    const out = await handleDownloadPdf(ctx, { projectId: 'p6' })
    const decoded = Buffer.from(out.pdfBase64, 'base64')
    expect(decoded.toString('utf-8').startsWith('%PDF')).toBe(true)
  })
})
