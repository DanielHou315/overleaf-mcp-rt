// A long-lived MCP client session against the built server, driven over a
// local HTTP port. Lets you interleave agent tool calls with edits made by
// hand in the browser when testing live collaboration.
//
//   npm run build && node scripts/agent-session.mjs [port]
//   curl -s localhost:47811 -d '{"name":"overleaf_read_doc","arguments":{...}}'
//   curl -s localhost:47811/quit
import { createServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const port = Number(process.argv[2] ?? 47811)
const client = new Client({ name: 'agent-session', version: '0' }, { capabilities: {} })
await client.connect(new StdioClientTransport({ command: 'node', args: ['dist/cli.js'], stderr: 'inherit' }))

createServer(async (req, res) => {
  if (req.url === '/quit') {
    res.end('bye\n')
    await client.close()
    process.exit(0)
  }
  let body = ''
  for await (const chunk of req) body += chunk
  try {
    const { name, arguments: args } = JSON.parse(body)
    const started = Date.now()
    const result = await client.callTool({ name, arguments: args })
    const text = result.content.map((c) => c.text ?? `[${c.type}]`).join('\n')
    res.end(`${result.isError ? 'ERROR' : 'ok'} (${Date.now() - started}ms)\n${text}\n`)
  } catch (err) {
    res.statusCode = 500
    res.end(`${String(err)}\n`)
  }
}).listen(port, '127.0.0.1', () => console.log(`agent session on http://127.0.0.1:${port}`))
