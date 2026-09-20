import { describe, it, expect } from 'vitest'
import { OtEngine } from '../../src/overleaf/ot.js'
import { computeOps, type OtOp } from '../../src/overleaf/diff.js'
import { applyOps, transformOps } from '../../src/overleaf/text-ot.js'
import {
  decodeEditOperations, fromTextOperation, isAscending, toTextOperation, transformInFlight,
} from '../../src/overleaf/history-ot.js'
import { handleAddComment } from '../../src/mcp/tools/comments.js'
import { handleEditDoc } from '../../src/mcp/tools/edit.js'
import { handleReadDoc } from '../../src/mcp/tools/docs.js'
import type { OverleafError } from '../../src/errors.js'
import { FakeOverleaf, connectEngine, makeToolHarness } from './fake-overleaf.js'
import { TextOp } from './text-operation-oracle.js'
import { prng as lcg } from './prng.js'

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
 * The engine has to predict what the server does to its in-flight op when a
 * collaborator's op beats it. The prediction must use the algorithm the server
 * uses for that doc type — they are NOT interchangeable.
 */
describe('predicting the server\'s transform of an in-flight op', () => {
  /** What a history-ot server ends up with: theirs first, ours transformed as operation1. */
  function onServer(text: string, ours: OtOp[], theirs: OtOp[]): string {
    const serverTheirs = TextOp.fromJSON(toTextOperation(theirs, text))
    const serverOurs = TextOp.transform(TextOp.fromJSON(toTextOperation(ours, text)), serverTheirs)[0]
    return serverOurs.apply(serverTheirs.apply(text))
  }

  it('ShareJS and editor-core disagree when our insert lands inside text a collaborator replaced', () => {
    // Found by the random test below once it had a PRNG worth the name.
    const text = 'lorem ipsum'
    const ours: OtOp[] = [{ p: 9, i: 'A' }] // between "s" and "u"
    const theirs: OtOp[] = [{ p: 8, d: 'su' }, { p: 8, i: 'XY' }] // replaces "su"
    expect(onServer(text, ours, theirs)).toBe('lorem ipXYAm') // editor-core: after their replacement
    const shareJs = applyOps(applyOps(text, theirs), transformOps(ours, theirs, 'left'))
    expect(shareJs).toBe('lorem ipAXYm') // ShareJS: before it
    // So the engine must not reuse text-ot.ts for history-ot docs:
    const predicted = applyOps(applyOps(text, theirs), transformInFlight(ours, [toTextOperation(theirs, text)], text))
    expect(predicted).toBe(onServer(text, ours, theirs))
  })

  it('transformInFlight matches the server for 5000 random concurrent edit pairs', () => {
    const rand = lcg(2024)
    let overlapping = 0
    for (let n = 0; n < 5000; n++) {
      const text = 'lorem ipsum dolor sit amet'.slice(0, 3 + rand(24))
      const ours = randomEdit(text, rand, 'a')
      const theirs = randomEdit(text, rand, 'h')
      if (ours.length > 1 || theirs.length > 1) overlapping += 1
      const afterTheirs = applyOps(text, theirs)
      const predicted = applyOps(afterTheirs, transformInFlight(ours, [toTextOperation(theirs, text)], text))
      expect(predicted, JSON.stringify({ text, ours, theirs })).toBe(onServer(text, ours, theirs))
    }
    expect(overlapping, 'multi-component edits in the sample').toBeGreaterThan(1000)
  })

  it('carries an in-flight op past several operations and past non-text ones', () => {
    const text = 'abcdef'
    const ours: OtOp[] = [{ p: 3, i: '!' }]
    const theirUpdate = [toTextOperation([{ p: 0, i: '>>' }], text), { noOp: true }, { commentId: 't', ranges: [] }]
    expect(transformInFlight(ours, theirUpdate, text)).toEqual([{ p: 5, i: '!' }])
  })
})

describe('OtEngine on a history-ot doc', () => {
  const historyOt = { historyOt: true }
  // The initial join plus the one-off check of the first write against a fresh snapshot.
  // Any more would mean the engine lost track and had to rejoin.
  const JOINS = 'one join + the first-write verification; more means it lost track'

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
    expect(server.sock.emitsOf('joinDoc'), JOINS).toHaveLength(2)
  })

  // The live matrix found this: document-updater transforms a stale history-ot op but leaves
  // its `v` at what the sender submitted, for the broadcast and for the ack alike.
  it('follows an op that was applied later than its version says, while our own op is in flight', async () => {
    const server = new FakeOverleaf({ d1: 'one two three' }, historyOt)
    const engine = await connectEngine(server)
    const errors: unknown[] = []
    server.sock.on('otUpdateError', (e) => errors.push(e))
    await engine.openDoc('d1')

    // Agent's op reaches the server first…
    const humanBasedOn = server.version('d1')
    await engine.updateDoc('d1', (t) => t.replace('one', 'ONE'))
    // …then the op a person typed before seeing it: applied after ours, but stamped with their old version.
    server.remoteSplice('d1', 13, 0, '!', { basedOn: humanBasedOn })
    expect(server.text('d1')).toBe('ONE two three!')
    expect(engine.readDoc('d1')).toBe('ONE two three!')

    // And the other way round: theirs lands while ours is held, so our *ack* carries a stale version.
    server.holdAgentOps = true
    const write = engine.updateDoc('d1', (t) => t.replace('two', 'TWO'))
    for (let i = 0; i < 50 && server.heldCount === 0; i++) await new Promise((r) => setTimeout(r, 0))
    server.remoteSplice('d1', 0, 0, '>> ')
    server.flush()
    await write
    expect(server.text('d1')).toBe('>> ONE TWO three!')
    expect(engine.readDoc('d1')).toBe(server.text('d1'))

    expect(errors).toEqual([])
    expect(server.sock.emitsOf('joinDoc'), JOINS).toHaveLength(2)
    const reported = engine.collectExternalChanges().docs
    expect(reported).toHaveLength(1)
    expect(reported[0]!.after).toContain('>> ')
  })

  it('predicts the server when our insert lands inside text a collaborator replaced (where ShareJS would differ)', async () => {
    const server = new FakeOverleaf({ d1: 'lorem ipsum' }, historyOt)
    const engine = await connectEngine(server)
    await engine.joinDoc('d1')
    server.holdAgentOps = true
    const write = engine.updateDoc('d1', (t) => t.replace('su', 'sAu')) // insert between "s" and "u"
    for (let i = 0; i < 50 && server.heldCount === 0; i++) await new Promise((r) => setTimeout(r, 0))
    // Someone replaces "su" first, from a client that lists the remove before the insert (as this one does).
    server.remoteTextOperation('d1', { textOperation: [8, -2, 'XY', 1] })
    server.flush()
    await write
    expect(server.text('d1')).toBe('lorem ipXYAm')
    expect(engine.readDoc('d1')).toBe(server.text('d1'))
    expect(server.sock.emitsOf('joinDoc'), JOINS).toHaveLength(2)
  })

  for (const restampVersions of [false, true]) {
    it(`stays identical through random interleavings with stale collaborator ops (server ${restampVersions ? 'restamps' : 'does not restamp'} versions)`, async () => {
      const rand = lcg(restampVersions ? 99 : 1234)
      const server = new FakeOverleaf({ d1: 'lorem ipsum dolor sit amet, consectetur adipiscing elit' }, { historyOt: true, restampVersions })
      const engine = await connectEngine(server)
      const errors: unknown[] = []
      server.sock.on('otUpdateError', (e) => errors.push(e))
      await engine.joinDoc('d1')
      const first = server.version('d1')
      let staleOps = 0

      for (let round = 0; round < 150; round++) {
        server.holdAgentOps = rand(2) === 0
        const write = engine.updateDoc('d1', (t) => {
          const p = rand(t.length + 1)
          return `${t.slice(0, p)}[a${round}]${t.slice(Math.min(t.length, p + rand(3)))}`
        })
        if (server.holdAgentOps) {
          for (let i = 0; i < 50 && server.heldCount === 0; i++) await new Promise((r) => setTimeout(r, 0))
        }
        for (let k = rand(4); k > 0; k--) {
          // A person's editor can be a few versions behind when they type.
          const current = server.version('d1')
          const basedOn = Math.max(first, current - rand(3))
          if (basedOn < current) staleOps += 1
          server.remoteSplice('d1', rand(60), rand(3), rand(2) === 0 ? `h${rand(10)}` : '', { basedOn })
        }
        server.flush()
        await write
        expect(engine.readDoc('d1'), `round ${round}`).toBe(server.text('d1'))
      }
      expect(staleOps, 'the scenario must actually contain stale ops').toBeGreaterThan(50)
      expect(errors).toEqual([])
      expect(server.sock.emitsOf('joinDoc'), JOINS).toHaveLength(2)
    })
  }

  it('joins again when an update crossing the join cannot be placed, instead of guessing', async () => {
    const server = new FakeOverleaf({ d1: 'abc' }, historyOt)
    const engine = await connectEngine(server)
    let joins = 0
    server.sock.respondToEmit('joinDoc', () => {
      joins += 1
      if (joins === 1) {
        // A keystroke lands between the room join and the snapshot: it is in the snapshot below
        // (version 2) but its broadcast, stamped with the older version, also reaches us.
        server.remoteSplice('d1', 3, 0, 'd')
      }
      return [null, { content: server.text('d1') }, server.version('d1'), [], {}, 'history-ot']
    })
    const baseline = await engine.joinDoc('d1')
    expect(joins).toBe(2)
    expect(baseline.text).toBe('abcd')
    expect(baseline.version).toBe(server.version('d1'))
  })

  it('is read-only unless the user opted in: a rejected write would disconnect people, and overleaf.com is unverified', async () => {
    const server = new FakeOverleaf({ d1: 'hello' }, historyOt)
    const engine = await connectEngine(server, { historyOtWrites: false })
    expect((await engine.openDoc('d1')).text).toBe('hello')
    server.remoteSplice('d1', 5, 0, ' world')
    expect(engine.readDoc('d1')).toBe('hello world') // still follows collaborators
    await expect(engine.updateDoc('d1', (t) => t + '!')).rejects.toMatchObject({ code: 'HISTORY_OT_WRITES_DISABLED' })
    expect(server.sock.emitsOf('applyOtUpdate')).toHaveLength(0)
    expect(server.text('d1')).toBe('hello world')
    // A no-op "write" has nothing to refuse.
    await expect(engine.updateDoc('d1', (t) => t)).resolves.toMatchObject({ ops: [] })
  })

  it('checks its first write against a fresh snapshot, once per doc', async () => {
    const server = new FakeOverleaf({ d1: 'abc' }, historyOt)
    const engine = await connectEngine(server)
    await engine.updateDoc('d1', (t) => t + 'd')
    expect(server.sock.emitsOf('joinDoc')).toHaveLength(2)
    await engine.updateDoc('d1', (t) => t + 'e')
    await engine.updateDoc('d1', (t) => t + 'f')
    expect(server.sock.emitsOf('joinDoc')).toHaveLength(2)
    expect(engine.readDoc('d1')).toBe('abcdef')
  })

  it('stops writing, loudly, when the server stored something other than what it predicted', async () => {
    // A server whose history-ot differs from the one this was built against.
    const server = new FakeOverleaf({ d1: 'lorem ipsum', d2: 'other' }, { historyOt: true, storesDifferently: true })
    const engine = await connectEngine(server)
    await expect(engine.updateDoc('d1', (t) => t.replace('ipsum', 'IPSUM')))
      .rejects.toMatchObject({ code: 'HISTORY_OT_MISMATCH' })
    // It now shows what the server really has, not its own prediction…
    expect(engine.readDoc('d1')).toBe(server.text('d1'))
    // …and refuses further history-ot writes, on any doc, without sending anything.
    const sent = server.sock.emitsOf('applyOtUpdate').length
    await expect(engine.updateDoc('d2', (t) => t + '!')).rejects.toMatchObject({ code: 'HISTORY_OT_MISMATCH' })
    expect(server.sock.emitsOf('applyOtUpdate')).toHaveLength(sent)
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

  it('without the opt-in, reads work and an edit is refused with instructions the agent can pass on', async () => {
    const h = await makeToolHarness({ a: 'status: todo' }, { historyOt: true }, { historyOtWrites: false })
    expect((await handleReadDoc(h.ctx, { projectId: 'p', path: 'a.tex' })).content).toBe('status: todo')
    const refused = await handleEditDoc(h.ctx, { projectId: 'p', path: 'a.tex', edits: [{ old_string: 'todo', new_string: 'done' }] })
      .catch((err: OverleafError) => err.toEnvelope())
    expect(refused).toMatchObject({ code: 'HISTORY_OT_WRITES_DISABLED', retryable: false })
    expect((refused as { hint: string }).hint).toMatch(/OVERLEAF_HISTORY_OT_WRITES=1/)
    expect(h.server.text('a')).toBe('status: todo')
    // A dry run is still allowed: it sends nothing.
    const dry = await handleEditDoc(h.ctx, { projectId: 'p', path: 'a.tex', dryRun: true, edits: [{ old_string: 'todo', new_string: 'done' }] })
    expect(dry.ok).toBe(true)
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
