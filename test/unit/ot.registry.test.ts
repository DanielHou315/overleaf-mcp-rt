import { describe, it, expect } from 'vitest'
import { OtEngineRegistry, type OtEngineFactory } from '../../src/overleaf/ot.js'
import { FakeSocket } from './fake-socket.js'
import type { JoinProjectResponse } from '../../src/overleaf/ot.types.js'

const join = (id: string): JoinProjectResponse => ({
  project: {
    _id: id, name: id, rootDoc_id: 'd', rootFolder: [{ _id: 'r', name: 'rootFolder', docs: [], fileRefs: [], folders: [] }],
  },
  permissionsLevel: 'owner', protocolVersion: 2, publicId: 'pub',
})

describe('OtEngineRegistry', () => {
  it('lazy-creates one engine per projectId, caches for subsequent gets', async () => {
    let createdSocks = 0
    const factory: OtEngineFactory = (projectId) => {
      createdSocks += 1
      const sock = new FakeSocket()
      // Auto-deliver handshake on construction
      queueMicrotask(() => {
        sock.simulate('connectionAccepted', null, 'pub')
        sock.simulate('joinProjectResponse', join(projectId))
      })
      return { socket: sock }
    }
    const reg = new OtEngineRegistry(factory)
    const a = await reg.get('p1')
    const b = await reg.get('p1')
    expect(a).toBe(b)
    expect(createdSocks).toBe(1)
  })

  it('separate projectIds get separate engines', async () => {
    const factory: OtEngineFactory = (projectId) => {
      const sock = new FakeSocket()
      queueMicrotask(() => {
        sock.simulate('connectionAccepted', null, 'pub')
        sock.simulate('joinProjectResponse', join(projectId))
      })
      return { socket: sock }
    }
    const reg = new OtEngineRegistry(factory)
    const a = await reg.get('p1')
    const b = await reg.get('p2')
    expect(a).not.toBe(b)
    expect(a.projectId).toBe('p1')
    expect(b.projectId).toBe('p2')
  })

  it('coalesces concurrent gets for the same projectId', async () => {
    let createdSocks = 0
    const factory: OtEngineFactory = (projectId) => {
      createdSocks += 1
      const sock = new FakeSocket()
      queueMicrotask(() => {
        sock.simulate('connectionAccepted', null, 'pub')
        sock.simulate('joinProjectResponse', join(projectId))
      })
      return { socket: sock }
    }
    const reg = new OtEngineRegistry(factory)
    const [a, b] = await Promise.all([reg.get('p1'), reg.get('p1')])
    expect(a).toBe(b)
    expect(createdSocks).toBe(1)
  })

  it('closeAll() disconnects every engine', async () => {
    const socks: FakeSocket[] = []
    const factory: OtEngineFactory = (projectId) => {
      const sock = new FakeSocket()
      socks.push(sock)
      queueMicrotask(() => {
        sock.simulate('connectionAccepted', null, 'pub')
        sock.simulate('joinProjectResponse', join(projectId))
      })
      return { socket: sock }
    }
    const reg = new OtEngineRegistry(factory)
    await reg.get('p1')
    await reg.get('p2')
    await reg.closeAll()
    expect(socks.every((s) => s.disconnected)).toBe(true)
  })
})
