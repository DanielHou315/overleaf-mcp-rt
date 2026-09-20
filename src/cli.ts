#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output, stderr } from 'node:process'
import { hostNameForUrl, loadConfig, loadHosts, saveHost } from './config.js'
import { validateCookie, passportLogin, resolvePastedCookie, fetchStickyCookies } from './overleaf/auth.js'
import { buildContext, runMcpServer, HostRegistry } from './mcp/server.js'
import { browserLogin } from './overleaf/browser-login.js'
import { installSkills, listSkills } from './skills.js'
import { InvalidConfigError, OverleafError, AuthFailedError } from './errors.js'
import { OverleafHttp } from './overleaf/http.js'
import { OverleafRest } from './overleaf/rest.js'
import { OverleafSocket } from './overleaf/socket.js'
import { OtEngine } from './overleaf/ot.js'

const HELP = `
overleaf-mcp-rt — MCP server for Overleaf Community Edition (v1.0)

Usage:
  overleaf-mcp-rt                Run as MCP stdio server (default).
  overleaf-mcp-rt login          Add or refresh a host. Opens a browser window to sign in (--browser),
                                 or takes a pasted cookie (--cookie) or email + password (--email).
                                 --url <url> [--name <name>] [--default] [--browser]
                                 [--cookie <cookie>] [--email <email>] [--header KEY=VALUE]...
  overleaf-mcp-rt hosts          List configured hosts.
  overleaf-mcp-rt ls [--host <name>]         List accessible projects (smoke test).
  overleaf-mcp-rt diagnose [--host <name>]   Verify connectivity, auth, and OT handshake.
  overleaf-mcp-rt skills         List the agent skills shipped with this package.
  overleaf-mcp-rt skills install [--target <dir>]
                                 Copy them into a skills directory (default ~/.claude/skills).
  overleaf-mcp-rt --help         Show this help.

Several Overleaf instances can be configured side by side (run \`login\` once per
instance). MCP tools take an optional \`host\` argument; the default host is used
when it is omitted.

\`login --browser\` launches your installed Chrome/Chromium/Edge/Brave with a
throwaway profile; sign in there as usual (CAPTCHA, SSO and 2FA all work) and the
session is picked up automatically. This is the way to log in to overleaf.com,
whose password form is CAPTCHA-protected. Set OVERLEAF_BROWSER to use a specific
browser binary. Alternatively paste the \`overleaf_session2\` cookie from devtools.

Environment variables:
  OVERLEAF_URL                Required. e.g. https://overleaf.example.com
  OVERLEAF_SESSION_COOKIE     Required (or run \`overleaf-mcp-rt login\`).
  OVERLEAF_EXTRA_HEADERS      JSON object of extra headers (e.g. CF Access service token).
  OVERLEAF_DEBUG              "1" for verbose stderr logging.
`

export interface DiagnoseConfig {
  url: string
  sessionCookie: string
  extraHeaders: Record<string, string>
}

export interface DiagnoseOptions {
  writeLine?: (line: string) => void
  skipOt?: boolean
  projectId?: string
}

export interface DiagnoseResult {
  ok: boolean
  steps: Array<{ name: string; status: 'ok' | 'fail' | 'warn'; detail?: string }>
}

/**
 * Stepped connectivity / auth / OT probe. Each step runs independently; a
 * failure in one is logged but the next steps still run when they don't
 * structurally depend on it.
 */
export async function runDiagnose(
  cfg: DiagnoseConfig,
  options: DiagnoseOptions = {},
): Promise<DiagnoseResult> {
  const writeLine = options.writeLine ?? ((s: string) => stderr.write(s + '\n'))
  const steps: DiagnoseResult['steps'] = []
  let ok = true

  // Step 1: config
  steps.push({ name: 'config', status: 'ok', detail: `URL ${cfg.url}` })
  writeLine(`✓ config — URL ${cfg.url}`)

  // Step 2: REST handshake — GET /project, capture CF headers + scrape CSRF
  let csrfToken: string | null = null
  let cfDetected = false
  try {
    const headers = new Headers({ Cookie: cfg.sessionCookie })
    for (const [k, v] of Object.entries(cfg.extraHeaders)) headers.set(k, v)
    const res = await fetch(new URL('/project', cfg.url + '/').toString(), {
      method: 'GET', headers, redirect: 'manual',
    })
    cfDetected = res.headers.has('cf-ray') || res.headers.has('cf-mitigated')
    if (res.status === 302 && (res.headers.get('location') ?? '').includes('/login')) {
      throw new AuthFailedError('Session redirected to /login (cookie expired)')
    }
    if (!res.ok) {
      throw new OverleafError('OVERLEAF_GENERIC', `GET /project returned ${res.status}`)
    }
    const html = await res.text()
    const m = html.match(/<meta\s+name="ol-csrfToken"\s+content="([^"]+)"/)
    if (!m) throw new OverleafError('OVERLEAF_GENERIC', 'CSRF meta not found')
    csrfToken = m[1]!
    steps.push({ name: 'REST handshake', status: 'ok' })
    writeLine('✓ REST handshake — cookie valid, CSRF scraped')
  } catch (err) {
    ok = false
    const msg = err instanceof OverleafError ? `${err.code}: ${err.message}` : String((err as Error).message ?? err)
    steps.push({ name: 'REST handshake', status: 'fail', detail: msg })
    writeLine(`✗ REST handshake — ${msg}`)
    return { ok, steps } // Subsequent steps require a session
  }

  // Step 3: Reverse-proxy hint
  if (cfDetected && Object.keys(cfg.extraHeaders).length === 0) {
    steps.push({
      name: 'reverse-proxy',
      status: 'warn',
      detail: 'CF-Access headers detected on /project response but OVERLEAF_EXTRA_HEADERS is empty; OT handshake may fail',
    })
    writeLine('⚠ reverse-proxy — CF detected but no extra headers configured')
  } else if (cfDetected) {
    writeLine('✓ reverse-proxy — CF detected, extraHeaders configured')
  }

  // Step 4: project listing
  let projectId: string | undefined = options.projectId
  try {
    const http = new OverleafHttp({ url: cfg.url, sessionCookie: cfg.sessionCookie, csrfToken: csrfToken ?? undefined, extraHeaders: cfg.extraHeaders })
    const rest = new OverleafRest(http)
    const projects = await rest.listProjects()
    steps.push({ name: 'project listing', status: 'ok', detail: `${projects.length} project(s)` })
    writeLine(`✓ project listing — ${projects.length} project(s) accessible`)
    projectId = projectId ?? projects[0]?.id
  } catch (err) {
    ok = false
    const msg = err instanceof OverleafError ? `${err.code}: ${err.message}` : String((err as Error).message ?? err)
    steps.push({ name: 'project listing', status: 'fail', detail: msg })
    writeLine(`✗ project listing — ${msg}`)
  }

  // Step 5: OT handshake
  if (!options.skipOt && projectId) {
    let engine: OtEngine | undefined
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    try {
      const sticky = await fetchStickyCookies(cfg)
      if (sticky) writeLine(`✓ load balancer — stickiness cookie ${sticky.split('=')[0]} obtained`)
      const sock = new OverleafSocket({ url: cfg.url, projectId, sessionCookie: sticky ? `${cfg.sessionCookie}; ${sticky}` : cfg.sessionCookie, extraHeaders: cfg.extraHeaders })
      engine = new OtEngine({ socket: sock, projectId })
      await Promise.race([
        engine.connect(),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new OverleafError('OVERLEAF_GENERIC', 'OT handshake timeout 8s')),
            8000,
          )
        }),
      ])
      steps.push({ name: 'OT handshake', status: 'ok', detail: `publicId ${engine.publicId}` })
      writeLine(`✓ OT handshake — publicId ${engine.publicId}`)
    } catch (err) {
      ok = false
      const msg = err instanceof OverleafError ? `${err.code}: ${err.message}` : String((err as Error).message ?? err)
      steps.push({ name: 'OT handshake', status: 'fail', detail: msg })
      writeLine(`✗ OT handshake — ${msg}`)
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (engine) {
        try { engine.disconnect() } catch { /* engine may have failed to start */ }
      }
    }
  }

  return { ok, steps }
}

async function main() {
  const [, , cmd, ...rest] = process.argv

  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    output.write(HELP)
    return
  }

  if (cmd === 'login') {
    await runLogin(rest)
    return
  }

  if (cmd === 'skills') {
    if (rest[0] === 'install') {
      for (const dest of installSkills(flagValue(rest, '--target'))) output.write(`installed ${dest}\n`)
      return
    }
    for (const s of listSkills()) output.write(`${s.name}\t${s.description}\n`)
    return
  }

  if (cmd === 'hosts') {
    const { hosts, defaultHost } = loadHosts()
    for (const h of hosts) output.write(`${h.name}\t${h.url}${h.name === defaultHost ? '\t(default)' : ''}\n`)
    return
  }

  if (cmd === 'ls') {
    const cfg = loadConfig({ host: flagValue(rest, '--host') })
    const csrfToken = await validateCookie({
      url: cfg.url,
      sessionCookie: cfg.sessionCookie,
      extraHeaders: cfg.extraHeaders,
    })
    const ctx = buildContext({ ...cfg, csrfToken })
    const projects = await ctx.rest.listProjects()
    for (const p of projects) {
      output.write(`${p.id}\t${p.name}\t${p.lastUpdated}\n`)
    }
    return
  }

  if (cmd === 'diagnose') {
    const cfg = loadConfig({ host: flagValue(rest, '--host') })
    const projectId = rest.find((a) => a === '--project-id') != null
      ? rest[rest.indexOf('--project-id') + 1]
      : undefined
    const result = await runDiagnose(cfg, { projectId })
    process.exit(result.ok ? 0 : 2)
  }

  // Default: MCP stdio server. Hosts are loaded and authenticated on first
  // use, not here (see HostRegistry).
  await runMcpServer(new HostRegistry())
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

interface LoginArgs {
  browser: boolean
  name?: string
  makeDefault: boolean
  url?: string
  email?: string
  cookie?: string
  headers: string[]
}

function parseLoginArgs(argv: string[]): LoginArgs {
  const args: LoginArgs = { headers: [], makeDefault: false, browser: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--url') args.url = argv[++i]
    else if (a === '--name') args.name = argv[++i]
    else if (a === '--default') args.makeDefault = true
    else if (a === '--browser') args.browser = true
    else if (a === '--email') args.email = argv[++i]
    else if (a === '--cookie') args.cookie = argv[++i]
    else if (a === '--header') args.headers.push(argv[++i]!)
  }
  return args
}

async function runLogin(argv: string[]) {
  const args = parseLoginArgs(argv)
  const rl = createInterface({ input, output })

  const url = args.url ?? (await rl.question('Overleaf URL: ')).trim()
  if (!/^https?:\/\//i.test(url)) {
    throw new InvalidConfigError(
      `URL must start with http:// or https:// (got: ${url})`,
    )
  }
  const extraHeaders: Record<string, string> = {}
  for (const h of args.headers) {
    const eq = h.indexOf('=')
    if (eq < 0) throw new Error(`--header must be KEY=VALUE, got: ${h}`)
    extraHeaders[h.slice(0, eq)] = h.slice(eq + 1)
  }

  let sessionCookie: string
  const pasteCookie = async (pasted: string) =>
    (await resolvePastedCookie({ url, pasted, extraHeaders })).sessionCookie
  const viaBrowser = async () =>
    (await browserLogin({ url, extraHeaders, onStatus: (m) => stderr.write(`${m}\n`) })).sessionCookie
  if (args.cookie) {
    sessionCookie = await pasteCookie(args.cookie)
  } else if (args.browser) {
    sessionCookie = await viaBrowser()
  } else {
    const useCookie = (
      await rl.question('Auth method? [b]rowser window (recommended) / [c]ookie paste / [p]assword login: ')
    )
      .trim()
      .toLowerCase()
    if (useCookie === '' || useCookie.startsWith('b')) {
      sessionCookie = await viaBrowser()
    } else if (useCookie.startsWith('c')) {
      sessionCookie = await pasteCookie(
        await rl.question('Paste the session cookie (overleaf_session2 / overleaf.sid; value or name=value): '),
      )
    } else {
      const email = args.email ?? (await rl.question('Email: ')).trim()
      const password = await rl.question('Password: ')
      const id = await passportLogin({ url, email, password, extraHeaders })
      sessionCookie = id.sessionCookie
      stderr.write('✓ Login successful\n')
    }
  }

  // Verify and persist
  await validateCookie({ url, sessionCookie, extraHeaders })
  stderr.write(`✓ Cookie valid; CSRF token scraped\n`)

  const name = args.name ?? hostNameForUrl(url)
  const saved = saveHost({ name, url, sessionCookie, extraHeaders }, { makeDefault: args.makeDefault })
  stderr.write(`✓ Saved host "${name}"${saved.isDefault ? ' (default)' : ''} to ${saved.path}\n`)
  rl.close()
}

// Resolve symlinks on both sides — npm's bin shim and OS-level symlinks
// (macOS /tmp → /private/tmp, npm bin/ links) make a literal string compare
// of import.meta.url vs argv[1] flaky.
const invokedAsScript = (() => {
  const argv1 = process.argv[1]
  if (!argv1) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href
  } catch {
    return import.meta.url === pathToFileURL(argv1).href
  }
})()

if (invokedAsScript) {
  main().catch((err: unknown) => {
    if (err instanceof OverleafError) {
      stderr.write(`error: ${err.code}: ${err.message}\n`)
      process.exit(2)
    }
    stderr.write(`error: ${String((err as Error).message ?? err)}\n`)
    process.exit(1)
  })
}
