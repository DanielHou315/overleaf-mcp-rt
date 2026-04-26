import { describe, it, expect } from 'vitest'
import { OtEngine } from '../../src/overleaf/ot.js'
import { FakeSocket } from './fake-socket.js'
import type { JoinProjectResponse } from '../../src/overleaf/ot.types.js'

const join = (): JoinProjectResponse => ({
  project: {
    _id: 'p1',
    name: 'Test Project',
    rootDoc_id: 'd-main',
    rootFolder: [
      {
        _id: 'root',
        name: 'rootFolder',
        docs: [{ _id: 'd-main', name: 'main.tex' }],
        fileRefs: [{ _id: 'f-img', name: 'fig.png' }],
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
  publicId: 'pub',
})

async function ready() {
  const sock = new FakeSocket()
  const engine = new OtEngine({ socket: sock, projectId: 'p1' })
  const cp = engine.connect()
  sock.simulate('connectionAccepted', null, 'pub')
  sock.simulate('joinProjectResponse', join())
  await cp
  return engine
}

describe('OtEngine path lookup', () => {
  it('rootFolderId returns the root folder id from joinProjectResponse', async () => {
    const engine = await ready()
    expect(engine.rootFolderId).toBe('root')
  })

  it('rootFolderId is null before connect', () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    expect(engine.rootFolderId).toBeNull()
  })

  it('pathToEntity returns kind+id for docs, files, and nested docs', async () => {
    const engine = await ready()
    expect(engine.pathToEntity('main.tex')).toEqual({ kind: 'doc', id: 'd-main' })
    expect(engine.pathToEntity('fig.png')).toEqual({ kind: 'file', id: 'f-img' })
    expect(engine.pathToEntity('chapters/intro.tex')).toEqual({ kind: 'doc', id: 'd-intro' })
  })

  it('pathToEntity returns kind=folder for folders', async () => {
    const engine = await ready()
    expect(engine.pathToEntity('chapters')).toEqual({ kind: 'folder', id: 'sub' })
  })

  it('pathToEntity returns null for missing paths', async () => {
    const engine = await ready()
    expect(engine.pathToEntity('does-not-exist.tex')).toBeNull()
  })

  it('pathToFolderId returns id for a folder path; null for a non-folder path', async () => {
    const engine = await ready()
    expect(engine.pathToFolderId('chapters')).toBe('sub')
    expect(engine.pathToFolderId('main.tex')).toBeNull()
    expect(engine.pathToFolderId('does-not-exist')).toBeNull()
  })

  it('pathToFolderId("") returns the root folder id', async () => {
    const engine = await ready()
    expect(engine.pathToFolderId('')).toBe('root')
  })
})
