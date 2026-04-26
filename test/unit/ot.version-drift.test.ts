import { describe, it, expect } from 'vitest'
import { OtEngine } from '../../src/overleaf/ot.js'
import { OtVersionDriftError } from '../../src/errors.js'
import { FakeSocket } from './fake-socket.js'
import type { JoinProjectResponse } from '../../src/overleaf/ot.types.js'

const tinyJoin = (): JoinProjectResponse => ({
  project: {
    _id: 'p1',
    name: 'Test',
    rootDoc_id: 'doc1',
    rootFolder: [{
      _id: 'root',
      name: 'rootFolder',
      docs: [{ _id: 'doc1', name: 'a.tex' }],
      fileRefs: [],
      folders: [],
    }],
  },
  permissionsLevel: 'owner',
  protocolVersion: 2,
  publicId: 'pubA',
})

describe('OtEngine version drift', () => {
  it('throws OtVersionDriftError when the server reports a higher version than the local baseline', async () => {
    const fake = new FakeSocket()
    const engine = new OtEngine({ socket: fake, projectId: 'p1' })
    const connect = engine.connect()
    fake.simulate('connectionAccepted', null, 'pubA')
    fake.simulate('joinProjectResponse', tinyJoin())
    await connect

    // First joinDoc returns version 5; after resync, joinDoc returns version 7.
    let joinDocCalls = 0
    fake.respondToEmit('joinDoc', () => {
      joinDocCalls += 1
      if (joinDocCalls === 1) return [null, ['hello'], 5, []]
      return [null, ['HELLO WORLD'], 7, []]
    })

    // Both applyOtUpdate calls fail with version mismatch — drift persists
    // through the resync, exhausting retries.
    fake.respondToEmit('applyOtUpdate', () => [{
      code: 'VersionMismatch',
      message: 'doc version drift',
    }])

    await expect(engine.applyOps('doc1', [{ p: 0, i: 'X' }]))
      .rejects.toBeInstanceOf(OtVersionDriftError)
  })
})
