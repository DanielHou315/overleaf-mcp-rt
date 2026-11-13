import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerAllTools } from '../../src/mcp/tools/index.js'
import { OverleafHttp } from '../../src/overleaf/http.js'
import { OverleafRest } from '../../src/overleaf/rest.js'
import { makeToolHarness, type FakeOverleaf } from './fake-overleaf.js'

const web = setupServer()
beforeAll(() => web.listen({ onUnhandledRequest: 'error' }))
afterEach(() => web.resetHandlers())
afterAll(() => web.close())

const LOG_URL = '/project/p1/build/b1/output/output.log'
const PDF_URL = '/project/p1/build/b1/output/output.pdf'

/**
 * The compile endpoint of a current Overleaf (CompileController + ClsiManager):
 * a `rootResourcePath` in the body is compiled as given; without one the
 * project's own main document is used. Records every request body.
 */
function compileEndpoint(opts: { projectRoot?: string | null; status?: string; log?: (root: string) => string; validationProblems?: Record<string, unknown> } = {}) {
  const bodies: Array<Record<string, unknown>> = []
  web.use(
    http.post('https://o.example/project/p1/compile', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>
      bodies.push(body)
      const root = (body.rootResourcePath as string | undefined) ?? opts.projectRoot ?? null
      const status = opts.status ?? 'success'
      if (opts.validationProblems) return HttpResponse.json({ status, outputFiles: [], validationProblems: opts.validationProblems })
      if (root === null) return HttpResponse.json({ status: 'validation-problems', outputFiles: [], validationProblems: { mainFile: 'no main file specified' } })
      web.use(http.get(`https://o.example${LOG_URL}`, () => HttpResponse.text(opts.log?.(root) ?? defaultLog(root))))
      return HttpResponse.json({
        status,
        outputFiles: [
          ...(status === 'success' ? [{ path: 'output.pdf', url: PDF_URL, type: 'pdf' }] : []),
          { path: 'output.log', url: LOG_URL, type: 'log' },
        ],
      })
    }),
  )
  return bodies
}

/** As the real thing: TeX is started in the root document's folder, so the log only has its bare name. */
function defaultLog(root: string): string {
  const name = root.slice(root.lastIndexOf('/') + 1)
  return `**${name}\n(./${name}\n! Undefined control sequence.\nl.2 \\oops\n)\n`
}

/** A real MCP client on the real dispatcher; the project lives in FakeOverleaf, compiles go to the endpoint above. */
async function agent(docs: Record<string, string>, settings?: NonNullable<ConstructorParameters<typeof FakeOverleaf>[1]>['settings']) {
  const harness = await makeToolHarness(docs, { settings })
  const rest = new OverleafRest(new OverleafHttp({ url: 'https://o.example', sessionCookie: 'overleaf_session2=abc', csrfToken: 'csrf', extraHeaders: {} }))
  rest.compileRetryDelayMs = 1
  harness.ctx.rest = rest
  const server = new Server({ name: 'test', version: '0' }, { capabilities: { tools: {} } })
  registerAllTools(server, harness.ctx)
  const client = new Client({ name: 'agent', version: '0' }, { capabilities: {} })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: { projectId: 'p1', ...args } })
    const blocks = (res.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '')
    return { isError: res.isError === true, json: JSON.parse(blocks[0] || '{}') as Record<string, any>, external: blocks.slice(1).join('\n') }
  }
  return { ...harness, call }
}

const TEX = '\\documentclass{article}\\begin{document}x\\end{document}\n'

describe('what a project is set up to compile', () => {
  it('overleaf_get_project_tree reports the main document, compiler and TeX Live image', async () => {
    const { call } = await agent({ paper: TEX, appendix: 'a\n' }, { rootDocId: 'paper', compiler: 'xelatex', imageName: 'texlive-full:2025.1' })
    const tree = await call('overleaf_get_project_tree')
    expect(tree.json).toMatchObject({ rootDoc: 'paper.tex', compiler: 'xelatex', imageName: 'texlive-full:2025.1' })
    expect(tree.json.tree.files.sort()).toEqual(['appendix.tex', 'paper.tex'])
  })

  it('reports no main document when none is set, or when the one that was set is gone', async () => {
    expect((await (await agent({ a: TEX }, { rootDocId: null })).call('overleaf_get_project_tree')).json.rootDoc).toBeNull()
    expect((await (await agent({ a: TEX }, { rootDocId: 'deleted-long-ago' })).call('overleaf_get_project_tree')).json.rootDoc).toBeNull()
  })

  it('follows the main document through a rename and a move, and a collaborator changing the setting', async () => {
    const { call, server } = await agent({ paper: TEX, slides: TEX }, { rootDocId: 'paper' })
    expect((await call('overleaf_get_project_tree')).json.rootDoc).toBe('paper.tex')

    server.sock.simulate('reciveEntityRename', 'paper', 'thesis.tex')
    server.sock.simulate('reciveNewFolder', 'root', { _id: 'src', name: 'src', docs: [], fileRefs: [], folders: [] })
    server.sock.simulate('reciveEntityMove', 'paper', 'src')
    expect((await call('overleaf_get_project_tree')).json.rootDoc).toBe('src/thesis.tex')

    // Someone picks another main document, compiler and image in the editor's settings menu.
    server.sock.simulate('rootDocUpdated', 'slides')
    server.sock.simulate('compilerUpdated', 'lualatex')
    server.sock.simulate('imageNameUpdated', 'texlive-full:2024.1')
    const after = await call('overleaf_get_project_tree')
    expect(after.json).toMatchObject({ rootDoc: 'slides.tex', compiler: 'lualatex', imageName: 'texlive-full:2024.1' })
    expect(after.external).toContain('main document set to slides.tex')
    expect(after.external).toContain('compiler set to lualatex')
    // Told once.
    expect((await call('overleaf_check_changes')).external).not.toContain('main document')
  })
})

describe('overleaf_compile picks the document to compile', () => {
  it("compiles the project's main document — whatever it is called — and says which one it was", async () => {
    const bodies = compileEndpoint()
    const { call } = await agent({ paper: TEX, main: '% an old scrap, not the paper\n' }, { rootDocId: 'paper', compiler: 'xelatex' })
    const out = await call('overleaf_compile')
    expect(out.isError).toBe(false)
    // The bug this replaces: a hardcoded rootResourcePath of "main.tex", which a
    // current server compiles as given.
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ rootDoc_id: 'paper', rootResourcePath: 'paper.tex' })
    expect(out.json).toMatchObject({ status: 'success', rootDoc: 'paper.tex', compiler: 'xelatex', errorCount: 1 })
    expect(out.json.outputFiles).toEqual(['output.pdf', 'output.log'])
    expect(out.json).not.toHaveProperty('message')
  })

  it('compiles another document when asked, in a folder too, without touching the project setting', async () => {
    const bodies = compileEndpoint()
    const { call, server } = await agent({ paper: TEX, slides: TEX }, { rootDocId: 'paper' })
    server.sock.simulate('reciveNewFolder', 'root', { _id: 'talks', name: 'talks', docs: [], fileRefs: [], folders: [] })
    server.sock.simulate('reciveEntityMove', 'slides', 'talks')

    const out = await call('overleaf_compile', { rootDoc: 'talks/slides.tex' })
    expect(bodies[0]).toMatchObject({ rootDoc_id: 'slides', rootResourcePath: 'talks/slides.tex' })
    expect(out.json.rootDoc).toBe('talks/slides.tex')
    // TeX ran in talks/ and logged "./slides.tex"; the agent gets the project path.
    expect(out.json.errors[0]).toMatchObject({ file: 'talks/slides.tex', line: 2 })
    // A leading slash is how Overleaf itself writes paths.
    await call('overleaf_compile', { rootDoc: '/talks/slides.tex' })
    expect(bodies[1]).toMatchObject({ rootDoc_id: 'slides', rootResourcePath: 'talks/slides.tex' })

    expect((await call('overleaf_get_project_tree')).json.rootDoc).toBe('paper.tex')
    await call('overleaf_compile')
    expect(bodies[2]).toMatchObject({ rootDoc_id: 'paper', rootResourcePath: 'paper.tex' })
  })

  it('read_compile_log and download_pdf take the same rootDoc', async () => {
    const bodies = compileEndpoint()
    web.use(http.get(`https://o.example${PDF_URL}`, () => HttpResponse.arrayBuffer(new TextEncoder().encode('%PDF-1.5').buffer, { headers: { 'Content-Type': 'application/pdf' } })))
    const { call } = await agent({ paper: TEX, slides: TEX }, { rootDocId: 'paper' })
    const log = await call('overleaf_read_compile_log', { rootDoc: 'slides.tex' })
    expect(log.json).toMatchObject({ status: 'success', rootDoc: 'slides.tex' })
    expect(log.json.log).toContain('**slides.tex')
    const pdf = await call('overleaf_download_pdf', { rootDoc: 'slides.tex' })
    expect(pdf.isError).toBe(false)
    expect(bodies.map((b) => b.rootResourcePath)).toEqual(['slides.tex', 'slides.tex'])
  })

  it('refuses a rootDoc that is not a document of the project, before compiling anything', async () => {
    const bodies = compileEndpoint()
    const { call } = await agent({ paper: TEX }, { rootDocId: 'paper' })
    const out = await call('overleaf_compile', { rootDoc: 'nope.tex' })
    expect(out.isError).toBe(true)
    expect(out.json.code).toBe('NOT_FOUND')
    expect(out.json.message).toContain('paper.tex')
    expect(bodies).toHaveLength(0)
  })

  it('leaves the choice to the server when the project has no main document, and reports what it chose', async () => {
    const bodies = compileEndpoint({ projectRoot: 'notes.tex' })
    const { call } = await agent({ notes: TEX }, { rootDocId: null })
    const out = await call('overleaf_compile')
    expect(bodies[0]).not.toHaveProperty('rootResourcePath')
    expect(bodies[0]).not.toHaveProperty('rootDoc_id')
    expect(out.json).toMatchObject({ status: 'success', rootDoc: 'notes.tex' })
  })

  it('reports a server-chosen document in a folder by its project path, and not at all if the name is ambiguous', async () => {
    compileEndpoint({ projectRoot: 'drafts/notes.tex' })
    const { call, server } = await agent({ notes: TEX, other: 'x\n' }, { rootDocId: null })
    server.sock.simulate('reciveNewFolder', 'root', { _id: 'drafts', name: 'drafts', docs: [], fileRefs: [], folders: [] })
    server.sock.simulate('reciveEntityMove', 'notes', 'drafts')
    const out = await call('overleaf_compile')
    expect(out.json.rootDoc).toBe('drafts/notes.tex')
    expect(out.json.errors[0].file).toBe('drafts/notes.tex')

    server.sock.simulate('reciveNewDoc', 'root', { _id: 'notes2', name: 'notes.tex' })
    expect((await call('overleaf_compile')).json.rootDoc).toBeNull()
  })

  it('says what to do when the server cannot pick a main document either', async () => {
    compileEndpoint({ projectRoot: null })
    const { call } = await agent({ a: 'x\n', b: 'y\n' }, { rootDocId: null })
    const out = await call('overleaf_compile')
    expect(out.isError).toBe(false)
    expect(out.json).toMatchObject({ status: 'validation-problems', rootDoc: null, pdfUrl: null, outputFiles: [] })
    expect(out.json.message).toContain('rootDoc')
    expect(out.json.validationProblems).toEqual({ mainFile: 'no main file specified' })
    const pdf = await call('overleaf_download_pdf')
    expect(pdf.isError).toBe(true)
    expect(pdf.json.message).toContain('no main document')
  })
})

describe('overleaf_compile reports how the build went', () => {
  it('lists the errors and warnings of a failed build with file and line', async () => {
    compileEndpoint({
      status: 'failure',
      log: (root) => [
        `**${root}`, `(./${root}`, '(./sections/intro.tex',
        '! Undefined control sequence.', 'l.12 \\oops', '',
        "LaTeX Warning: Reference `fig:x' on page 1 undefined on input line 20.", '', ')',
      ].join('\n'),
    })
    const { call } = await agent({ paper: TEX }, { rootDocId: 'paper' })
    const out = await call('overleaf_compile')
    expect(out.isError).toBe(false)
    expect(out.json.status).toBe('failure')
    expect(out.json.message).toContain('no PDF')
    expect(out.json.pdfUrl).toBeNull()
    expect(out.json.errors).toEqual([{ file: 'sections/intro.tex', line: 12, message: 'Undefined control sequence.', context: '\\oops' }])
    expect(out.json.warnings).toEqual([{ file: 'sections/intro.tex', line: 20, message: "Reference `fig:x' on page 1 undefined on input line 20." }])
  })

  it('still returns the compile result when the log cannot be fetched', async () => {
    web.use(
      http.post('https://o.example/project/p1/compile', () => HttpResponse.json({
        status: 'success',
        outputFiles: [{ path: 'output.pdf', url: PDF_URL, type: 'pdf' }, { path: 'output.log', url: LOG_URL, type: 'log' }],
      })),
      http.get(`https://o.example${LOG_URL}`, () => new HttpResponse(null, { status: 404 })),
    )
    const { call } = await agent({ paper: TEX }, { rootDocId: 'paper' })
    const out = await call('overleaf_compile')
    expect(out.isError).toBe(false)
    expect(out.json).toMatchObject({ status: 'success', rootDoc: 'paper.tex' })
    expect(out.json).not.toHaveProperty('errors')
  })

  it.each(['timedout', 'compile-in-progress', 'project-too-large', 'clsi-maintenance', 'something-new'])('explains status %s', async (status) => {
    web.use(http.post('https://o.example/project/p1/compile', () => HttpResponse.json({ status, outputFiles: [] })))
    const { call } = await agent({ paper: TEX }, { rootDocId: 'paper' })
    const out = await call('overleaf_compile')
    expect(out.json.status).toBe(status)
    expect(out.json.message).toBeTruthy()
  })
})
