import { describe, it, expect } from 'vitest'
import { OtEngine } from '../../src/overleaf/ot.js'
import { computeOps, type OtOp } from '../../src/overleaf/diff.js'
import { applyOps, transformOps } from '../../src/overleaf/text-ot.js'
import {
  decodeEditOperations, fromTextOperation, isAscending, toTextOperation,
} from '../../src/overleaf/history-ot.js'
import { handleAddComment } from '../../src/mcp/tools/comments.js'
import { handleEditDoc } from '../../src/mcp/tools/edit.js'
import { FakeOverleaf, connectEngine, makeToolHarness } from './fake-overleaf.js'
import { TextOp } from './text-operation-oracle.js'

function lcg(seed: number) {
  return (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % n
  }
}

/** A random multi-component edit of `text`, as the ShareJS components computeOps would produce. */
function randomEdit(text: string, rand: (n: number) => number, tag: string): OtOp[] {
  let next = text
  for (let k = 1 + rand(3); k > 0; k--) {
    const p = rand(next.length + 1)
    const del = Math.min(rand(4), next.length - p)
    const ins = rand(3) === 0 ? '' : `${tag}${rand(100)}`
    next = next.slice(0, p) + ins + next.slice(p + del)
  }
  return computeOps(text, next)
}

describe('history-ot codec', () => {
  it('turns ShareJS components into one text operation spanning the doc', () => {
    expect(toTextOperation([{ p: 6, i: 'big ' }], 'hello world')).toEqual({ textOperation: [6, 'big ', 5] })
    expect(toTextOperation([{ p: 0, d: 'hello ' }], 'hello world')).toEqual({ textOperation: [-6, 5] })
    // replace = delete then insert at the same position
    expect(toTextOperation([{ p: 6, d: 'world' }, { p: 6, i: 'there' }], 'hello world'))
      .toEqual({ textOperation: [6, -5, 'there'] })
    // several edits: later positions are in the doc as the earlier components left it
    expect(toTextOperation([{ p: 0, i: '>> ' }, { p: 9, d: 'world' }, { p: 9, i: 'you' }], 'hello world'))
      .toEqual({ textOperation: ['>> ', 6, -5, 'you'] })
    expect(toTextOperation([], 'abc')).toEqual({ textOperation: [3] })
  })

  it('refuses components it cannot place, rather than sending a wrong operation', () => {
    expect(() => toTextOperation([{ p: 2, d: 'zz' }], 'hello')).toThrow(/does not match/)
    expect(() => toTextOperation([{ p: 4, i: 'a' }, { p: 1, i: 'b' }], 'hello')).toThrow(/ascending/)
    expect(isAscending([{ p: 4, i: 'a' }, { p: 1, i: 'b' }])).toBe(false)
    expect(isAscending([{ p: 1, d: 'x' }, { p: 1, i: 'y' }, { p: 5, d: 'z' }])).toBe(true)
  })

  it('reads text operations back, including the object forms that carry tracking and comment ids', () => {
    expect(fromTextOperation({ textOperation: [6, -5, 'there'] }, 'hello world'))
      .toEqual([{ p: 6, d: 'world' }, { p: 6, i: 'there' }])
    expect(fromTextOperation({ textOperation: ['there', 6, -5] }, 'hello world'))
      .toEqual([{ p: 0, i: 'there' }, { p: 11, d: 'world' }])
    expect(fromTextOperation(
      { textOperation: [{ r: 6, tracking: { type: 'none' } }, { i: 'big ', commentIds: ['c1'] }, 5] },
      'hello world',
    )).toEqual([{ p: 6, i: 'big ' }])
    expect(() => fromTextOperation({ textOperation: [3] }, 'hello')).toThrow(/spans 3 characters but the doc has 5/)
  })

  it('round-trips random edits: decode(encode(ops)) has the same effect as ops', () => {
    const rand = lcg(7)
    for (let n = 0; n < 500; n++) {
      const text = 'the quick brown fox jumps over the lazy dog'.slice(0, 5 + rand(38))
      const ops = randomEdit(text, rand, 'x')
      const raw = toTextOperation(ops, text)
      expect(TextOp.fromJSON(raw).apply(text), 'server applies what we meant').toBe(applyOps(text, ops))
      expect(applyOps(text, fromTextOperation(raw, text))).toBe(applyOps(text, ops))
    }
  })

  it('mirrors other edit operations: a new comment becomes an anchor, the rest change nothing', () => {
    expect(decodeEditOperations([{ commentId: 't1', ranges: [{ pos: 6, length: 5 }] }], 'hello world'))
      .toEqual([{ p: 6, c: 'world', t: 't1' }])
    expect(decodeEditOperations([{ noOp: true }, { deleteComment: 't1' }, { commentId: 't1', resolved: true }], 'hello'))
      .toEqual([])
  })
})

/**
 * The engine predicts what the server does to its in-flight op using the
 * ShareJS transform, while a history-ot server uses editor-core's. They must
 * agree on the resulting *text* for every interleaving, or the snapshot drifts
 * silently and a later delete gets everyone disconnected.
 */
describe('ShareJS transform vs editor-core transform', () => {
  it('give the same document for 3000 random concurrent edit pairs', () => {
    const rand = lcg(2024)
    for (let n = 0; n < 3000; n++) {
      const text = 'lorem ipsum dolor sit amet'.slice(0, 3 + rand(24))
      const ours = randomEdit(text, rand, 'a')
      const theirs = randomEdit(text, rand, 'h')

      // Server: theirs landed first, ours arrives stale and is transformed as operation1.
      const serverTheirs = TextOp.fromJSON(toTextOperation(theirs, text))
      const serverOurs = TextOp.transform(TextOp.fromJSON(toTextOperation(ours, text)), serverTheirs)[0]
      const onServer = serverOurs.apply(serverTheirs.apply(text))

      // Engine: applies theirs, transforms its in-flight op 'left', applies it on the ack.
      const afterTheirs = applyOps(text, theirs)
      const predicted = applyOps(afterTheirs, transformOps(ours, theirs, 'left'))

      expect(predicted, JSON.stringify({ text, ours, theirs })).toBe(onServer)
    }
  })
})

describe('OtEngine on a history-ot doc', () => {
  const historyOt = { historyOt: true }

  it('declares support when joining (the server refuses the doc otherwise) and reads the raw snapshot', async () => {
    const server = new FakeOverleaf({ d1: 'naïve café — 数学' }, historyOt)
    const engine = await connectEngine(server)
    const baseline = await engine.joinDoc('d1')
    expect(server.sock.emitsOf('joinDoc')[0]!.args[1]).toMatchObject({ supportsHistoryOT: true })
    expect(baseline.otType).toBe('history-ot')
    expect(baseline.text).toBe('naïve café — 数学') // plain string, not latin1-packed
  })

  it('sends a text operation and ends up with the server\'s text', async () => {
    const server = new FakeOverleaf({ d1: 'The quick brown fox.' }, historyOt)
    const engine = await connectEngine(server)
    const errors: unknown[] = []
    server.sock.on('otUpdateError', (e) => errors.push(e))

    await engine.updateDoc('d1', (t) => t.replace('quick', 'slow'))
    const sent = server.sock.emitsOf('applyOtUpdate')[0]!.args[1] as { op: unknown[]; v: number }
    expect(sent.op).toEqual([{ textOperation: [4, -5, 'slow', 11] }])
    expect(server.text('d1')).toBe('The slow brown fox.')
    expect(engine.readDoc('d1')).toBe(server.text('d1'))
    expect(errors).toEqual([])
  })

  it('follows a collaborator and reports what they changed', async () => {
    const server = new FakeOverleaf({ d1: 'The quick brown fox.' }, historyOt)
    const engine = await connectEngine(server)
    await engine.openDoc('d1')
    server.remoteSplice('d1', 0, 9, 'A slow')
    expect(engine.readDoc('d1')).toBe('A slow brown fox.')
    await engine.updateDoc('d1', (t) => t.replace('fox', 'dog'))
    expect(server.text('d1')).toBe('A slow brown dog.')
    const changes = engine.collectExternalChanges()
    expect(changes.docs).toHaveLength(1)
    expect(changes.docs[0]!.before).toContain('The quick')
  })

  it('survives a randomized interleaving of human and agent edits without diverging', async () => {
    const rand = lcg(42)
    const server = new FakeOverleaf({ d1: 'lorem ipsum dolor sit amet, consectetur adipiscing elit' }, historyOt)
    const engine = await connectEngine(server)
    const errors: unknown[] = []
    server.sock.on('otUpdateError', (e) => errors.push(e))
    await engine.joinDoc('d1')

    for (let round = 0; round < 200; round++) {
      server.holdAgentOps = rand(2) === 0
      const write = engine.updateDoc('d1', (t) => {
        const p = rand(t.length + 1)
        return rand(3) === 0 && t.length > 6
          ? t.slice(0, Math.min(p, t.length - 3)) + `<r${round}>` + t.slice(Math.min(p, t.length - 3) + 3)
          : `${t.slice(0, p)}[a${round}]${t.slice(p)}`
      })
      if (server.holdAgentOps) {
        for (let i = 0; i < 50 && server.heldCount === 0; i++) await new Promise((r) => setTimeout(r, 0))
      }
      for (let k = rand(4); k > 0; k--) {
        const text = server.text('d1')
        const p = rand(text.length + 1)
        server.remoteSplice('d1', p, Math.min(rand(3), text.length - p), rand(2) === 0 ? `h${rand(10)}` : '')
      }
      server.flush()
      await write
      expect(engine.readDoc('d1')).toBe(server.text('d1'))
    }
    expect(errors).toEqual([])
    expect(server.sock.emitsOf('joinDoc')).toHaveLength(1)
  })

  it('never sends a surrogate: the server would reject the whole update and disconnect everyone', async () => {
    const server = new FakeOverleaf({ d1: 'Grade: pending.' }, historyOt)
    const engine = await connectEngine(server)
    const errors: unknown[] = []
    server.sock.on('otUpdateError', (e) => errors.push(e))
    const written = await engine.updateDoc('d1', (t) => t.replace('pending', 'passed 🎓'))
    expect(written.unstorableCodeUnits).toBe(2)
    expect(errors).toEqual([])
    expect(server.text('d1')).toBe('Grade: passed ��.')
    expect(engine.readDoc('d1')).toBe(server.text('d1'))
  })

  it('normalises hand-positioned components that are not left-to-right', async () => {
    const server = new FakeOverleaf({ d1: 'abcdef' }, historyOt)
    const engine = await connectEngine(server)
    await engine.applyOps('d1', [{ p: 5, i: 'Y' }, { p: 1, i: 'X' }])
    expect(server.text('d1')).toBe('aXbcdeYf')
    expect(engine.readDoc('d1')).toBe(server.text('d1'))
  })

  it('reads comment anchors from the snapshot and tracks a collaborator\'s new comment', async () => {
    const server = new FakeOverleaf({ d1: 'hello wide world' }, {
      historyOt: true,
      historyOtComments: { d1: [{ id: 't1', ranges: [{ pos: 6, length: 4 }] }] },
    })
    const engine = await connectEngine(server)
    const baseline = await engine.joinDoc('d1')
    expect(baseline.comments).toEqual([{ threadId: 't1', p: 6, text: 'wide' }])
    server.remoteSplice('d1', 0, 0, '>> ')
    expect(engine.getBaseline('d1')!.comments).toEqual([{ threadId: 't1', p: 9, text: 'wide' }])
  })
})

describe('tools on a history-ot doc', () => {
  it('overleaf_edit_doc works unchanged', async () => {
    const h = await makeToolHarness({ a: 'status: todo' }, { historyOt: true })
    const r = await handleEditDoc(h.ctx, { projectId: 'p', path: 'a.tex', edits: [{ old_string: 'todo', new_string: 'done' }] })
    expect(r.ok).toBe(true)
    expect(h.server.text('a')).toBe('status: done')
  })

  it('overleaf_add_comment refuses before creating a thread, since it could not anchor it', async () => {
    const h = await makeToolHarness({ a: 'a sentence worth discussing' }, { historyOt: true })
    await expect(handleAddComment(h.ctx, {
      projectId: 'p', path: 'a.tex', anchorText: 'worth discussing', content: 'Why?', agentName: 'Quill',
    })).rejects.toMatchObject({ code: 'COMMENTS_UNSUPPORTED', message: expect.stringMatching(/history-OT/) })
    expect(h.server.sock.emitsOf('applyOtUpdate')).toHaveLength(0)
    expect(h.server.text('a')).toBe('a sentence worth discussing')
  })
})

describe('OtEngine against a server that does not know history-ot', () => {
  it('is unaffected by the extra joinDoc option', async () => {
    const server = new FakeOverleaf({ d1: 'plain' })
    const engine = await connectEngine(server)
    expect((await engine.joinDoc('d1')).otType).toBe('sharejs-text-ot')
    await engine.updateDoc('d1', (t) => t + '!')
    expect(server.sock.emitsOf('applyOtUpdate')[0]!.args[1]).toMatchObject({ op: [{ p: 5, i: '!' }] })
  })
})

// Referenced so an unused import doesn't hide a broken export.
void OtEngine
