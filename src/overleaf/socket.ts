// Socket.IO connection wrapper inspired by Overleaf-Workshop
// (https://github.com/iamhyc/Overleaf-Workshop), specifically
// the v0.9 fork wiring in src/api/socketio.ts. Used under AGPL-3.0-or-later.
import io from 'socket.io-client'
import { NetworkError } from '../errors.js'

export interface OverleafSocketOptions {
  url: string
  projectId: string
  sessionCookie: string
  extraHeaders: Record<string, string>
}

/**
 * Minimal interface the OT engine depends on. Lets us swap a FakeSocket
 * (test/unit/fake-socket.ts) for the real OverleafSocket in unit tests.
 */
export interface SocketLike {
  emit(event: string, ...args: unknown[]): void
  emitWithAck(event: string, ...args: unknown[]): Promise<unknown[]>
  on(event: string, handler: (...args: unknown[]) => void): void
  off(event: string, handler: (...args: unknown[]) => void): void
  disconnect(): void
}

/**
 * Wraps github:overleaf/socket.io-client#0.9.17-overleaf-5.
 *
 * Connects to <url>?projectId=<id>&t=<timestamp> with auth headers threaded
 * via extraHeaders (cookie + origin + user-supplied — same headers the REST
 * layer threads in v0.1). Promisifies emit-with-ack so callers `await
 * sock.emitWithAck('joinDoc', docId, opts)`.
 *
 * Construction immediately opens the socket. Use disconnect() on shutdown.
 */
export class OverleafSocket implements SocketLike {
  private readonly raw: ReturnType<typeof io.connect>

  constructor(
    private readonly opts: OverleafSocketOptions,
    connectFn: typeof io.connect = io.connect,
  ) {
    const url = `${opts.url}?projectId=${encodeURIComponent(opts.projectId)}&t=${Date.now()}`
    const origin = new URL(opts.url).origin
    this.raw = connectFn(url, {
      'force new connection': true,
      reconnect: false, // we manage reconnection in OtEngine
      transports: ['websocket', 'xhr-polling'],
      extraHeaders: {
        Cookie: opts.sessionCookie,
        Origin: origin,
        ...opts.extraHeaders,
      },
    })
  }

  emit(event: string, ...args: unknown[]): void {
    this.raw.emit(event, ...args)
  }

  /**
   * Emit an event and await its ack. The v0.9 ack signature is
   * `(err, ...data) => void`; we resolve with `data` (an array) and reject
   * with `err` if non-null.
   */
  emitWithAck(event: string, ...args: unknown[]): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const ack = (err: unknown, ...data: unknown[]): void => {
        if (err) {
          reject(err instanceof Error ? err : new NetworkError(String((err as { message?: string })?.message ?? err)))
        } else {
          resolve(data)
        }
      }
      this.raw.emit(event, ...args, ack)
    })
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    this.raw.on(event, handler)
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    // The v0.9 fork's EventEmitter exposes removeListener, not off.
    this.raw.removeListener(event, handler)
  }

  disconnect(): void {
    this.raw.disconnect()
  }
}
