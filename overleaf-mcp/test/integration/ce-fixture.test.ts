import { describe, it, expect } from 'vitest'
import { OverleafHttp } from '../../src/overleaf/http.js'
import { OverleafRest } from '../../src/overleaf/rest.js'
import { passportLogin } from '../../src/overleaf/auth.js'

const URL = process.env.TEST_OVERLEAF_URL ?? 'http://localhost:8080'
const EMAIL = process.env.TEST_OVERLEAF_EMAIL ?? 'user@test.local'
const PASSWORD = process.env.TEST_OVERLEAF_PASSWORD ?? 'password'

const skip = process.env.RUN_INTEGRATION !== '1'

describe.skipIf(skip)('overleaf-mcp against live CE', () => {
  it('lists projects, reads main.tex, and compiles', async () => {
    const id = await passportLogin({ url: URL, email: EMAIL, password: PASSWORD, extraHeaders: {} })
    const http = new OverleafHttp({
      url: URL,
      sessionCookie: id.sessionCookie,
      csrfToken: id.csrfToken,
      extraHeaders: {},
    })
    const rest = new OverleafRest(http)

    const projects = await rest.listProjects()
    expect(projects.length).toBeGreaterThan(0)

    const projectId = projects[0]!.id
    const zip = await rest.downloadProjectZip(projectId)
    expect(zip.length).toBeGreaterThan(50)

    const compileRes = await rest.compile(projectId)
    expect(['success', 'failure']).toContain(compileRes.status)
  }, 60_000)
})
