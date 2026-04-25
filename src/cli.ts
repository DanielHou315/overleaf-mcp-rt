#!/usr/bin/env node
import { writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output, stderr } from 'node:process'
import { loadConfig } from './config.js'
import { validateCookie, passportLogin } from './overleaf/auth.js'
import { buildContext, runMcpServer } from './mcp/server.js'
import { OverleafError } from './errors.js'

const HELP = `
overleaf-mcp — MCP server for Overleaf Community Edition (v0.1)

Usage:
  overleaf-mcp                Run as MCP stdio server (default).
  overleaf-mcp login          Interactive: paste a cookie or log in with email + password.
  overleaf-mcp ls             List accessible projects (smoke test).
  overleaf-mcp diagnose       Verify connectivity, auth, and (eventually) OT handshake.
  overleaf-mcp --help         Show this help.

Environment variables:
  OVERLEAF_URL                Required. e.g. https://overleaf.example.com
  OVERLEAF_SESSION_COOKIE     Required (or run \`overleaf-mcp login\`).
  OVERLEAF_EXTRA_HEADERS      JSON object of extra headers (e.g. CF Access service token).
  OVERLEAF_DEBUG              "1" for verbose stderr logging.
`

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

  if (cmd === 'ls' || cmd === 'diagnose') {
    const cfg = loadConfig()
    const csrfToken = await validateCookie({
      url: cfg.url,
      sessionCookie: cfg.sessionCookie,
      extraHeaders: cfg.extraHeaders,
    })
    const ctx = buildContext({ ...cfg, csrfToken })
    if (cmd === 'ls') {
      const projects = await ctx.rest.listProjects()
      for (const p of projects) {
        output.write(`${p.id}\t${p.name}\t${p.lastUpdated}\n`)
      }
    } else {
      stderr.write(`✓ Connected to ${cfg.url}\n`)
      stderr.write(`✓ Auth (cookie + CSRF) valid\n`)
      const projects = await ctx.rest.listProjects()
      stderr.write(`✓ ${projects.length} project(s) accessible\n`)
    }
    return
  }

  // Default: MCP stdio server
  const cfg = loadConfig()
  const csrfToken = await validateCookie({
    url: cfg.url,
    sessionCookie: cfg.sessionCookie,
    extraHeaders: cfg.extraHeaders,
  })
  const ctx = buildContext({ ...cfg, csrfToken })
  await runMcpServer(ctx)
}

interface LoginArgs {
  url?: string
  email?: string
  cookie?: string
  headers: string[]
}

function parseLoginArgs(argv: string[]): LoginArgs {
  const args: LoginArgs = { headers: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--url') args.url = argv[++i]
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
  const extraHeaders: Record<string, string> = {}
  for (const h of args.headers) {
    const eq = h.indexOf('=')
    if (eq < 0) throw new Error(`--header must be KEY=VALUE, got: ${h}`)
    extraHeaders[h.slice(0, eq)] = h.slice(eq + 1)
  }

  let sessionCookie: string
  if (args.cookie) {
    sessionCookie = args.cookie
  } else {
    const useCookie = (
      await rl.question('Auth method? [c]ookie paste / [p]assword login: ')
    )
      .trim()
      .toLowerCase()
    if (useCookie.startsWith('c')) {
      sessionCookie = (await rl.question('Paste overleaf_session2 cookie: ')).trim()
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

  const target = join(homedir(), '.config', 'overleaf-mcp', 'credentials.json')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(
    target,
    JSON.stringify({ url, session_cookie: sessionCookie, extra_headers: extraHeaders }, null, 2),
  )
  chmodSync(target, 0o600)
  stderr.write(`✓ Credentials saved to ${target}\n`)
  rl.close()
}

main().catch((err: unknown) => {
  if (err instanceof OverleafError) {
    stderr.write(`error: ${err.code}: ${err.message}\n`)
    process.exit(2)
  }
  stderr.write(`error: ${String((err as Error).message ?? err)}\n`)
  process.exit(1)
})
