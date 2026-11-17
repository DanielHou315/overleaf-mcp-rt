import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OverleafRest } from '../../src/overleaf/rest.js'
import { OverleafHttp } from '../../src/overleaf/http.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '..', 'fixtures')
const projectListHtml = readFileSync(join(FIXTURES, 'project-list.html'), 'utf-8')

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function makeRest() {
  const httpClient = new OverleafHttp({
    url: 'https://o.example',
    sessionCookie: 'overleaf_session2=abc',
    csrfToken: 'csrf',
    extraHeaders: {},
  })
  return new OverleafRest(httpClient)
}

describe('OverleafRest.listProjects', () => {
  it('parses the prefetched projects blob', async () => {
    server.use(
      http.get('https://o.example/project', () => HttpResponse.html(projectListHtml)),
    )
    const projects = await makeRest().listProjects()
    expect(projects).toEqual([
      { id: 'p1', name: 'Thesis', lastUpdated: '2026-04-20T12:00:00Z', ownerEmail: 'me@example.com', archived: false, trashed: false },
      { id: 'p2', name: 'Paper', lastUpdated: '2026-04-22T13:00:00Z', ownerEmail: 'me@example.com', archived: true, trashed: false },
    ])
  })

  it('returns empty array when blob has no projects field', async () => {
    server.use(
      http.get('https://o.example/project', () =>
        HttpResponse.html(
          '<html><head><meta name="ol-prefetchedProjectsBlob" content=\'{"projects":[]}\'></head></html>',
        ),
      ),
    )
    const projects = await makeRest().listProjects()
    expect(projects).toEqual([])
  })

  it('throws when blob meta tag is missing', async () => {
    server.use(
      http.get('https://o.example/project', () => HttpResponse.html('<html></html>')),
    )
    await expect(makeRest().listProjects()).rejects.toThrow(/prefetchedProjectsBlob/)
  })
})



describe('OverleafRest project lifecycle', () => {
  it('creates a blank or example project', async () => {
    const seen: Array<Record<string, unknown>> = []
    server.use(
      http.post('https://o.example/project/new', async ({ request }) => {
        seen.push(await request.json() as Record<string, unknown>)
        return HttpResponse.json({ project_id: seen.length === 1 ? 'new-blank' : 'new-example' })
      }),
    )

    await expect(makeRest().createProject('Blank Paper')).resolves.toEqual({ id: 'new-blank' })
    await expect(makeRest().createProject('Example Paper', 'example')).resolves.toEqual({ id: 'new-example' })
    expect(seen).toEqual([
      { projectName: 'Blank Paper', template: 'blank' },
      { projectName: 'Example Paper', template: 'example' },
    ])
  })

  it('clones and renames projects with the dashboard routes', async () => {
    let cloneBody: Record<string, unknown> | undefined
    let renameBody: Record<string, unknown> | undefined
    server.use(
      http.post('https://o.example/project/p1/clone', async ({ request }) => {
        cloneBody = await request.json() as Record<string, unknown>
        return HttpResponse.json({ project_id: 'p2' })
      }),
      http.post('https://o.example/project/p1/rename', async ({ request }) => {
        renameBody = await request.json() as Record<string, unknown>
        return new HttpResponse(null, { status: 204 })
      }),
    )

    await expect(makeRest().cloneProject('p1', 'Copy')).resolves.toEqual({ id: 'p2' })
    await expect(makeRest().renameProject('p1', 'Renamed')).resolves.toBeUndefined()
    expect(cloneBody).toEqual({ projectName: 'Copy' })
    expect(renameBody).toEqual({ newProjectName: 'Renamed' })
  })

  it('archives, restores, trashes and restores projects', async () => {
    const calls: string[] = []
    server.use(
      http.post('https://o.example/project/p1/archive', () => {
        calls.push('archive')
        return new HttpResponse(null, { status: 204 })
      }),
      http.delete('https://o.example/project/p1/archive', () => {
        calls.push('unarchive')
        return new HttpResponse(null, { status: 204 })
      }),
      http.post('https://o.example/project/p1/trash', () => {
        calls.push('trash')
        return new HttpResponse(null, { status: 204 })
      }),
      http.delete('https://o.example/project/p1/trash', () => {
        calls.push('untrash')
        return new HttpResponse(null, { status: 204 })
      }),
    )

    const rest = makeRest()
    await rest.archiveProject('p1')
    await rest.unarchiveProject('p1')
    await rest.trashProject('p1')
    await rest.untrashProject('p1')

    expect(calls).toEqual(['archive', 'unarchive', 'trash', 'untrash'])
  })

  it('rejects malformed create responses', async () => {
    server.use(
      http.post('https://o.example/project/new', () => HttpResponse.json({})),
    )
    await expect(makeRest().createProject('Broken')).rejects.toThrow(/project_id/)
  })

  it("passes Overleaf's reason for refusing a name through", async () => {
    server.use(
      http.post('https://o.example/project/p1/rename', () =>
        HttpResponse.text('Project name cannot contain / characters', { status: 400 }),
      ),
      http.post('https://o.example/project/new', () =>
        HttpResponse.text('Project name cannot contain / characters', { status: 400 }),
      ),
    )
    await expect(makeRest().renameProject('p1', 'a/b')).rejects.toMatchObject({
      code: 'OVERLEAF_GENERIC',
      message: 'renameProject returned 400: Project name cannot contain / characters',
      context: { status: 400, projectId: 'p1', reason: 'Project name cannot contain / characters' },
    })
    await expect(makeRest().createProject('a/b')).rejects.toThrow(
      'createProject returned 400: Project name cannot contain / characters',
    )
  })

  it('does not paste an HTML error page into the message', async () => {
    server.use(
      http.post('https://o.example/project/p1/clone', () =>
        HttpResponse.html('<html><body>Server Error</body></html>', { status: 500 }),
      ),
    )
    const err = await makeRest().cloneProject('p1', 'Copy').catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'OVERLEAF_GENERIC', message: 'cloneProject returned 500' })
  })

  it('maps a 404 to NOT_FOUND', async () => {
    server.use(
      http.post('https://o.example/project/nope/trash', () => new HttpResponse('Not found', { status: 404 })),
    )
    await expect(makeRest().trashProject('nope')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      context: { projectId: 'nope' },
    })
  })
})
