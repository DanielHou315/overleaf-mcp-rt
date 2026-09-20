import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../../src/config.js'
import { passportLogin, validateCookie, fetchStickyCookies } from '../../src/overleaf/auth.js'
import { OverleafHttp } from '../../src/overleaf/http.js'
import { OverleafRest } from '../../src/overleaf/rest.js'
import { OverleafSocket } from '../../src/overleaf/socket.js'
import { OtEngine } from '../../src/overleaf/ot.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Where the live suite points. Two modes:
 *
 *  - LIVE_OVERLEAF_URL: a throw-away CE started by run-matrix.sh. The suite registers the first admin, logs in with a
 *    password and creates its own project.
 *  - LIVE_HOST=<name>: a host from the credentials file (`overleaf-mcp-rt hosts`),
 *    e.g. overleaf.com. The suite never creates or deletes projects there: it
 *    works inside one scratch folder of the project named LIVE_PROJECT (required) and
 *    removes that folder at the end.
 */
export const LIVE_URL = process.env.LIVE_OVERLEAF_URL
export const LIVE_HOST = process.env.LIVE_HOST
export const liveEnabled = Boolean(LIVE_URL || LIVE_HOST)
export const isBootstrap = Boolean(LIVE_URL)

const EMAIL = process.env.LIVE_EMAIL ?? 'agent@olmcp-live.test'
const PASSWORD = process.env.LIVE_PASSWORD ?? 'Throwaway-instance-0nly!'

/**
 * Which OT protocol the project's docs speak. On a throw-away instance the suite
 * keeps one project of each kind; run-matrix.sh switches the second one to
 * history-ot (in Mongo, before anything opens it) between the bootstrap phase
 * and the main run.
 */
export type ProjectKind = 'sharejs-text-ot' | 'history-ot'
export const PROJECT_NAMES: Record<ProjectKind, string> = {
  'sharejs-text-ot': 'live-sharejs-text-ot',
  'history-ot': 'live-history-ot',
}

export interface Target {
  kind: ProjectKind | 'as-configured'
  url: string
  sessionCookie: string
  csrfToken: string
  extraHeaders: Record<string, string>
  stickyCookies: string
  projectId: string
  /** Every path the suite touches lives under this folder. */
  scratch: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitUntilUp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(new URL('/login', url + '/'), { redirect: 'manual' })
      // Before the first admin exists some versions send /login to /launchpad.
      if (res.status === 200 || res.status === 302) return
      last = `HTTP ${res.status}`
    } catch (err) {
      last = String((err as Error).message ?? err)
    }
    await sleep(3000)
  }
  throw new Error(`Overleaf at ${url} did not come up within ${timeoutMs / 1000}s (${last})`)
}

function scrapeCsrf(html: string): string {
  const m =
    html.match(/<meta\s+name="ol-csrfToken"\s+content="([^"]+)"/) ??
    html.match(/name="_csrf"[^>]*value="([^"]+)"/) ??
    html.match(/window\.csrfToken\s*=\s*"([^"]+)"/)
  if (!m) throw new Error('no CSRF token on the launchpad page')
  return m[1]!
}

/** First-run setup of a fresh CE: the launchpad lets anyone create the first admin. */
async function registerFirstAdmin(url: string): Promise<void> {
  const page = await fetch(new URL('/launchpad', url + '/'), { redirect: 'manual' })
  if (page.status !== 200) return // an admin already exists: /launchpad redirects to /login
  const cookie = (page.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  const csrf = scrapeCsrf(await page.text())
  const res = await fetch(new URL('/launchpad/register_admin', url + '/'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-Csrf-Token': csrf },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, _csrf: csrf }),
  })
  if (res.status !== 200 && res.status !== 403) {
    throw new Error(`POST /launchpad/register_admin returned ${res.status}`)
  }
}

const cached = new Map<string, Promise<Target>>()

export function acquireTarget(kind: ProjectKind = 'sharejs-text-ot'): Promise<Target> {
  const key = isBootstrap ? kind : 'as-configured'
  let target = cached.get(key)
  if (!target) cached.set(key, target = acquire(kind))
  return target
}

async function acquire(kind: ProjectKind): Promise<Target> {
  {
    const stamp = Date.now().toString(36)
    const scratch = `mcp-live-${stamp}`
    if (isBootstrap) {
      const url = LIVE_URL!.replace(/\/$/, '')
      await waitUntilUp(url, 8 * 60_000)
      await registerFirstAdmin(url)
      const id = await passportLogin({ url, email: EMAIL, password: PASSWORD, extraHeaders: {} })
      const http = new OverleafHttp({ url, sessionCookie: id.sessionCookie, csrfToken: id.csrfToken, extraHeaders: {} })
      // Find-or-create by name, so the bootstrap phase and the main run agree on the project.
      const name = PROJECT_NAMES[kind]
      let projectId = (await new OverleafRest(http).listProjects()).find((p) => p.name === name)?.id
      if (!projectId) {
        const created = await http.postJson('/project/new', { projectName: name, template: 'example' })
        if (!created.ok) throw new Error(`POST /project/new returned ${created.status}`)
        projectId = ((await created.json()) as { project_id: string }).project_id
      }
      return { kind, url, ...id, extraHeaders: {}, stickyCookies: '', projectId, scratch }
    }
    const cfg = loadConfig({ host: LIVE_HOST! })
    const csrfToken = await validateCookie(cfg)
    const stickyCookies = await fetchStickyCookies(cfg)
    const http = new OverleafHttp({ ...cfg, csrfToken })
    // No default: on someone's real account the project must be chosen deliberately.
    const wanted = process.env.LIVE_PROJECT
    if (!wanted) throw new Error('LIVE_HOST needs LIVE_PROJECT=<name of a scratch project on that host>')
    const project = (await new OverleafRest(http).listProjects()).find((p) => p.name === wanted)
    if (!project) throw new Error(`no project named "${wanted}" on ${cfg.url}: set LIVE_PROJECT to a scratch project`)
    return { kind: 'as-configured', url: cfg.url, sessionCookie: cfg.sessionCookie, csrfToken, extraHeaders: cfg.extraHeaders, stickyCookies, projectId: project.id, scratch }
  }
}

export interface ToolResult {
  ok: boolean
  text: string
  json: any
  content: Array<Record<string, unknown>>
}

export interface Agent {
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>
  tools(): Promise<string[]>
  close(): Promise<void>
}

/** The shipped artifact, black box: `node dist/cli.js` over stdio, exactly as an MCP client runs it. */
export async function startAgent(target: Target): Promise<Agent> {
  const client = new Client({ name: 'live-suite', version: '0' }, { capabilities: {} })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'dist', 'cli.js')],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      OVERLEAF_URL: target.url,
      OVERLEAF_SESSION_COOKIE: target.sessionCookie,
      OVERLEAF_EXTRA_HEADERS: JSON.stringify(target.extraHeaders),
      OVERLEAF_CREDENTIALS_FILE: join(root, 'test', 'live', '.no-credentials-file'),
      // history-ot docs are read-only unless the user opts in; the suite is that user.
      OVERLEAF_HISTORY_OT_WRITES: '1',
    },
    stderr: 'inherit',
  }))
  return {
    async call(name, args = {}) {
      const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text?: string }> }
      const text = res.content.map((c) => c.text ?? '').join('\n')
      let json: unknown
      try { json = JSON.parse(res.content[0]?.text ?? '') } catch { json = undefined }
      return { ok: !res.isError, text, json, content: res.content }
    },
    async tools() {
      return (await client.listTools()).tools.map((t) => t.name)
    },
    close: () => client.close(),
  }
}

export interface Human {
  engine: OtEngine
  /** Things that must never happen to a person with the doc open. */
  otErrors: unknown[]
  disconnects: number
  close(): void
}

/**
 * A second, independent real-time client on the same project: what a browser
 * tab is to the server. It records the two symptoms of the bug this project
 * exists to avoid — an otUpdateError, or being disconnected from the doc.
 */
export async function joinAsHuman(target: Target): Promise<Human> {
  const cookie = target.stickyCookies ? `${target.sessionCookie}; ${target.stickyCookies}` : target.sessionCookie
  const socket = new OverleafSocket({ url: target.url, projectId: target.projectId, sessionCookie: cookie, extraHeaders: target.extraHeaders })
  const human: Human = { engine: new OtEngine({ socket, projectId: target.projectId, historyOtWrites: true }), otErrors: [], disconnects: 0, close: () => human.engine.disconnect() }
  socket.on('otUpdateError', (...args) => human.otErrors.push(args))
  socket.on('disconnect', () => { human.disconnects += 1 })
  await human.engine.connect()
  return human
}

/** A third connection with no history: what the server really has stored. */
export async function freshRead(target: Target, path: string): Promise<string> {
  const reader = await joinAsHuman(target)
  try {
    const { id } = await reader.engine.waitForPath(path, 5000)
    return (await reader.engine.joinDoc(id)).text
  } finally {
    reader.close()
  }
}

export { sleep }
