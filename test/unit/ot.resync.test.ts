import { describe, it, expect } from 'vitest'
import { OtEngine } from '../../src/overleaf/ot.js'
import { OtVersionConflictError } from '../../src/errors.js'
import { FakeSocket } from './fake-socket.js'
import type { JoinProjectResponse } from '../../src/overleaf/ot.types.js'

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

async function ready() {
  const sock = new FakeSocket()
  const engine = new OtEngine({ socket: sock, projectId: 'p1' })
  const cp = engine.connect()
  sock.simulate('connectionAccepted', null, 'pub-AGENT')
  sock.simulate('joinProjectResponse', tinyJoin())
  await cp
  return { sock, engine }
}

describe('OtEngine resync on version conflict', () => {
  it('re-joinDocs and retries once on version mismatch ack', async () => {
    const { sock, engine } = await ready()
    let joinDocCalls = 0
    sock.respondToEmit('joinDoc', () => {
      joinDocCalls += 1
      // First join: version 4, text 'hello'. Second join (post-conflict):
      // version 6, text 'hello!' (someone else added an exclamation point).
      if (joinDocCalls === 1) return [null, ['hello'], 4, []]
      return [null, ['hello!'], 6, []]
    })
    await engine.joinDoc('d1')

    let applyCalls = 0
    sock.respondToEmit('applyOtUpdate', () => {
      applyCalls += 1
      if (applyCalls === 1) {
        // Simulate version-mismatch error
        return [{ message: 'version mismatch', code: 'OT_VERSION_MISMATCH' }]
      }
      // Second attempt — succeed and echo
      queueMicrotask(() => sock.simulate('otUpdateApplied', {
        doc: 'd1',
        op: [{ p: 6, i: ' world' }],
        v: 6,
        meta: { source: 'pub-AGENT', ts: 0, user_id: 'u1' },
      }))
      return [null]
    })

    await engine.writeDoc('d1', 'hello! world')
    expect(joinDocCalls).toBe(2)
    expect(applyCalls).toBe(2)
    expect(engine.readDoc('d1')).toBe('hello! world')
  })

  it('throws OtVersionConflictError when the second attempt also fails', async () => {
    const { sock, engine } = await ready()
    sock.respondToEmit('joinDoc', () => [null, ['hello'], 4, []])
    await engine.joinDoc('d1')

    sock.respondToEmit('applyOtUpdate', () => [{ message: 'still conflicting' }])

    await expect(engine.writeDoc('d1', 'hello world')).rejects.toBeInstanceOf(OtVersionConflictError)
  })
})
