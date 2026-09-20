import { describe, it, expect } from 'vitest'
import { OtEngine, OtEngineRegistry } from '../../src/overleaf/ot.js'
import { FakeOverleaf } from './fake-overleaf.js'

/**
 * Found by the live matrix: Overleaf 3.x answers joinProject with an ack and
 * never pushes joinProjectResponse, so connect() waited forever and the tool
 * call hung until the MCP client gave up. A proxy that swallows /socket.io
 * looks the same from here.
 */
describe('OtEngine.connect when the server never completes the handshake', () => {
  it('fails with an error that says what to check, instead of hanging', async () => {
    const server = new FakeOverleaf({ d1: 'x' })
    const engine = new OtEngine({ socket: server.sock, projectId: 'p1', connectTimeoutMs: 30 })
    const connecting = engine.connect()
    server.sock.simulate('connectionAccepted', null, 'pub-AGENT') // accepted, but the project never arrives
    await expect(connecting).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    await expect(connecting).rejects.toThrow(/not established within 30ms.*\/socket\.io.*4\.x or later/s)
    expect(engine.isConnected).toBe(false)
  })

  it('ignores a handshake that completes after it gave up', async () => {
    const server = new FakeOverleaf({ d1: 'x' })
    const engine = new OtEngine({ socket: server.sock, projectId: 'p1', connectTimeoutMs: 20 })
    await expect(engine.connect()).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    server.sock.simulate('connectionAccepted', null, 'pub-AGENT')
    server.sock.simulate('joinProjectResponse', server.joinResponse())
    expect(engine.isConnected).toBe(false)
  })

  it('does not time out a handshake that completed', async () => {
    const server = new FakeOverleaf({ d1: 'x' })
    const engine = new OtEngine({ socket: server.sock, projectId: 'p1', connectTimeoutMs: 20 })
    const connecting = engine.connect()
    server.sock.simulate('connectionAccepted', null, 'pub-AGENT')
    server.sock.simulate('joinProjectResponse', server.joinResponse())
    await connecting
    await new Promise((r) => setTimeout(r, 40))
    expect(engine.isConnected).toBe(true)
  })

  it('is not cached by the registry: the next call tries again', async () => {
    const servers: FakeOverleaf[] = []
    const registry = new OtEngineRegistry(() => {
      const server = new FakeOverleaf({ d1: 'x' })
      servers.push(server)
      return { socket: server.sock, connectTimeoutMs: 20 }
    })
    await expect(registry.get('p1')).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect(registry.peek('p1')).toBeUndefined()
    expect(servers[0]!.sock.disconnected).toBe(true)

    const second = registry.get('p1')
    await new Promise((r) => setTimeout(r, 0))
    servers[1]!.sock.simulate('connectionAccepted', null, 'pub-AGENT')
    servers[1]!.sock.simulate('joinProjectResponse', servers[1]!.joinResponse())
    expect((await second).isConnected).toBe(true)
  })
})
