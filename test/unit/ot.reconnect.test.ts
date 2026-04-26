import { describe, it, expect, vi } from 'vitest'
import { OtEngine } from '../../src/overleaf/ot.js'
import { FakeSocket } from './fake-socket.js'
import type { JoinProjectResponse } from '../../src/overleaf/ot.types.js'

const join = (): JoinProjectResponse => ({
  project: {
    _id: 'p1', name: 'Test', rootDoc_id: 'd1',
    rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [{ _id: 'd1', name: 'main.tex' }], fileRefs: [], folders: [] }],
  },
  permissionsLevel: 'owner', protocolVersion: 2, publicId: 'pub',
})

describe('OtEngine reconnect', () => {
  it('on forceDisconnect, calls socketFactory and re-runs connect()', async () => {
    const sockets: FakeSocket[] = []
    const factory = vi.fn(() => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    })
    const engine = new OtEngine({
      socket: factory(),
      projectId: 'p1',
      socketFactory: factory,
      reconnectInitialDelayMs: 1,
    })
    const cp = engine.connect()
    sockets[0]!.simulate('connectionAccepted', null, 'pub')
    sockets[0]!.simulate('joinProjectResponse', join())
    await cp

    // forceDisconnect from server
    sockets[0]!.simulate('forceDisconnect', 'maintenance')

    // Engine should call factory again and emit a fresh joinProjectResponse handshake
    await new Promise((r) => setTimeout(r, 30))
    expect(factory).toHaveBeenCalledTimes(2)
    sockets[1]!.simulate('connectionAccepted', null, 'pub')
    sockets[1]!.simulate('joinProjectResponse', join())
    await new Promise((r) => setTimeout(r, 5))
    expect(engine.isConnected).toBe(true)
  })

  // Note: an earlier draft of v0.2 awaited an `otUpdateApplied` echo for own
  // writes and tracked pending awaiters in a map that needed cleanup on
  // reconnect. We dropped that path because Overleaf CE omits `meta.source`
  // for own-write echoes, which made the wait hang indefinitely. The
  // applyOtUpdate ack alone is the commit confirmation now (matching
  // Overleaf-Workshop's applyOtUpdate). Reconnect-during-write rejection
  // therefore relies on the v0.9 fork failing emitWithAck on disconnect,
  // which is the underlying ws library's behavior.

  it('drops baselines on reconnect (clients must re-joinDoc)', async () => {
    const sockets: FakeSocket[] = []
    const factory = vi.fn(() => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    })
    const engine = new OtEngine({
      socket: factory(),
      projectId: 'p1',
      socketFactory: factory,
      reconnectInitialDelayMs: 1,
    })
    const cp = engine.connect()
    sockets[0]!.simulate('connectionAccepted', null, 'pub')
    sockets[0]!.simulate('joinProjectResponse', join())
    await cp
    sockets[0]!.respondToEmit('joinDoc', () => [null, ['hello'], 0, []])
    await engine.joinDoc('d1')
    expect(engine.readDoc('d1')).toBe('hello')

    sockets[0]!.simulate('forceDisconnect', 'kick')
    await new Promise((r) => setTimeout(r, 30))
    sockets[1]!.simulate('connectionAccepted', null, 'pub')
    sockets[1]!.simulate('joinProjectResponse', join())
    await new Promise((r) => setTimeout(r, 5))

    expect(engine.readDoc('d1')).toBeNull()
  })

  it('applies jitter ∈ [0.5, 1.5) × base delay across attempts', async () => {
    const observed: number[] = []
    const sockets: FakeSocket[] = []
    const factory = vi.fn(() => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    })
    const engine = new OtEngine({
      socket: factory(),
      projectId: 'p1',
      socketFactory: factory,
      reconnectInitialDelayMs: 100,
      reconnectMaxAttempts: 5,
      schedule: (cb: () => void, ms: number) => {
        observed.push(ms)
        // Fire immediately so the test runs synchronously.
        return setTimeout(cb, 0)
      },
    } as any)
    const cp = engine.connect()
    sockets[0]!.simulate('connectionAccepted', null, 'pub')
    sockets[0]!.simulate('joinProjectResponse', join())
    await cp

    // Force three failed attempts: each fresh socket immediately rejects.
    for (let i = 1; i <= 3; i++) {
      sockets[i - 1]!.simulate('forceDisconnect', 'kick')
      // Wait for the next factory() call.
      await new Promise((r) => setTimeout(r, 5))
      // The new socket rejects — back to scheduling another attempt.
      sockets[i]?.simulate('connectionRejected', { message: 'still down' })
      await new Promise((r) => setTimeout(r, 5))
    }

    // We should have observed 3 scheduled delays. Each must be in
    // [0.5*base, 1.5*base) where base = 100 * 2^attemptIndex.
    expect(observed.length).toBeGreaterThanOrEqual(3)
    for (let i = 0; i < Math.min(observed.length, 3); i++) {
      const base = 100 * 2 ** i
      expect(observed[i]).toBeGreaterThanOrEqual(Math.floor(base * 0.5))
      expect(observed[i]).toBeLessThan(Math.ceil(base * 1.5))
    }
  })

  it('calls reconnectFailed callback when max attempts exhausted', async () => {
    const sockets: FakeSocket[] = []
    const factory = vi.fn(() => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    })
    const failed = vi.fn()
    const engine = new OtEngine({
      socket: factory(),
      projectId: 'p1',
      socketFactory: factory,
      reconnectInitialDelayMs: 1,
      reconnectMaxAttempts: 2,
      onReconnectFailed: failed,
    } as any)
    const cp = engine.connect()
    sockets[0]!.simulate('connectionAccepted', null, 'pub')
    sockets[0]!.simulate('joinProjectResponse', join())
    await cp

    // First disconnect → first reconnect attempt → it rejects → second attempt → also rejects → give up.
    sockets[0]!.simulate('forceDisconnect', 'flap')
    await new Promise((r) => setTimeout(r, 30))
    sockets[1]?.simulate('connectionRejected', { message: 'down' })
    await new Promise((r) => setTimeout(r, 30))
    sockets[2]?.simulate('connectionRejected', { message: 'still down' })
    await new Promise((r) => setTimeout(r, 30))

    expect(failed).toHaveBeenCalledTimes(1)
    expect(engine.isConnected).toBe(false)
  })
})
