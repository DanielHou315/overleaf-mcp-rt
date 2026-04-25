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
      { id: 'p1', name: 'Thesis', lastUpdated: '2026-04-20T12:00:00Z', ownerEmail: 'me@example.com' },
      { id: 'p2', name: 'Paper', lastUpdated: '2026-04-22T13:00:00Z', ownerEmail: 'me@example.com' },
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
