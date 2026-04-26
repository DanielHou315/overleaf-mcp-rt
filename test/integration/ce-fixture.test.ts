import { describe, it, expect } from 'vitest'
import { OverleafHttp } from '../../src/overleaf/http.js'
import { OverleafRest } from '../../src/overleaf/rest.js'
import { OverleafSocket } from '../../src/overleaf/socket.js'
import { OtEngine } from '../../src/overleaf/ot.js'
import { passportLogin } from '../../src/overleaf/auth.js'

const URL = process.env.TEST_OVERLEAF_URL ?? 'http://localhost:8080'
const EMAIL = process.env.TEST_OVERLEAF_EMAIL ?? 'user@test.local'
const PASSWORD = process.env.TEST_OVERLEAF_PASSWORD ?? 'password'

const skip = process.env.RUN_INTEGRATION !== '1'

describe.skipIf(skip)('overleaf-mcp against live CE', () => {
  it('lists, downloads zip(?), compiles via REST', async () => {
    const id = await passportLogin({ url: URL, email: EMAIL, password: PASSWORD, extraHeaders: {} })
    const http = new OverleafHttp({ url: URL, sessionCookie: id.sessionCookie, csrfToken: id.csrfToken, extraHeaders: {} })
    const rest = new OverleafRest(http)
    const projects = await rest.listProjects()
    expect(projects.length).toBeGreaterThan(0)
    const projectId = projects[0]!.id
    const compileRes = await rest.compile(projectId)
    expect(['success', 'failure']).toContain(compileRes.status)
  }, 60_000)

  it('OT: read main.tex baseline, write back with a marker comment, verify roundtrip', async () => {
    const id = await passportLogin({ url: URL, email: EMAIL, password: PASSWORD, extraHeaders: {} })
    const http = new OverleafHttp({ url: URL, sessionCookie: id.sessionCookie, csrfToken: id.csrfToken, extraHeaders: {} })
    const rest = new OverleafRest(http)
    const projects = await rest.listProjects()
    expect(projects.length).toBeGreaterThan(0)
    const projectId = projects[0]!.id

    const sock = new OverleafSocket({
      url: URL,
      projectId,
      sessionCookie: id.sessionCookie,
      extraHeaders: {},
    })
    const engine = new OtEngine({ socket: sock, projectId })
    await engine.connect()

    const docId = engine.pathToDocId('main.tex')
    expect(docId, 'project must contain main.tex at root').not.toBeNull()
    const before = (await engine.joinDoc(docId!)).text

    const marker = `% overleaf-mcp v0.2 OT smoke @ ${new Date().toISOString()}\n`
    const after = before.startsWith('% overleaf-mcp')
      ? before.replace(/^% overleaf-mcp.*\n/, marker)
      : marker + before

    await engine.writeDoc(docId!, after)

    // Force a fresh joinDoc on a new connection to verify the server stored it.
    const sock2 = new OverleafSocket({ url: URL, projectId, sessionCookie: id.sessionCookie, extraHeaders: {} })
    const engine2 = new OtEngine({ socket: sock2, projectId })
    await engine2.connect()
    const reread = (await engine2.joinDoc(docId!)).text

    expect(reread).toBe(after)
    engine.disconnect()
    engine2.disconnect()
  }, 60_000)
})
