import { describe, it, expect } from 'vitest'
import { OtEngine } from '../../src/overleaf/ot.js'
import { FakeSocket } from './fake-socket.js'
import type { JoinProjectResponse, UpdateSchema } from '../../src/overleaf/ot.types.js'

const tinyJoin = (): JoinProjectResponse => ({
  project: {
    _id: 'p1',
    name: 'Test',
    rootDoc_id: 'd1',
    rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [{ _id: 'd1', name: 'main.tex' }], fileRefs: [], folders: [] }],
  },
  permissionsLevel: 'owner',
  protocolVersion: 2,
  publicId: 'pub-AGENT',
})

async function readyEngine() {
  const sock = new FakeSocket()
  const engine = new OtEngine({ socket: sock, projectId: 'p1' })
  const cp = engine.connect()
  sock.simulate('connectionAccepted', null, 'pub-AGENT')
  sock.simulate('joinProjectResponse', tinyJoin())
  await cp
  sock.respondToEmit('joinDoc', () => [null, ['hello'], 4, []])
  await engine.joinDoc('d1')
  return { sock, engine }
}

describe('OtEngine.writeDoc', () => {
  it('no-ops when newContent equals baseline', async () => {
    const { sock, engine } = await readyEngine()
    await engine.writeDoc('d1', 'hello')
    expect(sock.emitsOf('applyOtUpdate')).toHaveLength(0)
    expect(engine.readDoc('d1')).toBe('hello')
  })

  it('emits applyOtUpdate with computed ops, awaits ack, advances baseline on echo', async () => {
    const { sock, engine } = await readyEngine()

    sock.respondToEmit('applyOtUpdate', (_docId, _update) => {
      // Simulate server immediately echoing the update back tagged with our publicId.
      queueMicrotask(() => {
        const echo: UpdateSchema = {
          doc: 'd1',
          op: [{ p: 5, i: ' world' }],
          v: 4, // server version BEFORE this update; baseline bumps to 5
          meta: { source: 'pub-AGENT', ts: Date.now(), user_id: 'u1' },
        }
        sock.simulate('otUpdateApplied', echo)
      })
      return [null] // ack ok
    })

    await engine.writeDoc('d1', 'hello world')

    const emit = sock.emitsOf('applyOtUpdate')[0]!
    expect(emit.args[0]).toBe('d1')
    const update = emit.args[1] as UpdateSchema
    expect(update.doc).toBe('d1')
    expect(update.op).toEqual([{ p: 5, i: ' world' }])
    expect(update.v).toBe(4)
    expect(engine.readDoc('d1')).toBe('hello world')
    // version advanced
    const baseline = (engine as unknown as { baselines: Map<string, { version: number }> }).baselines.get('d1')!
    expect(baseline.version).toBe(5)
  })

  it('ignores otUpdateApplied broadcasts from other clients', async () => {
    const { sock, engine } = await readyEngine()
    // Start a write but do not ack/echo for our publicId
    sock.respondToEmit('applyOtUpdate', () => {
      queueMicrotask(() => {
        // First simulate a foreign client's update — should NOT advance our baseline.
        sock.simulate('otUpdateApplied', {
          doc: 'd1',
          op: [{ p: 0, i: '!' }],
          v: 4,
          meta: { source: 'pub-OTHER', ts: 0, user_id: 'u2' },
        })
        // Then our own echo arrives.
        sock.simulate('otUpdateApplied', {
          doc: 'd1',
          op: [{ p: 5, i: ' world' }],
          v: 4,
          meta: { source: 'pub-AGENT', ts: 0, user_id: 'u1' },
        })
      })
      return [null]
    })
    await engine.writeDoc('d1', 'hello world')
    expect(engine.readDoc('d1')).toBe('hello world')
  })

  it('joinDoc lazily on writeDoc when no baseline exists', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const cp = engine.connect()
    sock.simulate('connectionAccepted', null, 'pub-AGENT')
    sock.simulate('joinProjectResponse', tinyJoin())
    await cp

    sock.respondToEmit('joinDoc', () => [null, ['hello'], 4, []])
    sock.respondToEmit('applyOtUpdate', () => {
      queueMicrotask(() => sock.simulate('otUpdateApplied', {
        doc: 'd1',
        op: [{ p: 5, i: '!' }],
        v: 4,
        meta: { source: 'pub-AGENT', ts: 0, user_id: 'u1' },
      }))
      return [null]
    })

    await engine.writeDoc('d1', 'hello!')
    expect(sock.emitsOf('joinDoc')).toHaveLength(1)
    expect(engine.readDoc('d1')).toBe('hello!')
  })
})

describe('OtEngine never emits clientTracking', () => {
  it('writeDoc + joinDoc + tree-event handling never emit clientTracking.updatePosition', async () => {
    const { sock, engine } = await readyEngine()
    sock.respondToEmit('applyOtUpdate', () => {
      queueMicrotask(() => sock.simulate('otUpdateApplied', {
        doc: 'd1',
        op: [{ p: 5, i: '!' }],
        v: 4,
        meta: { source: 'pub-AGENT', ts: 0, user_id: 'u' },
      }))
      return [null]
    })
    await engine.writeDoc('d1', 'hello!')
    sock.simulate('reciveNewDoc', 'root', { _id: 'd2', name: 'extra.tex' })

    expect(sock.emitsOf('clientTracking.updatePosition')).toHaveLength(0)
    expect(sock.emitsOf('clientTracking.getConnectedUsers')).toHaveLength(0)
  })
})
