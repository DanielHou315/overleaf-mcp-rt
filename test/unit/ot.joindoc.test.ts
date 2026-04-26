import { describe, it, expect } from 'vitest'
import { OtEngine } from '../../src/overleaf/ot.js'
import { FakeSocket } from './fake-socket.js'
import type { JoinProjectResponse } from '../../src/overleaf/ot.types.js'

function utfToLatin1Lines(text: string): string[] {
  // Mirror what Overleaf does: bytes treated as latin1 chars, split on \n.
  const bytes = Buffer.from(text, 'utf-8')
  const latin1 = bytes.toString('latin1')
  return latin1.split('\n')
}

const tinyJoin = (): JoinProjectResponse => ({
  project: {
    _id: 'p1',
    name: 'Test',
    rootDoc_id: 'd1',
    rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [{ _id: 'd1', name: 'main.tex' }], fileRefs: [], folders: [] }],
  },
  permissionsLevel: 'owner',
  protocolVersion: 2,
  publicId: 'pub',
})

describe('OtEngine.joinDoc', () => {
  it('emits joinDoc with encodeRanges and caches the baseline', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const cp = engine.connect()
    sock.simulate('connectionAccepted', null, 'pub')
    sock.simulate('joinProjectResponse', tinyJoin())
    await cp

    const lines = utfToLatin1Lines('\\section{α}\nHello.\n')
    sock.respondToEmit('joinDoc', () => [null, lines, 7, []])

    const baseline = await engine.joinDoc('d1')

    expect(baseline.docId).toBe('d1')
    expect(baseline.version).toBe(7)
    expect(baseline.text).toBe('\\section{α}\nHello.\n')
    expect(sock.emitsOf('joinDoc')[0]!.args).toEqual(['d1', { encodeRanges: true }])
  })

  it('caches; second joinDoc returns the same baseline without re-emitting', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const cp = engine.connect()
    sock.simulate('connectionAccepted', null, 'pub')
    sock.simulate('joinProjectResponse', tinyJoin())
    await cp

    sock.respondToEmit('joinDoc', () => [null, ['hi'], 1, []])
    const a = await engine.joinDoc('d1')
    const b = await engine.joinDoc('d1')
    expect(a).toBe(b)
    expect(sock.emitsOf('joinDoc')).toHaveLength(1)
  })

  it('coalesces concurrent joinDoc calls for the same docId', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const cp = engine.connect()
    sock.simulate('connectionAccepted', null, 'pub')
    sock.simulate('joinProjectResponse', tinyJoin())
    await cp

    sock.respondToEmit('joinDoc', () => [null, ['x'], 0, []])
    const [a, b] = await Promise.all([engine.joinDoc('d1'), engine.joinDoc('d1')])
    expect(a).toBe(b)
    expect(sock.emitsOf('joinDoc')).toHaveLength(1)
  })

  it('decodes UTF-8 lines from the server\'s latin1 packing correctly', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const cp = engine.connect()
    sock.simulate('connectionAccepted', null, 'pub')
    sock.simulate('joinProjectResponse', tinyJoin())
    await cp

    const original = 'αβγ\n中文\n'
    sock.respondToEmit('joinDoc', () => [null, utfToLatin1Lines(original), 0, []])
    const baseline = await engine.joinDoc('d1')
    expect(baseline.text).toBe(original)
  })

  it('readDoc returns cached text after joinDoc', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const cp = engine.connect()
    sock.simulate('connectionAccepted', null, 'pub')
    sock.simulate('joinProjectResponse', tinyJoin())
    await cp

    sock.respondToEmit('joinDoc', () => [null, ['hello'], 4, []])
    await engine.joinDoc('d1')
    expect(engine.readDoc('d1')).toBe('hello')
    expect(engine.readDoc('does-not-exist')).toBeNull()
  })
})
