/**
 * Minimal ambient declaration for github:overleaf/socket.io-client#0.9.17-overleaf-5.
 * The fork ships untyped; we only depend on a small surface.
 */
declare module 'socket.io-client' {
  export interface ClientOptions {
    'force new connection'?: boolean
    reconnect?: boolean
    'reconnection limit'?: number
    'max reconnection attempts'?: number
    transports?: string[]
    extraHeaders?: Record<string, string>
    query?: string
  }

  export interface ClientSocket {
    emit(event: string, ...args: unknown[]): void
    on(event: string, handler: (...args: unknown[]) => void): void
    off(event: string, handler?: (...args: unknown[]) => void): void
    removeListener(event: string, handler?: (...args: unknown[]) => void): void
    disconnect(): void
    socket: { connected: boolean; connect: () => void }
    json: { emit(event: string, ...args: unknown[]): void }
  }

  export function connect(url: string, options?: ClientOptions): ClientSocket

  const _default: { connect: typeof connect }
  export default _default
}
