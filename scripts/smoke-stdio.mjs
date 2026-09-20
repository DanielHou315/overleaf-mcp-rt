// Start the built server over stdio the way an MCP host does and make one call.
// Usage: npm run build && node scripts/smoke-stdio.mjs [toolName] [jsonArgs]
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const [tool = 'overleaf_list_projects', rawArgs = '{}'] = process.argv.slice(2)
const client = new Client({ name: 'smoke', version: '0' }, { capabilities: {} })
await client.connect(new StdioClientTransport({ command: 'node', args: ['dist/cli.js'] }))
const { tools } = await client.listTools()
console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`)
const res = await client.callTool({ name: tool, arguments: JSON.parse(rawArgs) })
console.log(`isError: ${res.isError === true}`)
for (const block of res.content) console.log(block.text ?? `[${block.type}]`)
await client.close()
