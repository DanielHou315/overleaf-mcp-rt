import { describe, it, expect, vi } from 'vitest'
import { OverleafSocket, type SocketLike } from '../../src/overleaf/socket.js'

describe('OverleafSocket', () => {
  it('builds the v2-scheme connection URL with projectId query', () => {
    const calls: Array<{ url: string; options: Record<string, unknown> }> = []
    const fakeConnect = vi.fn((url: string, options: Record<string, unknown>) => {
      calls.push({ url, options })
      return {
        emit: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        removeListener: vi.fn(),
        disconnect: vi.fn(),
        socket: { connected: false, connect: vi.fn() },
        json: { emit: vi.fn() },
      }
    })

    const sock = new OverleafSocket(
      {
        url: 'https://overleaf.example.com',
        projectId: 'p1',
        sessionCookie: 'overleaf_session2=abc',
        extraHeaders: { 'CF-Access-Client-Id': 'xyz' },
      },
      fakeConnect as unknown as typeof import('socket.io-client').connect,
    )
    void sock // construct only

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toMatch(/^https:\/\/overleaf\.example\.com\/?\?projectId=p1&t=\d+$/)
    const headers = calls[0]!.options.extraHeaders as Record<string, string>
    expect(headers.Cookie).toBe('overleaf_session2=abc')
    expect(headers.Origin).toBe('https://overleaf.example.com')
    expect(headers['CF-Access-Client-Id']).toBe('xyz')
  })

  it('emit-with-ack resolves with the ack args (skipping the err slot)', async () => {
    const onMap = new Map<string, (...args: unknown[]) => void>()
    const fakeRaw = {
      emit: vi.fn((event: string, ...args: unknown[]) => {
        // simulate immediate ack
        const ack = args[args.length - 1] as (...a: unknown[]) => void
        if (event === 'joinDoc') ack(null, ['line1', 'line2'], 7, [])
      }),
      on: vi.fn((e: string, h: (...args: unknown[]) => void) => onMap.set(e, h)),
      off: vi.fn(),
      removeListener: vi.fn(),
      disconnect: vi.fn(),
      socket: { connected: true, connect: vi.fn() },
      json: { emit: vi.fn() },
    }
    const fakeConnect = vi.fn(() => fakeRaw)
    const sock: SocketLike = new OverleafSocket(
      { url: 'http://o', projectId: 'p', sessionCookie: 'c', extraHeaders: {} },
      fakeConnect as unknown as typeof import('socket.io-client').connect,
    )

    const result = await sock.emitWithAck('joinDoc', 'd1', { encodeRanges: true })
    expect(result).toEqual([['line1', 'line2'], 7, []])
  })

  it('emit-with-ack rejects when ack carries an error', async () => {
    const fakeRaw = {
      emit: vi.fn((event: string, ...args: unknown[]) => {
        const ack = args[args.length - 1] as (...a: unknown[]) => void
        ack({ message: 'doc not found' })
      }),
      on: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
      disconnect: vi.fn(),
      socket: { connected: true, connect: vi.fn() },
      json: { emit: vi.fn() },
    }
    const fakeConnect = vi.fn(() => fakeRaw)
    const sock = new OverleafSocket(
      { url: 'http://o', projectId: 'p', sessionCookie: 'c', extraHeaders: {} },
      fakeConnect as unknown as typeof import('socket.io-client').connect,
    )
    await expect(sock.emitWithAck('joinDoc', 'd1')).rejects.toMatchObject({ message: 'doc not found' })
  })

  it('on() and off() forward to the underlying socket', () => {
    const onSpy = vi.fn()
    const offSpy = vi.fn()
    const fakeRaw = {
      emit: vi.fn(),
      on: onSpy,
      off: offSpy,
      removeListener: vi.fn(),
      disconnect: vi.fn(),
      socket: { connected: true, connect: vi.fn() },
      json: { emit: vi.fn() },
    }
    const sock = new OverleafSocket(
      { url: 'http://o', projectId: 'p', sessionCookie: 'c', extraHeaders: {} },
      vi.fn(() => fakeRaw) as unknown as typeof import('socket.io-client').connect,
    )
    const handler = () => {}
    sock.on('joinProjectResponse', handler)
    sock.off('joinProjectResponse', handler)
    expect(onSpy).toHaveBeenCalledWith('joinProjectResponse', handler)
    expect(offSpy).toHaveBeenCalledWith('joinProjectResponse', handler)
  })

  it('disconnect() closes the underlying socket', () => {
    const disconnectSpy = vi.fn()
    const fakeRaw = {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
      disconnect: disconnectSpy,
      socket: { connected: true, connect: vi.fn() },
      json: { emit: vi.fn() },
    }
    const sock = new OverleafSocket(
      { url: 'http://o', projectId: 'p', sessionCookie: 'c', extraHeaders: {} },
      vi.fn(() => fakeRaw) as unknown as typeof import('socket.io-client').connect,
    )
    sock.disconnect()
    expect(disconnectSpy).toHaveBeenCalled()
  })
})
