import { describe, it, expect } from 'vitest'
import { OtEngine } from '../../src/overleaf/ot.js'
import { FakeSocket } from './fake-socket.js'
import type { JoinProjectResponse, UpdateSchema } from '../../src/overleaf/ot.types.js'

const join = (): JoinProjectResponse => ({
  project: {
    _id: 'p1', name: 'Test', rootDoc_id: 'd1',
    rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [{ _id: 'd1', name: 'main.tex' }], fileRefs: [], folders: [] }],
  },
  permissionsLevel: 'owner', protocolVersion: 2, publicId: 'pub-AGENT',
})

describe('OtEngine concurrent writes are serialized per docId', () => {
  it('two concurrent writeDoc calls produce sequential applyOtUpdate emits with correct version chain', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const cp = engine.connect()
    sock.simulate('connectionAccepted', null, 'pub-AGENT')
    sock.simulate('joinProjectResponse', join())
    await cp

    sock.respondToEmit('joinDoc', () => [null, ['hello'], 0, []])
    await engine.joinDoc('d1')

    // Capture the order of applyOtUpdate emits and their version numbers.
    const seenVersions: number[] = []
    sock.respondToEmit('applyOtUpdate', (_docId, update) => {
      const u = update as UpdateSchema
      seenVersions.push(u.v)
      return [null]
    })

    // Fire two concurrent writes against the same doc.
    const p1 = engine.writeDoc('d1', 'hello a')
    const p2 = engine.writeDoc('d1', 'hello a b')
    await Promise.all([p1, p2])

    // Both writes must have completed (no hang). The second saw the
    // baseline produced by the first, so the version emitted for the
    // second update must be exactly one greater than the first.
    expect(seenVersions.length).toBe(2)
    expect(seenVersions[1]).toBe(seenVersions[0]! + 1)
  })

  it('concurrent writes against different docIds are NOT serialized against each other', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const cp = engine.connect()
    sock.simulate('connectionAccepted', null, 'pub-AGENT')
    sock.simulate('joinProjectResponse', { ...join(), project: { ...join().project,
      rootFolder: [{ _id: 'root', name: 'rootFolder',
        docs: [{ _id: 'd1', name: 'main.tex' }, { _id: 'd2', name: 'b.tex' }],
        fileRefs: [], folders: [] }] } })
    await cp

    sock.respondToEmit('joinDoc', (docId) => [null, [docId === 'd1' ? 'a' : 'b'], 0, []])

    let inflight = 0
    let maxInflight = 0
    sock.respondToEmit('applyOtUpdate', () => {
      inflight += 1
      maxInflight = Math.max(maxInflight, inflight)
      // Defer ack to the next microtask so a SECOND emit can land before the first acks.
      queueMicrotask(() => { inflight -= 1 })
      return [null]
    })

    const p1 = engine.writeDoc('d1', 'aX')
    const p2 = engine.writeDoc('d2', 'bY')
    await Promise.all([p1, p2])

    // Per-doc serialization must NOT block cross-doc concurrency.
    expect(maxInflight).toBeGreaterThanOrEqual(2)
  })
})
