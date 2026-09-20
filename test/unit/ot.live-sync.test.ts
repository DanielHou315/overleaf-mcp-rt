import { describe, it, expect } from 'vitest'
import { OtEngine } from '../../src/overleaf/ot.js'
import { FakeOverleaf, connectEngine } from './fake-overleaf.js'

/**
 * The bug these guard against: the engine used to ignore collaborators' ops,
 * so after a human typed in the browser the agent submitted its next op at a
 * stale version against stale text. document-updater then rejected it
 * ("Delete component … does not match"), and real-time answers a rejection by
 * sending otUpdateError to — and disconnecting — every client on the doc,
 * which is what knocked the human's editor "out of sync".
 */
/** Resolve once the agent's op has actually been emitted and is parked at the server. */
async function opInFlight(server: FakeOverleaf): Promise<void> {
  const before = server.sock.emitsOf('applyOtUpdate').length
  for (let i = 0; i < 50 && server.heldCount === 0; i++) await new Promise((r) => setTimeout(r, 0))
  expect(server.heldCount, `op emitted (had ${before})`).toBeGreaterThan(0)
}

describe('OtEngine live sync with a collaborator', () => {
  it('tracks browser edits so the next agent edit lands on the current version', async () => {
    const server = new FakeOverleaf({ d1: 'The quick brown fox.' })
    const engine = await connectEngine(server)
    const errors: unknown[] = []
    server.sock.on('otUpdateError', (e) => errors.push(e))
    await engine.joinDoc('d1')

    // Human rewrites the start of the sentence in the browser.
    server.remoteEdit('d1', [{ p: 0, d: 'The quick' }, { p: 0, i: 'A slow' }])
    expect(engine.readDoc('d1')).toBe('A slow brown fox.')

    await engine.updateDoc('d1', (t) => t.replace('fox', 'dog'))

    expect(errors).toEqual([])
    expect(server.text('d1')).toBe('A slow brown dog.')
    expect(engine.readDoc('d1')).toBe(server.text('d1'))
    const sent = server.sock.emitsOf('applyOtUpdate')[0]!.args[1] as { v: number }
    expect(sent.v).toBe(2) // the version after the human's op, not the one we joined at
  })

  it('stays byte-identical to the server when human ops overtake an in-flight agent op', async () => {
    const server = new FakeOverleaf({ d1: 'alpha beta gamma' })
    const engine = await connectEngine(server)
    await engine.joinDoc('d1')

    server.holdAgentOps = true
    const write = engine.updateDoc('d1', (t) => t.replace('gamma', 'GAMMA!'))
    await opInFlight(server)
    // Both of these reach the server before the agent's op does.
    server.remoteEdit('d1', [{ p: 0, i: '>> ' }])
    server.remoteEdit('d1', [{ p: 9, d: 'beta ' }])
    server.flush()
    const result = await write

    expect(server.text('d1')).toBe('>> alpha GAMMA!')
    expect(engine.readDoc('d1')).toBe(server.text('d1'))
    expect(result.versionAfter).toBe(server.docs.get('d1')!.version)
    // Reconciled by transforming, not by falling back to a fresh joinDoc.
    expect(server.sock.emitsOf('joinDoc')).toHaveLength(1)
  })

  it('survives a randomized interleaving of human and agent edits without diverging', async () => {
    let seed = 42
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const server = new FakeOverleaf({ d1: 'lorem ipsum dolor sit amet, consectetur adipiscing elit' })
    const engine = await connectEngine(server)
    const errors: unknown[] = []
    server.sock.on('otUpdateError', (e) => errors.push(e))
    await engine.joinDoc('d1')

    const humanEdit = () => {
      const text = server.text('d1')
      const p = rand(text.length + 1)
      if (rand(2) === 0 || text.length < 4) server.remoteEdit('d1', [{ p, i: `h${rand(10)}` }])
      else {
        const q = Math.min(p, text.length - 2)
        server.remoteEdit('d1', [{ p: q, d: text.slice(q, q + 2) }])
      }
    }

    for (let round = 0; round < 150; round++) {
      server.holdAgentOps = rand(2) === 0
      const write = engine.updateDoc('d1', (t) => {
        const p = rand(t.length + 1)
        return rand(3) === 0 && t.length > 6
          ? t.slice(0, Math.min(p, t.length - 3)) + t.slice(Math.min(p, t.length - 3) + 3)
          : `${t.slice(0, p)}[a${round}]${t.slice(p)}`
      })
      if (server.holdAgentOps) await opInFlight(server)
      for (let k = rand(4); k > 0; k--) humanEdit()
      server.flush()
      await write
      expect(engine.readDoc('d1')).toBe(server.text('d1'))
    }
    expect(errors).toEqual([])
    expect(server.sock.emitsOf('joinDoc')).toHaveLength(1)
  })

  it('replays updates that overtake the joinDoc response and drops ones already in the snapshot', async () => {
    const server = new FakeOverleaf({ d1: 'abc' })
    const engine = await connectEngine(server)
    // Hold the joinDoc response open: the snapshot was taken at v2 ('abcX'),
    // and the broadcasts for v1 and v2 reach us before the response does.
    let respond!: (data: unknown[]) => void
    const original = server.sock.emitWithAck.bind(server.sock)
    server.sock.emitWithAck = (event, ...args) =>
      event === 'joinDoc' ? new Promise((r) => (respond = r)) : original(event, ...args)
    const joining = engine.joinDoc('d1')
    await new Promise((r) => setTimeout(r, 0))
    server.sock.simulate('otUpdateApplied', { doc: 'd1', op: [{ p: 3, i: 'X' }], v: 1, meta: { source: 'h', user_id: 'u', ts: 0 } })
    server.sock.simulate('otUpdateApplied', { doc: 'd1', op: [{ p: 4, i: 'Y' }], v: 2, meta: { source: 'h', user_id: 'u', ts: 0 } })
    respond([['abcX'], 2, []])
    const baseline = await joining
    expect(baseline.text).toBe('abcXY')
    expect(baseline.version).toBe(3)
  })

  it('serializes joinDoc RPCs (real-time fails a join that another join overtakes)', async () => {
    const server = new FakeOverleaf({ d1: 'one', d2: 'two' })
    const engine = await connectEngine(server)
    let active = 0
    let maxActive = 0
    const original = server.sock.emitWithAck.bind(server.sock)
    server.sock.emitWithAck = async (event, ...args) => {
      if (event !== 'joinDoc') return original(event, ...args)
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return original(event, ...args)
    }
    const [a, b] = await Promise.all([engine.joinDoc('d1'), engine.joinDoc('d2')])
    expect([a.text, b.text]).toEqual(['one', 'two'])
    expect(maxActive).toBe(1)
  })

  it('rejects the write when the server answers with otUpdateError', async () => {
    const server = new FakeOverleaf({ d1: 'hello' })
    const engine = await connectEngine(server)
    await engine.joinDoc('d1')
    server.sock.respondToEmit('applyOtUpdate', () => {
      queueMicrotask(() => server.sock.simulate('otUpdateError', 'Delete component does not match', { doc_id: 'd1' }))
      return [null]
    })
    await expect(engine.writeDoc('d1', 'hullo')).rejects.toThrow(/rejected the edit.*Delete component/)
    expect(engine.getBaseline('d1')).toBeUndefined() // next access rejoins
  })

  it('does not treat the applyOtUpdate ack as confirmation', async () => {
    const server = new FakeOverleaf({ d1: 'hello' })
    const engine = await connectEngine(server)
    await engine.joinDoc('d1')
    server.sock.respondToEmit('applyOtUpdate', () => [null]) // queued, never applied
    await expect(engine.writeDoc('d1', 'hello!')).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
  })

  it('rejoins after a version gap instead of applying ops to the wrong text', async () => {
    const server = new FakeOverleaf({ d1: 'hello' })
    const engine = await connectEngine(server)
    await engine.joinDoc('d1')
    server.remoteEdit('d1', [{ p: 5, i: ' there' }], { broadcast: false }) // we miss this one
    server.remoteEdit('d1', [{ p: 0, i: 'oh ' }])
    expect(engine.getBaseline('d1')).toBeUndefined()
    expect((await engine.joinDoc('d1')).text).toBe('oh hello there')
  })

  it('rejoins a seen doc in the background after a gap, so its changes are still reported', async () => {
    const server = new FakeOverleaf({ d1: 'hello' })
    const engine = await connectEngine(server)
    await engine.openDoc('d1') // the agent has looked at it
    server.remoteEdit('d1', [{ p: 5, i: ' there' }], { broadcast: false })
    server.remoteEdit('d1', [{ p: 0, i: 'oh ' }])
    await new Promise((r) => setTimeout(r, 0))
    const { docs } = engine.collectExternalChanges()
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ path: 'd1.tex', before: 'hello', after: 'oh hello there' })
  })

  it('a joinDoc that never answers times out instead of wedging later joins', async () => {
    const server = new FakeOverleaf({ d1: 'one', d2: 'two' })
    const engine = new OtEngine({ socket: server.sock, projectId: 'p1', joinTimeoutMs: 20 })
    const connecting = engine.connect()
    server.sock.simulate('joinProjectResponse', server.joinResponse())
    await connecting
    const original = server.sock.emitWithAck.bind(server.sock)
    server.sock.emitWithAck = (event, ...args) =>
      event === 'joinDoc' && args[0] === 'd1' ? new Promise(() => undefined) : original(event, ...args)
    const stuck = engine.joinDoc('d1')
    const next = engine.joinDoc('d2')
    await expect(stuck).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect((await next).text).toBe('two')
  })

  it('round-trips non-ASCII text', async () => {
    const server = new FakeOverleaf({ d1: 'naïve — café' })
    const engine = await connectEngine(server)
    expect((await engine.joinDoc('d1')).text).toBe('naïve — café')
    server.remoteEdit('d1', [{ p: 0, i: '𝛼 ' }])
    await engine.updateDoc('d1', (t) => t.replace('café', 'thé'))
    expect(server.text('d1')).toBe('𝛼 naïve — thé')
    expect(engine.readDoc('d1')).toBe(server.text('d1'))
  })
})
