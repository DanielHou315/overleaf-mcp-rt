import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { ServerContext } from '../server.js'
import { handleListProjects, handleGetProjectTree } from './projects.js'
import { handleReadDoc, handleReadFile, handleWriteDoc, handleApplyPatch } from './docs.js'
import { handleEditDoc } from './edit.js'
import { handleReadDocRange } from './range.js'
import { handleCompile, handleReadCompileLog, handleDownloadPdf } from './compile.js'
import {
  handleCreateDoc,
  handleCreateFolder,
  handleUploadFile,
  handleRename,
  handleMove,
  handleDeleteEntity,
} from './tree.js'
import { OverleafError } from '../../errors.js'
import type { DownloadPdfResult } from './compile.js'
import { effectiveMime } from './mime.js'

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
    name: 'read_doc_range',
    description: 'Read a substring of a text doc by line range (startLine/endLine, 1-indexed inclusive) or by offset/length. Returns totalLines and totalChars for context.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
        startOffset: { type: 'integer', minimum: 0 },
        length: { type: 'integer', minimum: 0 },
      },
      required: ['projectId', 'path'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a binary file by path within a project. Default (as=auto): returns native MCP image content for image MIMEs, text content for text MIMEs, resource for PDFs, and a {contentBase64,mimeType} envelope for other binary types. Pass as="base64" to force the {contentBase64,mimeType} envelope for all types — useful when you need programmatic access to the bytes (e.g. to copy a binary between paths via upload_file).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
        as: { type: 'string', enum: ['auto', 'base64'] },
      },
      required: ['projectId', 'path'],
    },
  },
  {
    name: 'write_doc',
    description: 'Replace a text doc by path. Edits flow as live OT ops; collaborators see fine-grained changes, not a "file changed externally" toast. Returns a summary {versionBefore, versionAfter, charsBefore, charsAfter, charsDelta, opsApplied}. For surgical edits prefer edit_doc.',
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
    description: 'Advanced: emit raw OT ops [{p,i?,d?}] against a doc. Each op must have exactly one of `i` (insert) or `d` (delete); a `d`-string that does not match the doc at p surfaces as OT_DELETE_MISMATCH. For most use cases prefer edit_doc, which resolves anchors → OT positions for you. apply_patch is here for callers that already have positions computed.',
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
    name: 'edit_doc',
    description: 'High-level text edits with anchor-based find/replace, insert before/after, line-range replace, or raw OT ops. All edits in one call apply atomically (all or none). Pass dryRun=true to preview without applying. For most edits prefer this over apply_patch — the server resolves anchors → OT positions for you.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
        edits: {
          type: 'array',
          minItems: 1,
          items: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  mode: { const: 'replace' },
                  find: { type: 'string' },
                  replace: { type: 'string' },
                  occurrence: {
                    oneOf: [
                      { type: 'string', enum: ['unique', 'first', 'all'] },
                      { type: 'integer', minimum: 0 },
                    ],
                  },
                },
                required: ['mode', 'find', 'replace'],
              },
              {
                type: 'object',
                properties: {
                  mode: { const: 'insert_before' },
                  find: { type: 'string' },
                  text: { type: 'string' },
                },
                required: ['mode', 'find', 'text'],
              },
              {
                type: 'object',
                properties: {
                  mode: { const: 'insert_after' },
                  find: { type: 'string' },
                  text: { type: 'string' },
                },
                required: ['mode', 'find', 'text'],
              },
              {
                type: 'object',
                properties: {
                  mode: { const: 'replace_lines' },
                  startLine: { type: 'integer', minimum: 1 },
                  endLine: { type: 'integer', minimum: 1 },
                  text: { type: 'string' },
                },
                required: ['mode', 'startLine', 'endLine', 'text'],
              },
              {
                type: 'object',
                properties: {
                  mode: { const: 'raw_ops' },
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
                required: ['mode', 'ops'],
              },
              {
                type: 'object',
                properties: {
                  mode: { const: 'unified_diff' },
                  diff: { type: 'string' },
                },
                required: ['mode', 'diff'],
              },
            ],
          },
        },
        dryRun: { type: 'boolean' },
      },
      required: ['projectId', 'path', 'edits'],
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
  {
    name: 'create_doc',
    description: 'Create a new text doc under parentPath. Optional content is OT-written after creation. Use parentPath="" for the project root.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        parentPath: { type: 'string' },
        name: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['projectId', 'parentPath', 'name'],
    },
  },
  {
    name: 'create_folder',
    description: 'Create a new folder under parentPath. Use parentPath="" for the project root.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        parentPath: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['projectId', 'parentPath', 'name'],
    },
  },
  {
    name: 'upload_file',
    description: 'Upload a binary file (base64) under parentPath. mimeType is optional — when omitted, inferred from the path extension (png/jpg/pdf/etc); fallback is application/octet-stream. Overleaf may auto-promote text MIME types to docs.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        parentPath: { type: 'string' },
        name: { type: 'string' },
        contentBase64: { type: 'string' },
        mimeType: { type: 'string' },
      },
      required: ['projectId', 'parentPath', 'name', 'contentBase64'],
    },
  },
  {
    name: 'rename',
    description: 'Rename a doc/file/folder at path to newName.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
        newName: { type: 'string' },
      },
      required: ['projectId', 'path', 'newName'],
    },
  },
  {
    name: 'move',
    description: 'Move a doc/file/folder at path under newParentPath. Use newParentPath="" for the project root.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
        newParentPath: { type: 'string' },
      },
      required: ['projectId', 'path', 'newParentPath'],
    },
  },
  {
    name: 'delete_entity',
    description: 'Delete the doc/file/folder at path.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['projectId', 'path'],
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
        case 'read_doc_range':
          return wrap(
            await handleReadDocRange(
              ctx,
              args as { projectId: string; path: string; startLine?: number; endLine?: number; startOffset?: number; length?: number },
            ),
          )
        case 'read_file': {
          const args2 = args as { projectId: string; path: string; as?: 'auto' | 'base64' }
          const result = await handleReadFile(ctx, args2)
          return formatBinaryFile(result, args2.projectId, args2.path, args2.as ?? 'auto')
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
        case 'edit_doc':
          return wrap(
            await handleEditDoc(
              ctx,
              args as unknown as Parameters<typeof handleEditDoc>[1],
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
        case 'create_doc':
          return wrap(
            await handleCreateDoc(
              ctx,
              args as { projectId: string; parentPath: string; name: string; content?: string },
            ),
          )
        case 'create_folder':
          return wrap(
            await handleCreateFolder(
              ctx,
              args as { projectId: string; parentPath: string; name: string },
            ),
          )
        case 'upload_file':
          return wrap(
            await handleUploadFile(
              ctx,
              args as {
                projectId: string
                parentPath: string
                name: string
                contentBase64: string
                mimeType?: string
              },
            ),
          )
        case 'rename':
          return wrap(
            await handleRename(
              ctx,
              args as { projectId: string; path: string; newName: string },
            ),
          )
        case 'move':
          return wrap(
            await handleMove(
              ctx,
              args as { projectId: string; path: string; newParentPath: string },
            ),
          )
        case 'delete_entity':
          return wrap(
            await handleDeleteEntity(
              ctx,
              args as { projectId: string; path: string },
            ),
          )
        default:
          throw new OverleafError('NOT_FOUND', `Unknown tool: ${name}`)
      }
    } catch (err) {
      if (err instanceof OverleafError) {
        return {
          content: [{ type: 'text', text: JSON.stringify(err.toEnvelope(), null, 2) }],
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
  as: 'auto' | 'base64' = 'auto',
): { content: Array<unknown> } {
  const base64 = result.bytes.toString('base64')
  const ct = effectiveMime(result.contentType, path)
  if (as === 'base64') {
    return wrap({ contentBase64: base64, mimeType: ct })
  }
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
