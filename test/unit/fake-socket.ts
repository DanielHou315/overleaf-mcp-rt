import type { SocketLike } from '../../src/overleaf/socket.js'

/**
 * In-memory SocketLike for unit tests. Captures every emit + emitWithAck,
 * lets tests register ack responders per event, and lets tests synthesize
 * incoming events to exercise event-handler paths.
 *
 * Usage:
 *   const sock = new FakeSocket()
 *   sock.respondToEmit('joinProject', () => [null, joinProjectResponse])
 *   const engine = new OtEngine({ socket: sock, projectId: 'p1' })
 *   await engine.connect()
 *   sock.simulate('reciveNewDoc', 'parentId', { _id: 'd2', name: 'new.tex' })
 */
export class FakeSocket implements SocketLike {
  /** Every emit + emitWithAck call captured in order. */
  emits: Array<{ event: string; args: unknown[]; hadAck: boolean }> = []
  /** Per-event ack responder. The function receives the emit args (sans ack)
   *  and returns the ack tuple `[err, ...data]`. */
  private ackResponders = new Map<string, (...args: unknown[]) => unknown[]>()
  /** Default ack responder — receives event name + args, returns `[err, ...data]`. */
  private defaultAck?: (event: string, ...args: unknown[]) => unknown[]
  /** Registered listeners. */
  private handlers = new Map<string, Set<(...args: unknown[]) => void>>()
  disconnected = false

  emit(event: string, ...args: unknown[]): void {
    this.emits.push({ event, args, hadAck: false })
  }

  emitWithAck(event: string, ...args: unknown[]): Promise<unknown[]> {
    this.emits.push({ event, args, hadAck: true })
    const responder = this.ackResponders.get(event) ?? this.defaultAck
    if (!responder) {
      // Default: succeed with no data. Tests should usually register a responder.
      return Promise.resolve([])
    }
    const result = responder === this.defaultAck
      ? this.defaultAck!(event, ...args)
      : responder(...args)
    const [err, ...data] = result
    if (err) return Promise.reject(err)
    return Promise.resolve(data)
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    let set = this.handlers.get(event)
    if (!set) this.handlers.set(event, set = new Set())
    set.add(handler)
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    this.handlers.get(event)?.delete(handler)
  }

  disconnect(): void {
    this.disconnected = true
    this.simulate('disconnect')
  }

  // ---- test-only helpers ----

  /** Register an ack responder for a specific event. */
  respondToEmit(event: string, responder: (...args: unknown[]) => unknown[]): void {
    this.ackResponders.set(event, responder)
  }

  /** Register a default ack responder used when no per-event one matches. */
  setDefaultAck(responder: (event: string, ...args: unknown[]) => unknown[]): void {
    this.defaultAck = responder
  }

  /** Synthesize an incoming event from the server. */
  simulate(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.forEach((h) => h(...args))
  }

  /** All emits whose event name matches. */
  emitsOf(event: string): Array<{ event: string; args: unknown[]; hadAck: boolean }> {
    return this.emits.filter((e) => e.event === event)
  }
}
