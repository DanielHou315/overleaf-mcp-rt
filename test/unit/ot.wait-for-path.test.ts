import { describe, it, expect } from 'vitest'
import { OtEngine } from '../../src/overleaf/ot.js'
import { FakeSocket } from './fake-socket.js'
import type { JoinProjectResponse } from '../../src/overleaf/ot.types.js'

const join = (): JoinProjectResponse => ({
  project: {
    _id: 'p1',
    name: 'Test',
    rootDoc_id: 'd-main',
    rootFolder: [{
      _id: 'root',
      name: 'rootFolder',
      docs: [{ _id: 'd-main', name: 'main.tex' }],
      fileRefs: [],
      folders: [],
    }],
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

describe('OtEngine.waitForPath', () => {
  it('resolves immediately when the path already exists', async () => {
    const { engine } = await ready()
    const t0 = Date.now()
    const entity = await engine.waitForPath('main.tex')
    const elapsed = Date.now() - t0
    expect(entity).toEqual({ kind: 'doc', id: 'd-main' })
    expect(elapsed).toBeLessThan(50)
  })

  it('resolves after the recive event arrives', async () => {
    const { sock, engine } = await ready()
    // Path doesn't exist yet — start waiting
    const waitPromise = engine.waitForPath('extra.tex', 1000)
    // Simulate a mutation broadcast that adds the doc
    setTimeout(() => {
      sock.simulate('reciveNewDoc', 'root', { _id: 'd-extra', name: 'extra.tex' })
    }, 30)
    const entity = await waitPromise
    expect(entity).toEqual({ kind: 'doc', id: 'd-extra' })
  })

  it('rejects with a timeout error when the path never arrives', async () => {
    const { engine } = await ready()
    await expect(engine.waitForPath('never.tex', 50)).rejects.toThrow(/timed out/i)
  })

  it('resolves to a folder kind when the broadcast is reciveNewFolder', async () => {
    const { sock, engine } = await ready()
    const waitPromise = engine.waitForPath('newdir', 500)
    setTimeout(() => {
      sock.simulate('reciveNewFolder', 'root', {
        _id: 'newdir-id', name: 'newdir', docs: [], fileRefs: [], folders: [],
      })
    }, 20)
    expect(await waitPromise).toEqual({ kind: 'folder', id: 'newdir-id' })
  })
})
