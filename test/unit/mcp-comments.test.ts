import { describe, it, expect } from 'vitest'
import {
  handleAddComment, handleListComments, handleReplyComment, handleResolveComment, signComment,
} from '../../src/mcp/tools/comments.js'
import { CommentsUnsupportedError } from '../../src/errors.js'
import type { CommentThread } from '../../src/overleaf/rest.js'
import { transformOps } from '../../src/overleaf/text-ot.js'
import { makeToolHarness } from './fake-overleaf.js'

const DOC = '\\section{Intro}\nWe study widgets.\n\n\\section{Method}\nOur method is simple.\n'

/** Tool harness plus an in-memory stand-in for the review-panel thread API. */
async function harness(opts: Parameters<typeof makeToolHarness>[1] & { supported?: boolean } = {}) {
  const h = await makeToolHarness({ main: DOC }, opts)
  const threads: Record<string, CommentThread> = {}
  const calls: string[] = []
  const guard = () => {
    if (opts.supported === false) throw new CommentsUnsupportedError('no review panel')
  }
  h.ctx.rest = {
    getThreads: async () => (guard(), threads),
    postThreadMessage: async (_p: string, threadId: string, content: string) => {
      guard()
      calls.push(`post:${threadId}`)
      threads[threadId] ??= { messages: [] }
      threads[threadId]!.messages.push({
        id: `m${threads[threadId]!.messages.length}`, content, timestamp: 1_700_000_000_000,
        user: { first_name: 'Ada', last_name: 'Lovelace' },
      })
    },
    setThreadResolved: async (_p: string, docId: string, threadId: string, resolved: boolean) => {
      guard()
      calls.push(`${resolved ? 'resolve' : 'reopen'}:${docId}:${threadId}`)
      threads[threadId]!.resolved = resolved
    },
  } as never
  return { ...h, threads, calls }
}

const base = { projectId: 'p1', path: 'main.tex' }

describe('signComment', () => {
  it('ends the comment with "Co-authored by <agent>"', () => {
    expect(signComment('Is this right?  \n', 'Claude')).toBe('Is this right?\n\nCo-authored by Claude')
  })
  it('does not sign twice when the model already wrote the line', () => {
    expect(signComment('Looks good.\n\nco-authored by Claude', 'Claude')).toBe('Looks good.\n\nco-authored by Claude')
  })
  it('skips the signature only when explicitly told to, and insists on a name otherwise', () => {
    expect(signComment('Unsigned.', 'Claude', true)).toBe('Unsigned.')
    expect(() => signComment('x', '  ')).toThrow(/agentName is required/)
  })
})

describe('overleaf_add_comment', () => {
  it('creates the thread, then anchors it to the text with a comment op — and leaves the text alone', async () => {
    const h = await harness()
    const out = await handleAddComment(h.ctx, {
      ...base, anchorText: 'Our method is simple.', content: 'Can we justify "simple"?', agentName: 'Claude',
    })
    expect(out).toMatchObject({ ok: true, line: 5, anchorText: 'Our method is simple.' })
    expect(out.threadId).toMatch(/^[0-9a-f]{24}$/)
    expect(h.threads[out.threadId]!.messages[0]!.content).toBe('Can we justify "simple"?\n\nCo-authored by Claude')

    const sent = h.server.sock.emitsOf('applyOtUpdate')[0]!.args[1] as { op: unknown[] }
    expect(sent.op).toEqual([{ c: 'Our method is simple.', p: DOC.indexOf('Our method'), t: out.threadId }])
    expect(h.calls[0]).toBe(`post:${out.threadId}`) // thread exists before the anchor is sent
    expect(h.server.text('main')).toBe(DOC)
  })

  it('creates nothing when the anchor is missing or ambiguous', async () => {
    const h = await harness()
    await expect(
      handleAddComment(h.ctx, { ...base, anchorText: 'no such sentence', content: 'x', agentName: 'Claude' }),
    ).rejects.toMatchObject({ code: 'EDIT_NO_MATCH' })
    await expect(
      handleAddComment(h.ctx, { ...base, anchorText: '\\section', content: 'x', agentName: 'Claude' }),
    ).rejects.toMatchObject({ code: 'EDIT_AMBIGUOUS', context: { lines: [1, 4] } })
    expect(h.calls).toEqual([])
    expect(h.server.sock.emitsOf('applyOtUpdate')).toHaveLength(0)
  })

  it('fails up front on an instance without a review panel (stock CE)', async () => {
    const h = await harness({ supported: false })
    await expect(
      handleAddComment(h.ctx, { ...base, anchorText: 'We study widgets.', content: 'x', agentName: 'Claude' }),
    ).rejects.toMatchObject({ code: 'COMMENTS_UNSUPPORTED' })
    expect(h.server.sock.emitsOf('applyOtUpdate')).toHaveLength(0)
  })

  it('keeps the anchor on its text when a human edit overtakes the comment op', () => {
    // Human inserts a line above while our {c} op is in flight: same transform the server runs.
    const ours = [{ c: 'Our method is simple.', p: 40, t: 'T' }]
    expect(transformOps(ours, [{ p: 0, i: '% draft\n' }], 'left')).toEqual([{ c: 'Our method is simple.', p: 48, t: 'T' }])
    // …or types inside the commented text.
    expect(transformOps(ours, [{ p: 44, i: 'new ' }], 'left')).toEqual([{ c: 'Our new method is simple.', p: 40, t: 'T' }])
    // …or deletes part of it.
    expect(transformOps(ours, [{ p: 50, d: ' is simple' }], 'left')).toEqual([{ c: 'Our method.', p: 40, t: 'T' }])
  })
})

describe('overleaf_list_comments', () => {
  it('reports human comments from joinDoc ranges with thread messages, and follows later edits', async () => {
    const p = DOC.indexOf('widgets')
    const h = await harness({
      ranges: { main: { comments: [{ id: 'th1', op: { c: 'widgets', p, t: 'th1' } }] } },
    })
    h.threads.th1 = { messages: [{ id: 'm0', content: 'Should this be "gadgets"?', timestamp: 1_700_000_000_000, user: { first_name: 'Ada' } }] }

    expect((await handleListComments(h.ctx, base)).comments).toEqual([{
      threadId: 'th1', path: 'main.tex', line: 2, anchorText: 'widgets', resolved: false,
      messages: [{ author: 'Ada', content: 'Should this be "gadgets"?', at: '2023-11-14T22:13:20.000Z' }],
    }])

    // A collaborator adds two lines at the top and edits inside the commented word.
    h.server.remoteEdit('main', [{ p: 0, i: '% a\n% b\n' }])
    h.server.remoteEdit('main', [{ p: p + 8 + 3, i: 'GET' }])
    const [moved] = (await handleListComments(h.ctx, base)).comments
    expect(moved).toMatchObject({ line: 4, anchorText: 'widGETgets' })
  })

  it('hides resolved threads unless asked, and picks up a comment the agent just added', async () => {
    const h = await harness()
    const added = await handleAddComment(h.ctx, { ...base, anchorText: 'We study widgets.', content: 'Cite?', agentName: 'Claude' })
    expect((await handleListComments(h.ctx, base)).comments.map((c) => c.threadId)).toEqual([added.threadId])

    await handleResolveComment(h.ctx, { ...base, threadId: added.threadId })
    expect(h.calls.at(-1)).toBe(`resolve:main:${added.threadId}`)
    expect((await handleListComments(h.ctx, base)).comments).toEqual([])
    expect((await handleListComments(h.ctx, { ...base, includeResolved: true })).comments[0]!.resolved).toBe(true)

    await handleResolveComment(h.ctx, { ...base, threadId: added.threadId, resolved: false })
    expect(h.calls.at(-1)).toBe(`reopen:main:${added.threadId}`)
  })
})

describe('overleaf_reply_comment', () => {
  it('signs the reply and refuses to reply to a thread that does not exist', async () => {
    const h = await harness()
    h.threads.th1 = { messages: [] }
    const out = await handleReplyComment(h.ctx, { projectId: 'p1', threadId: 'th1', content: 'Done.', agentName: 'Claude' })
    expect(out.posted).toBe('Done.\n\nCo-authored by Claude')
    expect(h.threads.th1.messages).toHaveLength(1)

    await expect(
      handleReplyComment(h.ctx, { projectId: 'p1', threadId: 'nope', content: 'x', agentName: 'Claude' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(Object.keys(h.threads)).toEqual(['th1']) // no orphan thread was created
  })
})
