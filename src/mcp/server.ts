import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { OverleafHttp } from '../overleaf/http.js'
import { OverleafRest } from '../overleaf/rest.js'
import { registerAllTools, type ContextSource } from './tools/index.js'
import { OverleafSocket } from '../overleaf/socket.js'
import { OtEngineRegistry, type OtEngineFactory } from '../overleaf/ot.js'
import { fetchStickyCookies, validateCookie } from '../overleaf/auth.js'
import { loadHosts, type HostConfig, type HostsConfig } from '../config.js'
import { InvalidConfigError } from '../errors.js'
import { VERSION } from '../version.js'

export interface ServerContext {
  http: OverleafHttp
  rest: OverleafRest
  ot: OtEngineRegistry
}

export interface ContextOptions {
  url: string
  sessionCookie: string
  csrfToken: string
  extraHeaders: Record<string, string>
  debug: boolean
  /** Load-balancer stickiness cookies to send on the Socket.IO connection (see fetchStickyCookies). */
  stickyCookies?: string
}

export function buildContext(opts: ContextOptions): ServerContext {
  const http = new OverleafHttp({
    url: opts.url,
    sessionCookie: opts.sessionCookie,
    csrfToken: opts.csrfToken,
    extraHeaders: opts.extraHeaders,
  })
  const rest = new OverleafRest(http)
  const socketCookie = opts.stickyCookies
    ? `${opts.sessionCookie}; ${opts.stickyCookies}`
    : opts.sessionCookie
  const otFactory: OtEngineFactory = (projectId) => {
    const makeSocket = () => new OverleafSocket({
      url: opts.url,
      projectId,
      sessionCookie: socketCookie,
      extraHeaders: opts.extraHeaders,
    })
    return {
      socket: makeSocket(),
      socketFactory: makeSocket,
    }
  }
  const ot = new OtEngineRegistry(otFactory)
  return { http, rest, ot }
}

export interface HostSummary {
  name: string
  url: string
  isDefault: boolean
  /** Whether this session has already authenticated against the host. */
  connected: boolean
}

/**
 * Every Overleaf instance this server can reach, each with its own session,
 * REST client and OT engines. Contexts are built on first use — config and
 * cookie are checked then, not at startup, because exiting before the MCP
 * handshake shows up in hosts as an unexplained "connection closed". A failed
 * attempt isn't cached and the credentials file is re-read each time, so
 * running `login` fixes (or adds) a host without restarting the server.
 */
export class HostRegistry {
  private contexts = new Map<string, { key: string; ctx: Promise<ServerContext> }>()

  constructor(
    private readonly load: () => HostsConfig = () => loadHosts(),
    private readonly connect: (host: HostConfig) => Promise<ServerContext> = connectHost,
  ) {}

  list(): HostSummary[] {
    const { hosts, defaultHost } = this.load()
    return hosts.map((h) => ({
      name: h.name,
      url: h.url,
      isDefault: h.name === defaultHost,
      connected: this.contexts.has(h.name),
    }))
  }

  /** Context for `name`, or for the default host when omitted. */
  get(name?: string): Promise<ServerContext> {
    const { hosts, defaultHost } = this.load()
    const wanted = name ?? defaultHost
    const host = hosts.find((h) => h.name === wanted) ?? hosts.find((h) => h.url === wanted)
    if (!host) {
      throw new InvalidConfigError(
        `No configured Overleaf host named "${wanted}". Configured hosts: ${hosts.map((h) => h.name).join(', ')}. ` +
          'Add one with `overleaf-mcp-rt login --name <name> --url <url>`.',
      )
    }
    // A changed cookie (fresh `login`) must not keep serving the old session.
    const key = `${host.url}\n${host.sessionCookie}\n${JSON.stringify(host.extraHeaders)}`
    const cached = this.contexts.get(host.name)
    if (cached?.key === key) return cached.ctx
    if (cached) void cached.ctx.then((c) => c.ot.closeAll()).catch(() => undefined)

    const ctx = this.connect(host).catch((err: unknown) => {
      if (this.contexts.get(host.name)?.ctx === ctx) this.contexts.delete(host.name)
      throw err
    })
    this.contexts.set(host.name, { key, ctx })
    return ctx
  }
}

async function connectHost(host: HostConfig): Promise<ServerContext> {
  const auth = { url: host.url, sessionCookie: host.sessionCookie, extraHeaders: host.extraHeaders }
  const csrfToken = await validateCookie(auth)
  const stickyCookies = await fetchStickyCookies(auth)
  return buildContext({ ...host, csrfToken, stickyCookies })
}

/** Guidance every connecting agent receives, independent of any one tool. */
export const SERVER_INSTRUCTIONS = [
  'You are editing live Overleaf projects that people may have open in their browser right now.',
  'Prefer overleaf_edit_doc (exact string replacement) over rewriting whole docs; it composes with what collaborators are typing.',
  'Tool results may end with an <external-changes> block: a diff of what collaborators changed since your last call. Read it — it replaces re-reading the doc.',
  'Comments (overleaf_add_comment / overleaf_reply_comment) are posted through the logged-in account, usually the human\'s own. They must end with "Co-authored by <your agent name>": pass agentName and the server adds the line. Only set omitSignature when the user has explicitly said not to sign comments.',
].join('\n')

export async function runMcpServer(source: ContextSource) {
  const server = new Server(
    { name: 'overleaf-mcp-rt', version: VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  )
  registerAllTools(server, source)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
