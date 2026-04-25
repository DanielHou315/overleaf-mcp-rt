import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { OverleafHttp } from '../overleaf/http.js'
import { OverleafRest } from '../overleaf/rest.js'
import { ProjectCache } from '../overleaf/cache.js'
import { parseProjectZip } from '../overleaf/zip.js'
import { ProjectTree } from '../overleaf/tree.js'
import { registerAllTools } from './tools/index.js'

export interface ServerContext {
  http: OverleafHttp
  rest: OverleafRest
  cache: ProjectCache
}

export interface ContextOptions {
  url: string
  sessionCookie: string
  csrfToken: string
  extraHeaders: Record<string, string>
  debug: boolean
  cacheTtlMs?: number
}

export function buildContext(opts: ContextOptions): ServerContext {
  const http = new OverleafHttp({
    url: opts.url,
    sessionCookie: opts.sessionCookie,
    csrfToken: opts.csrfToken,
    extraHeaders: opts.extraHeaders,
  })
  const rest = new OverleafRest(http)
  const cache = new ProjectCache(
    async (projectId: string) => {
      const bytes = await rest.downloadProjectZip(projectId)
      const entries = await parseProjectZip(bytes)
      return new ProjectTree(entries)
    },
    { ttlMs: opts.cacheTtlMs ?? 60_000 },
  )
  return { http, rest, cache }
}

export async function runMcpServer(ctx: ServerContext) {
  const server = new Server(
    { name: 'overleaf-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )
  registerAllTools(server, ctx)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
