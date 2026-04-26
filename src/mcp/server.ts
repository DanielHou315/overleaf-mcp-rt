import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { OverleafHttp } from '../overleaf/http.js'
import { OverleafRest } from '../overleaf/rest.js'
import { registerAllTools } from './tools/index.js'
import { OverleafSocket } from '../overleaf/socket.js'
import { OtEngineRegistry, type OtEngineFactory } from '../overleaf/ot.js'

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
}

export function buildContext(opts: ContextOptions): ServerContext {
  const http = new OverleafHttp({
    url: opts.url,
    sessionCookie: opts.sessionCookie,
    csrfToken: opts.csrfToken,
    extraHeaders: opts.extraHeaders,
  })
  const rest = new OverleafRest(http)
  const otFactory: OtEngineFactory = (projectId) => {
    const makeSocket = () => new OverleafSocket({
      url: opts.url,
      projectId,
      sessionCookie: opts.sessionCookie,
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

export async function runMcpServer(ctx: ServerContext) {
  const server = new Server(
    { name: 'overleaf-mcp', version: '0.2.0' },
    { capabilities: { tools: {} } },
  )
  registerAllTools(server, ctx)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
