import { describe, it, expect } from 'vitest'
import { OtEngine } from '../../src/overleaf/ot.js'
import { FakeSocket } from './fake-socket.js'
import type { JoinProjectResponse } from '../../src/overleaf/ot.types.js'

const minimalJoinResponse = (): JoinProjectResponse => ({
  project: {
    _id: 'p1',
    name: 'Test Project',
    rootDoc_id: 'd-main',
    rootFolder: [
      {
        _id: 'root',
        name: 'rootFolder',
        docs: [{ _id: 'd-main', name: 'main.tex' }],
        fileRefs: [{ _id: 'f-img', name: 'img.png' }],
        folders: [
          {
            _id: 'sub',
            name: 'chapters',
            docs: [{ _id: 'd-intro', name: 'intro.tex' }],
            fileRefs: [],
            folders: [],
          },
        ],
      },
    ],
  },
  permissionsLevel: 'owner',
  protocolVersion: 2,
  publicId: 'pubId-AGENT',
})

describe('OtEngine.connect', () => {
  it('emits joinProject and resolves once joinProjectResponse arrives', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })

    // Server-driven handshake: connection-accepted → joinProjectResponse arrives.
    const connectPromise = engine.connect()
    sock.simulate('connectionAccepted', null, 'pubId-AGENT')
    sock.simulate('joinProjectResponse', minimalJoinResponse())

    await connectPromise

    expect(engine.publicId).toBe('pubId-AGENT')
    expect(engine.isConnected).toBe(true)
  })

  it('exposes a flat path → entity index after handshake', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const connectPromise = engine.connect()
    sock.simulate('connectionAccepted', null, 'pubId-AGENT')
    sock.simulate('joinProjectResponse', minimalJoinResponse())
    await connectPromise

    expect(engine.pathToDocId('main.tex')).toBe('d-main')
    expect(engine.pathToDocId('chapters/intro.tex')).toBe('d-intro')
    expect(engine.pathToFileId('img.png')).toBe('f-img')
    expect(engine.pathToDocId('missing.tex')).toBeNull()
    expect(engine.pathToFileId('missing.png')).toBeNull()
  })

  it('exposes the same TreeNode shape as v0.1 (files + folders)', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const connectPromise = engine.connect()
    sock.simulate('connectionAccepted', null, 'pubId-AGENT')
    sock.simulate('joinProjectResponse', minimalJoinResponse())
    await connectPromise

    const tree = engine.getTree()
    expect(tree.files.sort()).toEqual(['img.png', 'main.tex'])
    expect(Object.keys(tree.folders)).toEqual(['chapters'])
    expect(tree.folders.chapters!.files).toEqual(['intro.tex'])
  })

  it('connect() rejects on connectionRejected', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const connectPromise = engine.connect()
    sock.simulate('connectionRejected', { message: 'cookie expired' })
    await expect(connectPromise).rejects.toThrow(/cookie expired/)
  })

  it('disconnect() flips isConnected and unregisters listeners', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const cp = engine.connect()
    sock.simulate('connectionAccepted', null, 'pubId-AGENT')
    sock.simulate('joinProjectResponse', minimalJoinResponse())
    await cp
    engine.disconnect()
    expect(engine.isConnected).toBe(false)
    expect(sock.disconnected).toBe(true)
  })
})
