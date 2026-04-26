import { describe, it, expect } from 'vitest'
import { OtEngine } from '../../src/overleaf/ot.js'
import { FakeSocket } from './fake-socket.js'
import type { JoinProjectResponse } from '../../src/overleaf/ot.types.js'

const join = (): JoinProjectResponse => ({
  project: {
    _id: 'p1',
    name: 'Test',
    rootDoc_id: 'd1',
    rootFolder: [
      {
        _id: 'root',
        name: 'rootFolder',
        docs: [{ _id: 'd1', name: 'main.tex' }],
        fileRefs: [{ _id: 'f1', name: 'figure.png' }],
        folders: [
          { _id: 'subA', name: 'subA', docs: [], fileRefs: [], folders: [] },
        ],
      },
    ],
  },
  permissionsLevel: 'owner',
  protocolVersion: 2,
  publicId: 'pub',
})

async function ready() {
  const sock = new FakeSocket()
  const engine = new OtEngine({ socket: sock, projectId: 'p1' })
  const cp = engine.connect()
  sock.simulate('connectionAccepted', null, 'pub')
  sock.simulate('joinProjectResponse', join())
  await cp
  return { sock, engine }
}

describe('OtEngine tree events', () => {
  it('reciveNewDoc adds a new doc under the parent folder', async () => {
    const { sock, engine } = await ready()
    sock.simulate('reciveNewDoc', 'root', { _id: 'd2', name: 'extra.tex' })
    expect(engine.pathToDocId('extra.tex')).toBe('d2')
    expect(engine.getTree().files.sort()).toEqual(['extra.tex', 'figure.png', 'main.tex'])
  })

  it('reciveNewFile adds a new fileRef', async () => {
    const { sock, engine } = await ready()
    sock.simulate('reciveNewFile', 'root', { _id: 'f2', name: 'logo.svg' })
    expect(engine.pathToFileId('logo.svg')).toBe('f2')
  })

  it('reciveNewFolder adds an empty folder', async () => {
    const { sock, engine } = await ready()
    sock.simulate('reciveNewFolder', 'root', { _id: 'subB', name: 'subB', docs: [], fileRefs: [], folders: [] })
    expect(Object.keys(engine.getTree().folders).sort()).toEqual(['subA', 'subB'])
  })

  it('reciveEntityRename renames a doc and re-indexes the path', async () => {
    const { sock, engine } = await ready()
    sock.simulate('reciveEntityRename', 'd1', 'main-renamed.tex')
    expect(engine.pathToDocId('main.tex')).toBeNull()
    expect(engine.pathToDocId('main-renamed.tex')).toBe('d1')
  })

  it('reciveEntityMove moves a doc to a new parent folder', async () => {
    const { sock, engine } = await ready()
    sock.simulate('reciveEntityMove', 'd1', 'subA')
    expect(engine.pathToDocId('main.tex')).toBeNull()
    expect(engine.pathToDocId('subA/main.tex')).toBe('d1')
  })

  it('removeEntity drops the doc from the index and tree', async () => {
    const { sock, engine } = await ready()
    sock.simulate('removeEntity', 'd1')
    expect(engine.pathToDocId('main.tex')).toBeNull()
    expect(engine.getTree().files).toEqual(['figure.png'])
  })

  it('removeEntity also clears the cached baseline', async () => {
    const { sock, engine } = await ready()
    sock.respondToEmit('joinDoc', () => [null, ['hello'], 0, []])
    await engine.joinDoc('d1')
    expect(engine.readDoc('d1')).toBe('hello')

    sock.simulate('removeEntity', 'd1')
    expect(engine.readDoc('d1')).toBeNull()
  })
})
