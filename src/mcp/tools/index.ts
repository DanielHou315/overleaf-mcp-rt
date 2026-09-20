import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { ServerContext } from '../server.js'
import { handleListProjects, handleGetProjectTree } from './projects.js'
import { handleReadDoc, handleReadFile, handleWriteDoc } from './docs.js'
import { handleEditDoc } from './edit.js'
import { handleAddComment, handleListComments, handleReplyComment, handleResolveComment } from './comments.js'
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
import { formatExternalChanges } from '../changes.js'

// All MCP tool names are prefixed `overleaf_*` so they remain unambiguous in
// hosts that don't auto-namespace by server name (Cursor, Continue, custom
// stdio integrations, etc.). Hosts that do namespace (`mcp__<server>__<tool>`)
// apply theirs on top — `overleaf_edit_doc` becomes
// `mcp__overleaf__overleaf_edit_doc`. Cosmetic redundancy there is the cost of
// robust naming elsewhere.
const TOOL_DEFINITIONS = [
  {
    name: 'overleaf_list_projects',
    description: 'List Overleaf projects accessible to the configured account.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'overleaf_get_project_tree',
    description: 'Return the file/folder tree of an Overleaf project.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
  {
    name: 'overleaf_read_doc',
    description: 'Read a text document by path within an Overleaf project. The text is live: it reflects collaborators\' keystrokes up to this instant. After you have read a doc, every later tool result for the project carries an <external-changes> block with a diff whenever someone else edits it, so you rarely need to re-read.',
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
    name: 'overleaf_read_doc_range',
    description: 'Read a substring of an Overleaf doc by line range (startLine/endLine, 1-indexed inclusive) or by offset/length. Returns totalLines and totalChars for context. Use to verify a small region after an edit instead of re-fetching the whole doc.',
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
    name: 'overleaf_read_file',
    description: 'Read a binary file by path within an Overleaf project. Default (as=auto): returns native MCP image content for image MIMEs, text content for text MIMEs, resource for PDFs, and a {contentBase64,mimeType} envelope for other binary types. Pass as="base64" to force the {contentBase64,mimeType} envelope for all types — useful when you need programmatic access to the bytes (e.g. to copy a binary between paths via overleaf_upload_file).',
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
    name: 'overleaf_write_doc',
    description: 'Replace the entire contents of an Overleaf text doc. Prefer overleaf_edit_doc for anything short of a rewrite: a whole-doc replace is built from what you last read, so it is refused (DOC_CHANGED_EXTERNALLY) if a collaborator edited the doc since, and (DOC_NOT_READ) if the doc has content you have not read this session. Pass overwrite=true to skip both checks. Only the differing characters are sent, as live OT ops. Returns {versionBefore, versionAfter, charsBefore, charsAfter, charsDelta, opsApplied}.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
        content: { type: 'string' },
        overwrite: { type: 'boolean', description: 'Replace the doc even if it is unread or a collaborator changed it since your last read.' },
      },
      required: ['projectId', 'path', 'content'],
    },
  },
  {
    name: 'overleaf_edit_doc',
    description: 'Edit an Overleaf doc by exact string replacement — the recommended way to change text. Each edit replaces old_string with new_string. old_string must identify exactly one place in the doc (include enough surrounding text to make it unique) unless replace_all is true. Edits apply in order, each to the result of the previous, and atomically: if any edit fails, nothing is changed. Matching is against the live doc, so edits compose with what collaborators are typing elsewhere in the file; if someone changed the text you targeted, the call fails with EDIT_NO_MATCH and shows their change. If old_string is not found verbatim, a match that differs only in whitespace/indentation is accepted when unambiguous. To insert, use an anchor as old_string and repeat it in new_string; to delete, pass an empty new_string. Returns a unified diff of the change. dryRun=true previews without applying. (Legacy v1.1 edits with a "mode" field — replace, insert_before, insert_after, replace_lines, unified_diff, raw_ops — are still accepted.)',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
        edits: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: 'Text to replace, copied from the doc.' },
              new_string: { type: 'string', description: 'Replacement text (must differ from old_string).' },
              replace_all: { type: 'boolean', description: 'Replace every occurrence of old_string (default false).' },
            },
          },
        },
        dryRun: { type: 'boolean' },
      },
      required: ['projectId', 'path', 'edits'],
    },
  },
  {
    name: 'overleaf_check_changes',
    description: 'Report what collaborators changed in an Overleaf project since your last tool call: diffs for docs you have read, plus file-tree changes. The same report is appended automatically to every other tool result, so call this only to poll (e.g. after waiting for a human to finish editing).',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
  {
    name: 'overleaf_list_comments',
    description: 'List the review-panel comment threads attached to a doc: for each, the thread id, the line and text it is anchored to, whether it is resolved, and every message with its author. Use it to find feedback a human left for you. Comments exist on overleaf.com and Server Pro; stock Community Edition has no review panel, and these tools then fail with COMMENTS_UNSUPPORTED.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
        includeResolved: { type: 'boolean', description: 'Also return resolved threads (default false).' },
      },
      required: ['projectId', 'path'],
    },
  },
  {
    name: 'overleaf_add_comment',
    description: 'Attach a new review-panel comment to a span of text in a doc, without changing the text — the right tool for questions, suggestions and explanations a human should see next to the passage, as opposed to editing it. anchorText must match exactly one place in the doc (same matching rules as overleaf_edit_doc old_string). SIGNATURE RULE: comments are posted through the logged-in Overleaf account, which is usually the human\'s own, so readers cannot otherwise tell your words from theirs. Every comment must therefore end with "Co-authored by <agent name>". Pass the name you go by as an assistant in agentName and the server appends that line for you — do not write it yourself. Set omitSignature=true ONLY if the user has explicitly told you not to sign comments.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
        anchorText: { type: 'string', description: 'The exact text to attach the comment to, copied from the doc.' },
        content: { type: 'string', description: 'The comment body, without a signature.' },
        agentName: { type: 'string', description: 'The name you, the assistant, go by. Used for the "Co-authored by <agentName>" line.' },
        omitSignature: { type: 'boolean', description: 'Skip the signature. Only when the user explicitly asked for unsigned comments.' },
      },
      required: ['projectId', 'path', 'anchorText', 'content', 'agentName'],
    },
  },
  {
    name: 'overleaf_reply_comment',
    description: 'Reply in an existing comment thread (thread ids come from overleaf_list_comments). The same SIGNATURE RULE as overleaf_add_comment applies: pass agentName and the server ends the reply with "Co-authored by <agentName>"; set omitSignature=true only if the user explicitly asked for unsigned comments.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        threadId: { type: 'string' },
        content: { type: 'string', description: 'The reply body, without a signature.' },
        agentName: { type: 'string', description: 'The name you, the assistant, go by.' },
        omitSignature: { type: 'boolean', description: 'Skip the signature. Only when the user explicitly asked for unsigned comments.' },
      },
      required: ['projectId', 'threadId', 'content', 'agentName'],
    },
  },
  {
    name: 'overleaf_resolve_comment',
    description: 'Mark a comment thread resolved (or reopen it with resolved=false). Resolve a thread only once what it asked for is done — and prefer leaving that call to the human who opened it unless they asked you to tidy up.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string', description: 'The doc the thread is attached to.' },
        threadId: { type: 'string' },
        resolved: { type: 'boolean', description: 'true (default) to resolve, false to reopen.' },
      },
      required: ['projectId', 'path', 'threadId'],
    },
  },
  {
    name: 'overleaf_compile',
    description: 'Trigger a LaTeX compile of an Overleaf project and return output URLs.',
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
    name: 'overleaf_read_compile_log',
    description: 'Compile an Overleaf project and return the output.log contents.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
  {
    name: 'overleaf_download_pdf',
    description: 'Compile an Overleaf project and return the output.pdf as an MCP resource (mimeType: application/pdf, base64-encoded blob).',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
  {
    name: 'overleaf_create_doc',
    description: 'Create a new text doc in an Overleaf project under parentPath. Optional content is OT-written after creation. Use parentPath="" for the project root.',
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
    name: 'overleaf_create_folder',
    description: 'Create a new folder in an Overleaf project under parentPath. Use parentPath="" for the project root.',
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
    name: 'overleaf_upload_file',
    description: 'Upload a binary file (base64) to an Overleaf project under parentPath. mimeType is optional — when omitted, inferred from the path extension (png/jpg/pdf/etc); fallback is application/octet-stream. Overleaf may auto-promote text MIME types to docs.',
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
    name: 'overleaf_rename',
    description: 'Rename an Overleaf doc/file/folder at path to newName.',
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
    name: 'overleaf_move',
    description: 'Move an Overleaf doc/file/folder at path under newParentPath. Use newParentPath="" for the project root.',
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
    name: 'overleaf_delete_entity',
    description: 'Delete the doc/file/folder at path within an Overleaf project.',
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

/**
 * A ready context, or a function that builds one on demand. The CLI passes
 * the latter so an expired cookie surfaces as a tool error the agent can read
 * (and that a fresh `login` fixes without restarting) rather than as a server
 * that dies before the MCP handshake.
 */
export type ContextSource = ServerContext | (() => Promise<ServerContext>) | HostSource

/** Several Overleaf instances, selected per call by the `host` argument (see HostRegistry). */
export interface HostSource {
  get(name?: string): Promise<ServerContext>
  list(): Array<{ name: string; url: string; isDefault: boolean; connected: boolean }>
}

function isHostSource(source: ContextSource): source is HostSource {
  return typeof source === 'object' && 'list' in source && typeof source.list === 'function'
}

const HOST_PROPERTY = {
  type: 'string',
  description:
    'Which configured Overleaf instance to use (a name from overleaf_list_hosts). Omit for the default host. Project ids are only meaningful on the host they came from.',
} as const

const LIST_HOSTS_TOOL = {
  name: 'overleaf_list_hosts',
  description:
    'List the Overleaf instances this server is logged in to (e.g. a self-hosted server and overleaf.com), and which one is the default. Every other tool takes an optional `host` argument to pick one per call.',
  inputSchema: { type: 'object', properties: {}, required: [] },
} as const

export function registerAllTools(server: Server, source: ContextSource) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: isHostSource(source)
      ? [
          LIST_HOSTS_TOOL,
          ...TOOL_DEFINITIONS.map((t) => ({
            ...t,
            inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, host: HOST_PROPERTY } },
          })),
        ]
      : TOOL_DEFINITIONS.map((t) => ({ ...t })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params
    const projectId = typeof args.projectId === 'string' ? args.projectId : undefined
    let ctx: ServerContext | undefined
    try {
      if (isHostSource(source)) {
        if (name === 'overleaf_list_hosts') return wrap({ hosts: source.list() })
        ctx = await source.get(typeof args.host === 'string' ? args.host : undefined)
      } else {
        ctx = typeof source === 'function' ? await source() : source
      }
      return withExternalChanges(ctx, projectId, await dispatch(ctx, name, args))
    } catch (err) {
      if (err instanceof OverleafError) {
        return withExternalChanges(ctx, projectId, {
          content: [{ type: 'text', text: JSON.stringify(err.toEnvelope(), null, 2) }],
          isError: true,
        })
      }
      throw err
    }
  })

  async function dispatch(ctx: ServerContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'overleaf_list_projects':
        return wrap(await handleListProjects(ctx, args as Record<string, never>))
      case 'overleaf_get_project_tree':
        return wrap(await handleGetProjectTree(ctx, args as { projectId: string }))
      case 'overleaf_read_doc':
        return wrap(await handleReadDoc(ctx, args as { projectId: string; path: string }))
      case 'overleaf_read_doc_range':
        return wrap(
          await handleReadDocRange(
            ctx,
            args as { projectId: string; path: string; startLine?: number; endLine?: number; startOffset?: number; length?: number },
          ),
        )
      case 'overleaf_read_file': {
        const args2 = args as { projectId: string; path: string; as?: 'auto' | 'base64' }
        const result = await handleReadFile(ctx, args2)
        return formatBinaryFile(result, args2.projectId, args2.path, args2.as ?? 'auto')
      }
      case 'overleaf_write_doc':
        return wrap(
          await handleWriteDoc(
            ctx,
            args as { projectId: string; path: string; content: string; overwrite?: boolean },
          ),
        )
      case 'overleaf_edit_doc':
        return wrap(
          await handleEditDoc(
            ctx,
            args as unknown as Parameters<typeof handleEditDoc>[1],
          ),
        )
      case 'overleaf_check_changes':
        // Connect so tracking starts; the report itself is appended by the caller.
        await ctx.ot.get((args as { projectId: string }).projectId)
        return wrap({ ok: true })
      case 'overleaf_list_comments':
        return wrap(await handleListComments(ctx, args as unknown as Parameters<typeof handleListComments>[1]))
      case 'overleaf_add_comment':
        return wrap(await handleAddComment(ctx, args as unknown as Parameters<typeof handleAddComment>[1]))
      case 'overleaf_reply_comment':
        return wrap(await handleReplyComment(ctx, args as unknown as Parameters<typeof handleReplyComment>[1]))
      case 'overleaf_resolve_comment':
        return wrap(await handleResolveComment(ctx, args as unknown as Parameters<typeof handleResolveComment>[1]))
      case 'overleaf_compile':
        return wrap(
          await handleCompile(
            ctx,
            args as { projectId: string; draft?: boolean; stopOnFirstError?: boolean },
          ),
        )
      case 'overleaf_read_compile_log':
        return wrap(await handleReadCompileLog(ctx, args as { projectId: string }))
      case 'overleaf_download_pdf': {
        const args2 = args as { projectId: string }
        const result = await handleDownloadPdf(ctx, args2)
        return formatPdf(result, args2.projectId)
      }
      case 'overleaf_create_doc':
        return wrap(
          await handleCreateDoc(
            ctx,
            args as { projectId: string; parentPath: string; name: string; content?: string },
          ),
        )
      case 'overleaf_create_folder':
        return wrap(
          await handleCreateFolder(
            ctx,
            args as { projectId: string; parentPath: string; name: string },
          ),
        )
      case 'overleaf_upload_file':
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
      case 'overleaf_rename':
        return wrap(
          await handleRename(
            ctx,
            args as { projectId: string; path: string; newName: string },
          ),
        )
      case 'overleaf_move':
        return wrap(
          await handleMove(
            ctx,
            args as { projectId: string; path: string; newParentPath: string },
          ),
        )
      case 'overleaf_delete_entity':
        return wrap(
          await handleDeleteEntity(
            ctx,
            args as { projectId: string; path: string },
          ),
        )
      default:
        throw new OverleafError('NOT_FOUND', `Unknown tool: ${name}`)
    }
  }
}

interface ToolResult {
  // Index signature keeps this assignable to the SDK's open-ended result type.
  [key: string]: unknown
  content: Array<unknown>
  isError?: boolean
}

/**
 * Append what collaborators changed since the agent's previous call. Runs
 * for failures too: a missed old_string is usually explained by the diff.
 */
function withExternalChanges(
  ctx: ServerContext | undefined,
  projectId: string | undefined,
  result: ToolResult,
): ToolResult {
  const engine = projectId ? ctx?.ot.peek?.(projectId) : undefined
  if (!engine) return result
  const block = formatExternalChanges(engine.collectExternalChanges())
  if (!block) return result
  return { ...result, content: [...result.content, { type: 'text', text: block }] }
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
