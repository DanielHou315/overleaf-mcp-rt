import { randomBytes } from 'node:crypto'
import type { ServerContext } from '../server.js'
import { EditAmbiguousError, EditNoMatchError, NotFoundError, OverleafError } from '../../errors.js'
import type { CommentThread } from '../../overleaf/rest.js'
import { closestRegion, findMatches, lineOf } from './match.js'

/**
 * Comments are posted through the logged-in account — on overleaf.com that is
 * usually the human's own — so without a signature a collaborator cannot tell
 * an agent's remark from the account owner's. The signature is therefore added
 * by the server, not left to the model's memory.
 */
export function signComment(content: string, agentName: string, omitSignature?: boolean): string {
  const body = content.trimEnd()
  if (omitSignature) return body
  const name = agentName.trim()
  if (!name) {
    throw new OverleafError('OVERLEAF_GENERIC', 'agentName is required: it signs the comment as "Co-authored by <agentName>"')
  }
  const signature = `Co-authored by ${name}`
  return body.toLowerCase().endsWith(signature.toLowerCase()) ? body : `${body}\n\n${signature}`
}

/** Same shape the Overleaf editor generates for a new thread: a 12-byte ObjectId-style hex id. */
function newThreadId(): string {
  const time = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0')
  return time + randomBytes(8).toString('hex')
}

function resolveDoc(engine: Awaited<ReturnType<ServerContext['ot']['get']>>, projectId: string, path: string): string {
  const docId = engine.pathToDocId(path)
  if (docId === null) throw new NotFoundError(`No doc at ${path} in project ${projectId}`)
  return docId
}

function userName(u?: { first_name?: string; last_name?: string; email?: string }): string {
  return [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim() || u?.email || 'unknown'
}

export interface CommentView {
  threadId: string
  path: string
  line: number
  /** The text the comment is attached to. */
  anchorText: string
  resolved: boolean
  messages: Array<{ author: string; content: string; at: string }>
}

export async function handleListComments(
  ctx: ServerContext,
  input: { projectId: string; path: string; includeResolved?: boolean },
): Promise<{ comments: CommentView[] }> {
  const threads = await ctx.rest.getThreads(input.projectId) // fails fast where comments don't exist
  const engine = await ctx.ot.get(input.projectId)
  const baseline = await engine.openDoc(resolveDoc(engine, input.projectId, input.path))
  const comments = baseline.comments
    .map((anchor): CommentView | null => {
      const thread: CommentThread | undefined = threads[anchor.threadId]
      if (!thread) return null
      return {
        threadId: anchor.threadId,
        path: input.path,
        line: lineOf(baseline.text, anchor.p),
        anchorText: anchor.text,
        resolved: thread.resolved === true,
        messages: thread.messages.map((m) => ({
          author: userName(m.user),
          content: m.content,
          at: new Date(m.timestamp).toISOString(),
        })),
      }
    })
    .filter((c): c is CommentView => c !== null && (input.includeResolved === true || !c.resolved))
    .sort((a, b) => a.line - b.line)
  return { comments }
}

export async function handleAddComment(
  ctx: ServerContext,
  input: { projectId: string; path: string; anchorText: string; content: string; agentName: string; omitSignature?: boolean },
): Promise<{ ok: true; threadId: string; line: number; anchorText: string; posted: string }> {
  const posted = signComment(input.content, input.agentName, input.omitSignature)
  const engine = await ctx.ot.get(input.projectId)
  const docId = resolveDoc(engine, input.projectId, input.path)
  const locate = (text: string) => {
    const { spans } = findMatches(text, input.anchorText)
    if (spans.length === 0) {
      const near = closestRegion(text, input.anchorText)
      throw new EditNoMatchError(
        `anchorText not found in ${input.path}` + (near ? `. Closest text is at lines ${near.startLine}-${near.endLine}.` : ''),
        near ? { closest: near } : {},
      )
    }
    if (spans.length > 1) {
      const lines = spans.map((s) => lineOf(text, s.start))
      throw new EditAmbiguousError(
        `anchorText matches ${spans.length} places in ${input.path} (lines ${lines.join(', ')}); include more surrounding text`,
        { lines },
      )
    }
    return spans[0]!
  }
  // Check the anchor before creating a thread, so a bad anchor leaves nothing behind…
  locate((await engine.openDoc(docId)).text)
  // …then follow the editor's order: create the thread, then attach it to the text.
  const threadId = newThreadId()
  await ctx.rest.postThreadMessage(input.projectId, threadId, posted)
  const anchor = await engine.addCommentAnchor(docId, threadId, locate)
  const text = engine.getBaseline(docId)?.text ?? ''
  return { ok: true, threadId, line: lineOf(text, anchor.p), anchorText: anchor.text, posted }
}

export async function handleReplyComment(
  ctx: ServerContext,
  input: { projectId: string; threadId: string; content: string; agentName: string; omitSignature?: boolean },
): Promise<{ ok: true; threadId: string; posted: string }> {
  const posted = signComment(input.content, input.agentName, input.omitSignature)
  const threads = await ctx.rest.getThreads(input.projectId)
  if (!threads[input.threadId]) {
    // Posting to an unknown id would silently create a thread attached to nothing.
    throw new NotFoundError(`No comment thread ${input.threadId} in project ${input.projectId}`)
  }
  await ctx.rest.postThreadMessage(input.projectId, input.threadId, posted)
  return { ok: true, threadId: input.threadId, posted }
}

export async function handleResolveComment(
  ctx: ServerContext,
  input: { projectId: string; path: string; threadId: string; resolved?: boolean },
): Promise<{ ok: true; threadId: string; resolved: boolean }> {
  const engine = await ctx.ot.get(input.projectId)
  const docId = resolveDoc(engine, input.projectId, input.path)
  const resolved = input.resolved !== false
  await ctx.rest.setThreadResolved(input.projectId, docId, input.threadId, resolved)
  return { ok: true, threadId: input.threadId, resolved }
}
