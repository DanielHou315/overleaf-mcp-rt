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
})
