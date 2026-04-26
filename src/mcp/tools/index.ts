import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { ServerContext } from '../server.js'
import { handleListProjects, handleGetProjectTree } from './projects.js'
import { handleReadDoc, handleReadFile, handleWriteDoc, handleApplyPatch } from './docs.js'
import { handleCompile, handleReadCompileLog, handleDownloadPdf } from './compile.js'
import { OverleafError } from '../../errors.js'
import type { DownloadPdfResult } from './compile.js'

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
    description: 'Read a binary file by path within a project. Returns native MCP image content for image MIMEs, text content for text MIMEs, resource for PDFs, and a {contentBase64,mimeType} envelope for other binary types.',
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
    name: 'apply_patch',
    description: 'Advanced: emit raw OT ops [{p,i?,d?}] against a doc at its current version. Each op must have exactly one of `i` (insert) or `d` (delete). For most use cases prefer write_doc.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
        ops: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              p: { type: 'integer', minimum: 0 },
              i: { type: 'string' },
              d: { type: 'string' },
            },
            required: ['p'],
          },
        },
      },
      required: ['projectId', 'path', 'ops'],
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
    description: 'Compile and return the output.pdf as an MCP resource (mimeType: application/pdf, base64-encoded blob).',
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
        case 'read_file': {
          const args2 = args as { projectId: string; path: string }
          const result = await handleReadFile(ctx, args2)
          return formatBinaryFile(result, args2.projectId, args2.path)
        }
        case 'write_doc':
          return wrap(
            await handleWriteDoc(
              ctx,
              args as { projectId: string; path: string; content: string },
            ),
          )
        case 'apply_patch':
          return wrap(
            await handleApplyPatch(
              ctx,
              args as { projectId: string; path: string; ops: Array<{ p: number; i?: string; d?: string }> },
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
        case 'download_pdf': {
          const args2 = args as { projectId: string }
          const result = await handleDownloadPdf(ctx, args2)
          return formatPdf(result, args2.projectId)
        }
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

export function formatBinaryFile(
  result: { bytes: Buffer; contentType: string },
  projectId: string,
  path: string,
): { content: Array<unknown> } {
  const base64 = result.bytes.toString('base64')
  const ct = result.contentType
  if (ct.startsWith('image/')) {
    return { content: [{ type: 'image', data: base64, mimeType: ct }] }
  }
  if (ct === 'application/pdf') {
    return {
      content: [{
        type: 'resource',
        resource: {
          uri: `overleaf://project/${projectId}/file/${encodeURIComponent(path)}`,
          mimeType: ct,
          blob: base64,
        },
      }],
    }
  }
  if (ct.startsWith('text/') || ct === 'application/json' || ct === 'application/xml') {
    return { content: [{ type: 'text', text: result.bytes.toString('utf-8') }] }
  }
  // Unknown binary fallback: keep the v0.2 envelope so callers parsing
  // contentBase64 still work.
  return wrap({ contentBase64: base64, mimeType: ct })
}

export function formatPdf(
  result: DownloadPdfResult,
  projectId: string,
): { content: Array<unknown> } {
  const base64 = result.bytes.toString('base64')
  const mimeType = result.contentType || 'application/pdf'
  return {
    content: [{
      type: 'resource',
      resource: {
        uri: `overleaf://project/${projectId}/output.pdf`,
        mimeType,
        blob: base64,
      },
    }],
  }
}
