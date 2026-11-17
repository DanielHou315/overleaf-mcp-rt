import { describe, it, expect, vi } from 'vitest'
import { FakeOverleaf, REVIEW_PANEL, STOCK_CE, TC_SEED, connectEngine, existingChanges } from './fake-overleaf.js'
import type { OtOp } from '../../src/overleaf/diff.js'
import type { TrackedChange } from '../../src/overleaf/ot.types.js'
import {
  boundsAtJoin, CHANGES_HEADROOM, DOC_LENGTH_HEADROOM, generateIdSeed, growth, MAX_CHANGES, MAX_DOC_LENGTH,
  MAX_RANGES_SIZE, RANGES_SIZE_HEADROOM, trackedLimitError, type TrackedBounds,
} from '../../src/overleaf/track-changes.js'

/** The most tracked changes the engine lets a doc reach. */
const ALLOWED = MAX_CHANGES - CHANGES_HEADROOM

describe('generateIdSeed', () => {
  it('is RangesTracker.generateIdSeed\'s format: 8 hex of Unix seconds, then 10 random', () => {
    const before = Math.floor(Date.now() / 1000)
    const seeds = Array.from({ length: 1000 }, () => generateIdSeed())
    for (const seed of seeds) expect(seed).toMatch(TC_SEED)
    expect(parseInt(seeds[0]!.slice(0, 8), 16)).toBeGreaterThanOrEqual(before)
    expect(new Set(seeds).size).toBe(1000)
  })
})

describe('tracked-change bounds', () => {
  it.each([
    ['a tracked insert into a doc without changes', [{ p: 0, i: 'x' }], true, 0, 1],
    ['a tracked insert that may split someone else\'s change', [{ p: 0, i: 'x' }], true, 5, 2],
    ['a tracked delete', [{ p: 0, d: 'x' }], true, 5, 1],
    ['an untracked insert that may split a change', [{ p: 0, i: 'x' }], false, 5, 1],
    ['an untracked insert into a doc without changes', [{ p: 0, i: 'x' }], false, 0, 0],
    ['an untracked delete', [{ p: 0, d: 'x' }], false, 5, 0],
    ['a comment', [{ p: 0, c: 'x', t: 't1' }], true, 5, 0],
    ['a tracked replacement', [{ p: 0, d: 'x' }, { p: 0, i: 'y' }], true, 5, 3],
  ])('count: %s', (_, ops, tracked, existing, expected) => {
    expect(growth(ops, tracked, existing).changes).toBe(expected)
  })

  it('only tracked deletions add deleted text, and only tracked text adds its JSON', () => {
    expect(growth([{ p: 0, d: 'abc' }], true, 0).deletedLength).toBe(3)
    expect(growth([{ p: 0, d: 'abc' }], false, 5)).toEqual({ changes: 0, deletedLength: 0, json: 0 })
    expect(growth([{ p: 0, i: 'abc' }], true, 0).deletedLength).toBe(0)
    // JSON counts the text as the server serializes it: escapes make LaTeX longer.
    expect(growth([{ p: 0, i: '\\\\x' }], true, 0).json - growth([{ p: 0, i: 'xx' }], true, 0).json).toBe(3)
  })

  it('measures what joinDoc reports, overestimating packed non-ASCII text', () => {
    const packed = Buffer.from('é', 'utf-8').toString('latin1') // two bytes as latin1
    const changes: TrackedChange[] = [
      { id: 'a', op: { d: `${packed}xy`, p: 0 }, metadata: { user_id: 'u' } },
      { id: 'b', op: { i: 'hello', p: 4 }, metadata: { user_id: 'u' } },
    ]
    const bounds = boundsAtJoin(changes)
    expect(bounds).toMatchObject({ changes: 2, deletedLength: 4 })
    expect(bounds.json).toBe(JSON.stringify(changes).length)
    expect(boundsAtJoin()).toEqual({ changes: 0, deletedLength: 0, json: 0 })
  })

  it('refuses at whichever limit an edit could cross, and says which', () => {
    const none: TrackedBounds = { changes: 0, deletedLength: 0, json: 0 }
    const insert = [{ p: 0, i: 'hello' }]
    const text = 'x'.repeat(10)
    const limitOf = (trackedBounds: TrackedBounds, ops: OtOp[] = insert, comments: Array<{ text: string }> = []) =>
      trackedLimitError({ trackedBounds, text, comments }, ops, 'main.tex')?.context.limit ?? null
    expect(limitOf(none)).toBeNull()
    expect(limitOf({ ...none, changes: ALLOWED })).toBe('changes')
    const nearlyFull = MAX_DOC_LENGTH - DOC_LENGTH_HEADROOM - 10
    expect(limitOf({ ...none, deletedLength: nearlyFull })).toBe('docLength')
    // A tracked deletion doesn't grow text plus pending deletions, so it passes.
    expect(limitOf({ ...none, deletedLength: nearlyFull + 100 }, [{ p: 0, d: 'he' }])).toBeNull()
    expect(limitOf({ ...none, json: MAX_RANGES_SIZE - RANGES_SIZE_HEADROOM - 100 })).toBe('rangesSize')
    expect(limitOf(none, insert, [{ text: 'c'.repeat(MAX_RANGES_SIZE - RANGES_SIZE_HEADROOM - 100) }])).toBe('rangesSize')

    const refusal = trackedLimitError({ trackedBounds: { ...none, changes: ALLOWED }, text, comments: [] }, insert, 'main.tex')!
    expect(refusal.code).toBe('TRACK_CHANGES_LIMIT')
    expect(refusal.message).toMatch(/at most 2000 tracked changes .* main\.tex has 1950, and this edit could add up to 2: .* Nothing was sent\./)
    expect(refusal.context).toMatchObject({ path: 'main.tex', changeCount: ALLOWED, couldAdd: 2 })
  })
})

describe('OtEngine: tracked changes', () => {
  it('sends a fresh seed with every tracked update, and the server mints distinct change ids from them', async () => {
    const server = new FakeOverleaf({ d1: 'one two three' }, { features: REVIEW_PANEL })
    const engine = await connectEngine(server)
    const before = Math.floor(Date.now() / 1000)
    const first = await engine.updateDoc('d1', (t) => t.replace('one', 'ONE'), { trackChanges: true })
    const second = await engine.updateDoc('d1', (t) => t.replace('three', 'THREE'), { trackChanges: true })
    const after = Math.floor(Date.now() / 1000)

    expect([first.tracked, second.tracked]).toEqual([true, true])
    const seeds = server.sentUpdates().map((u) => u.meta?.tc as string)
    expect(seeds).toHaveLength(2)
    for (const seed of seeds) {
      expect(seed).toMatch(TC_SEED)
      const seconds = parseInt(seed.slice(0, 8), 16)
      expect(seconds).toBeGreaterThanOrEqual(before)
      expect(seconds).toBeLessThanOrEqual(after)
    }
    // The counter restarts with every seed, so a reused seed would mint these twice.
    expect(seeds[0]).not.toBe(seeds[1])
    const ids = server.changes('d1').map((c) => c.id)
    expect(ids).toHaveLength(4) // each replacement is a delete and an insert
    expect(new Set(ids).size).toBe(4)
    expect(server.text('d1')).toBe('ONE two THREE')
    expect(engine.readDoc('d1')).toBe(server.text('d1'))
    expect(server.invalidUpdates).toEqual([])
  })

  it('adds only meta.tc to the update; untracked, the update is exactly {doc, op, v} as before', async () => {
    const server = new FakeOverleaf({ d1: 'hello' }, { features: REVIEW_PANEL })
    const engine = await connectEngine(server)
    const direct = await engine.updateDoc('d1', (t) => `${t}!`)
    const tracked = await engine.updateDoc('d1', (t) => `${t}?`, { trackChanges: true })

    const [first, second] = server.sentUpdates()
    expect(Object.keys(first!).sort()).toEqual(['doc', 'op', 'v'])
    expect(direct.tracked).toBe(false)
    expect(Object.keys(second!).sort()).toEqual(['doc', 'meta', 'op', 'v'])
    expect(Object.keys(second!.meta!)).toEqual(['tc'])
    expect(tracked.tracked).toBe(true)
    expect(server.changes('d1')).toHaveLength(1) // only the tracked one
    expect(server.text('d1')).toBe('hello!?')
  })

  it('a tracked rewording arrives as one suggestion per changed word; a direct edit stays the minimal diff', async () => {
    const before = 'We propose a novel method for sparse regression.'
    const after = 'We introduce a new approach to sparse linear regression.'
    const server = new FakeOverleaf({ d1: before, d2: before }, { features: REVIEW_PANEL })
    const engine = await connectEngine(server)
    await engine.updateDoc('d1', () => after, { trackChanges: true })
    await engine.updateDoc('d2', () => after)

    expect(server.changes('d1').map((c) => c.op.d ?? `+${c.op.i}`)).toEqual([
      'propose', '+introduce', 'novel', '+new', 'method', '+approach', 'for', '+to', '+linear ',
    ])
    // The character diff would have left "-p +int -pos +duc ..." in the review panel.
    expect(server.sentUpdates()[1]!.op.length).toBeGreaterThan(server.sentUpdates()[0]!.op.length)
    expect([server.text('d1'), server.text('d2')]).toEqual([after, after])
  })

  it('a tracked edit that changes nothing sends nothing', async () => {
    const server = new FakeOverleaf({ d1: 'hello' }, { features: REVIEW_PANEL })
    const engine = await connectEngine(server)
    const result = await engine.updateDoc('d1', (t) => t, { trackChanges: true })
    expect(result.tracked).toBe(false)
    expect(server.sentUpdates()).toEqual([])
  })

  it.each([
    ['a stock Community Edition (no review panel)', STOCK_CE, /no review panel/],
    ['a project whose owner\'s plan has no track changes', { trackChanges: false, trackChangesVisible: true }, /owner's Overleaf plan/],
    ['a server that reports no features at all', undefined, /no review panel/],
  ])('refuses on %s before anything is sent; untracked edits still work', async (_, features, message) => {
    const server = new FakeOverleaf({ d1: 'hello' }, { features })
    const engine = await connectEngine(server)
    await expect(engine.updateDoc('d1', (t) => `${t}!`, { trackChanges: true })).rejects.toMatchObject({
      code: 'TRACK_CHANGES_UNSUPPORTED',
      message: expect.stringMatching(message),
      context: { directEditPossible: true },
    })
    expect(server.sentUpdates()).toEqual([])
    expect(server.text('d1')).toBe('hello')

    await engine.updateDoc('d1', (t) => `${t}!`)
    expect(server.text('d1')).toBe('hello!')
  })

  it('refuses history-OT docs, where meta.tc is ignored and the edit would land untracked, even with the check skipped', async () => {
    const server = new FakeOverleaf({ d1: 'hello' }, { historyOt: true, features: REVIEW_PANEL })
    const engine = await connectEngine(server, { trackChangesSkipCheck: true })
    await expect(engine.updateDoc('d1', (t) => `${t}!`, { trackChanges: true })).rejects.toMatchObject({
      code: 'TRACK_CHANGES_UNSUPPORTED',
      message: expect.stringMatching(/history-OT/),
      context: { otType: 'history-ot', directEditPossible: true },
    })
    expect(server.sentUpdates()).toEqual([])
    expect(server.text('d1')).toBe('hello')
  })

  it('on a history-OT doc whose direct edits are switched off (the default), says so instead of offering one', async () => {
    const server = new FakeOverleaf({ d1: 'hello' }, { historyOt: true, features: REVIEW_PANEL })
    const engine = await connectEngine(server, { historyOtWrites: false })
    await expect(engine.updateDoc('d1', (t) => `${t}!`, { trackChanges: true })).rejects.toMatchObject({
      code: 'TRACK_CHANGES_UNSUPPORTED',
      message: expect.stringMatching(/OVERLEAF_HISTORY_OT_WRITES=1/),
      context: { directEditPossible: false },
    })
    expect(server.sentUpdates()).toEqual([])
  })

  it('the test-only override sends tracked changes where the server reports no review panel', async () => {
    const server = new FakeOverleaf({ d1: 'hello' }, { features: STOCK_CE })
    const engine = await connectEngine(server, { trackChangesSkipCheck: true })
    const result = await engine.updateDoc('d1', (t) => `${t}!`, { trackChanges: true })
    expect(result.tracked).toBe(true)
    expect(server.sentUpdates()[0]!.meta?.tc).toMatch(TC_SEED)
    expect(server.changes('d1')).toHaveLength(1)
  })
})

describe('OtEngine: Overleaf\'s limits on tracked changes', () => {
  // Past the change count or the ranges size, document-updater fails an update only after
  // publishing it, which disconnects everyone in the doc; past the length, nobody can type.
  // The engine refuses before sending.

  it('refuses an edit that could take the doc over 2000 changes, after counting again, with nothing sent', async () => {
    const server = new FakeOverleaf({ d1: 'hello' }, { features: REVIEW_PANEL, ranges: { d1: { changes: existingChanges(ALLOWED - 1) } } })
    const engine = await connectEngine(server)
    await expect(engine.updateDoc('d1', (t) => `${t} world`, { trackChanges: true })).rejects.toMatchObject({
      code: 'TRACK_CHANGES_LIMIT',
      context: { limit: 'changes', changeCount: ALLOWED - 1, couldAdd: 2 },
    })
    expect(server.sentUpdates()).toEqual([])
    expect(server.sock.emitsOf('joinDoc')).toHaveLength(2) // the recount
    expect(server.changes('d1')).toHaveLength(ALLOWED - 1)

    // Untracked edits add no changes of their own and are not limited.
    await engine.updateDoc('d1', (t) => `${t} world`)
    expect(server.text('d1')).toBe('hello world')
  })

  it('refuses at once, without counting again, an edit that is past the limit on its own', async () => {
    // A comma after each of 2000 words: 2000 suggestions, more than a doc without any may take.
    const before = 'a b '.repeat(1000)
    const server = new FakeOverleaf({ d1: before }, { features: REVIEW_PANEL })
    const engine = await connectEngine(server)
    let builds = 0
    const edit = () => {
      builds += 1
      return 'a, b, '.repeat(1000)
    }
    await expect(engine.updateDoc('d1', edit, { trackChanges: true })).rejects.toMatchObject({
      code: 'TRACK_CHANGES_LIMIT',
      context: { limit: 'changes', changeCount: 0, couldAdd: 2000 }, // the word diff kept each comma its own change
    })
    // A recount could only have found the same: the doc has no changes to accept or reject.
    expect(server.sock.emitsOf('joinDoc')).toHaveLength(1)
    expect(builds).toBe(1)
    expect(server.sentUpdates()).toEqual([])
    expect(server.text('d1')).toBe(before)
  })

  it('sends after all when the recount shows changes were accepted since the join', async () => {
    const server = new FakeOverleaf({ d1: 'hello' }, { features: REVIEW_PANEL, ranges: { d1: { changes: existingChanges(ALLOWED - 1) } } })
    const engine = await connectEngine(server)
    await engine.joinDoc('d1')
    server.acceptAllChanges('d1') // the engine doesn't follow accepts: its bound is still high

    const result = await engine.updateDoc('d1', (t) => `${t} world`, { trackChanges: true })
    expect(result.tracked).toBe(true)
    expect(server.sock.emitsOf('joinDoc')).toHaveLength(2)
    expect(server.changes('d1')).toHaveLength(1)
    expect(engine.readDoc('d1')).toBe(server.text('d1'))
  })

  it('counts the changes its own confirmed edits add', async () => {
    const server = new FakeOverleaf({ d1: 'hello' }, { features: REVIEW_PANEL, ranges: { d1: { changes: existingChanges(ALLOWED - 4) } } })
    const engine = await connectEngine(server)
    await engine.updateDoc('d1', (t) => `${t} 1`, { trackChanges: true }) // could add 2: an insert, and a split
    await engine.updateDoc('d1', (t) => `${t} 2`, { trackChanges: true }) // reaches the allowance exactly
    expect(server.sock.emitsOf('joinDoc')).toHaveLength(1)
    await engine.updateDoc('d1', (t) => `${t} 3`, { trackChanges: true }) // could pass it: counted again first
    expect(server.sock.emitsOf('joinDoc')).toHaveLength(2)
    expect(server.text('d1')).toBe('hello 1 2 3')
  })

  it('counts collaborators\' suggestions as they arrive', async () => {
    const server = new FakeOverleaf({ d1: 'hello' }, { features: REVIEW_PANEL, ranges: { d1: { changes: existingChanges(ALLOWED - 10) } } })
    const engine = await connectEngine(server)
    await engine.joinDoc('d1')
    // Five suggestions in one update from someone in the browser: each could add 2.
    server.remoteEdit('d1', [0, 1, 2, 3, 4].map((k) => ({ p: 2 * k, i: 'h' })), { trackChanges: true })

    const result = await engine.updateDoc('d1', (t) => `${t}?`, { trackChanges: true })
    expect(result.tracked).toBe(true)
    expect(server.sock.emitsOf('joinDoc')).toHaveLength(2) // the bound said maybe, so it counted again
    expect(server.changes('d1')).toHaveLength(ALLOWED - 10 + 5 + 1)
    expect(engine.readDoc('d1')).toBe(server.text('d1'))
  })

  it('refuses insertions that would make text plus pending deletions too long for anyone to type', async () => {
    const pending = 'x'.repeat(MAX_DOC_LENGTH - DOC_LENGTH_HEADROOM - 10)
    const deletion: TrackedChange = { id: '0'.repeat(24), op: { d: pending, p: 5 }, metadata: { user_id: 'u-human' } }
    const server = new FakeOverleaf({ d1: 'hello world' }, { features: REVIEW_PANEL, ranges: { d1: { changes: [deletion] } } })
    const engine = await connectEngine(server)

    await expect(engine.updateDoc('d1', (t) => `${t} again`, { trackChanges: true })).rejects.toMatchObject({
      code: 'TRACK_CHANGES_LIMIT',
      context: { limit: 'docLength', deletedLength: pending.length },
    })
    expect(server.sentUpdates()).toEqual([])
    // A tracked deletion moves text into the pending deletions: the total does not grow.
    const removed = await engine.updateDoc('d1', (t) => t.replace(' world', ''), { trackChanges: true })
    expect(removed.tracked).toBe(true)
    expect(server.sentUpdates().map((u) => u.op)).toEqual([[{ p: 5, d: ' world' }]])
    expect(server.text('d1')).toBe('hello')
  })

  it('refuses an edit that could take the doc\'s changes and comments past what Overleaf stores', async () => {
    const commented = 'c'.repeat(MAX_RANGES_SIZE - RANGES_SIZE_HEADROOM - 500)
    const server = new FakeOverleaf({ d1: 'hello' }, {
      features: REVIEW_PANEL,
      ranges: { d1: { comments: [{ id: 't1', op: { c: commented, p: 0, t: 't1' } }] } },
    })
    const engine = await connectEngine(server)
    await expect(engine.updateDoc('d1', (t) => `${t} ${'y'.repeat(1000)}`, { trackChanges: true })).rejects.toMatchObject({
      code: 'TRACK_CHANGES_LIMIT',
      context: { limit: 'rangesSize' },
    })
    expect(server.sentUpdates()).toEqual([])
  })

  it('a dry run runs the same checks, recount included, and returns what would be sent without sending it', async () => {
    const server = new FakeOverleaf({ d1: 'hello' }, { features: REVIEW_PANEL, ranges: { d1: { changes: existingChanges(ALLOWED - 1) } } })
    const engine = await connectEngine(server)
    const edit = (t: string) => `${t} world`
    await expect(engine.updateDoc('d1', edit, { trackChanges: true, dryRun: true })).rejects.toMatchObject({ code: 'TRACK_CHANGES_LIMIT' })
    expect(server.sock.emitsOf('joinDoc')).toHaveLength(2)

    server.acceptAllChanges('d1')
    const preview = await engine.updateDoc('d1', edit, { trackChanges: true, dryRun: true })
    expect(preview).toMatchObject({ tracked: true, textBefore: 'hello', textAfter: 'hello world', versionAfter: preview.versionBefore })
    expect(engine.hasSeen('d1')).toBe(true)
    expect(server.sentUpdates()).toEqual([])

    const ce = new FakeOverleaf({ d1: 'hello' }, { features: STOCK_CE })
    await expect((await connectEngine(ce)).updateDoc('d1', edit, { trackChanges: true, dryRun: true })).rejects.toMatchObject({
      code: 'TRACK_CHANGES_UNSUPPORTED',
    })
  })

  it('a dry run of an edit that changes nothing succeeds like the real one, even at the limit', async () => {
    const server = new FakeOverleaf({ d1: 'hello' }, { features: REVIEW_PANEL, ranges: { d1: { changes: existingChanges(MAX_CHANGES) } } })
    const engine = await connectEngine(server)
    const preview = await engine.updateDoc('d1', (t) => t, { trackChanges: true, dryRun: true })
    expect(preview).toMatchObject({ tracked: false, ops: [], textAfter: 'hello' })
    expect(server.sock.emitsOf('joinDoc')).toHaveLength(1) // no limit check, so no recount
    expect(server.sentUpdates()).toEqual([])
  })

  it('FakeOverleaf, like document-updater, confirms an update past the limit to its sender, then fails it for everyone and stores nothing (what the guard prevents)', async () => {
    const server = new FakeOverleaf({ d1: 'hello' }, { ranges: { d1: { changes: existingChanges(2000) } } })
    const events: unknown[][] = []
    server.sock.on('otUpdateApplied', (update) => events.push(['otUpdateApplied', update]))
    server.sock.on('otUpdateError', (error) => events.push(['otUpdateError', error]))
    // Straight on the socket, past the engine and its guard.
    await server.sock.emitWithAck('applyOtUpdate', 'd1', {
      doc: 'd1', op: [{ p: 0, i: 'x' }], v: server.version('d1'), meta: { tc: '0'.repeat(18) },
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(events).toEqual([
      ['otUpdateApplied', { doc: 'd1', v: 1 }], // the sender's confirmation (no op)
      ['otUpdateError', expect.any(String)], // then every client in the doc, which disconnects them
    ])
    expect(server.text('d1')).toBe('hello')
    expect(server.changes('d1')).toHaveLength(2000)
  })
})
