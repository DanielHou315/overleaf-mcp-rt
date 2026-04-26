import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { ServerContext } from '../server.js'
import { handleListProjects, handleGetProjectTree } from './projects.js'
import { handleReadDoc, handleReadFile, handleWriteDoc } from './docs.js'
import { handleCompile, handleReadCompileLog, handleDownloadPdf } from './compile.js'
import { OverleafError } from '../../errors.js'

const TOOL_DEFINITIONS = [
  {
    name: 'list_projects',
    description: 'List Overleaf projects accessible to the configured account.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_project_tree',
    description: 'Return the file/folder tree of a project.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
  {
    name: 'read_doc',
    description: 'Read a text document by path within a project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['projectId', 'path'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a binary file by path within a project (returned base64).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['projectId', 'path'],
    },
  },
  {
    name: 'write_doc',
    description: 'Replace a text doc by path within a project. Edits flow as live OT ops; no "file changed externally" toast.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['projectId', 'path', 'content'],
    },
  },
  {
    name: 'compile',
    description: 'Trigger a LaTeX compile and return output URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        draft: { type: 'boolean' },
        stopOnFirstError: { type: 'boolean' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'read_compile_log',
    description: 'Compile and return the output.log contents.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
  {
    name: 'download_pdf',
    description: 'Compile and return the output.pdf bytes (base64).',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
] as const

export function registerAllTools(server: Server, ctx: ServerContext) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((t) => ({ ...t })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params
    try {
      switch (name) {
        case 'list_projects':
          return wrap(await handleListProjects(ctx, args as Record<string, never>))
        case 'get_project_tree':
          return wrap(await handleGetProjectTree(ctx, args as { projectId: string }))
        case 'read_doc':
          return wrap(await handleReadDoc(ctx, args as { projectId: string; path: string }))
        case 'read_file':
          return wrap(await handleReadFile(ctx, args as { projectId: string; path: string }))
        case 'write_doc':
          return wrap(
            await handleWriteDoc(
              ctx,
              args as { projectId: string; path: string; content: string },
            ),
          )
        case 'compile':
          return wrap(
            await handleCompile(
              ctx,
              args as { projectId: string; draft?: boolean; stopOnFirstError?: boolean },
            ),
          )
        case 'read_compile_log':
          return wrap(await handleReadCompileLog(ctx, args as { projectId: string }))
        case 'download_pdf':
          return wrap(await handleDownloadPdf(ctx, args as { projectId: string }))
        default:
          throw new OverleafError('NOT_FOUND', `Unknown tool: ${name}`)
      }
    } catch (err) {
      if (err instanceof OverleafError) {
        return {
          content: [{ type: 'text', text: `${err.code}: ${err.message}` }],
          isError: true,
        }
      }
      throw err
    }
  })
}

function wrap(payload: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  }
}
