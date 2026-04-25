export type ErrorCode =
  | 'OVERLEAF_GENERIC'
  | 'OVERLEAF_AUTH_FAILED'
  | 'PROXY_AUTH_FAILED'
  | 'PROJECT_ACCESS_DENIED'
  | 'NETWORK_ERROR'
  | 'INVALID_CONFIG'
  | 'NOT_FOUND'

export class OverleafError extends Error {
  readonly code: ErrorCode
  readonly context: Record<string, unknown>

  constructor(code: ErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(message)
    this.name = this.constructor.name
    this.code = code
    this.context = context
  }
}

export class AuthFailedError extends OverleafError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super('OVERLEAF_AUTH_FAILED', message, context)
  }
}

export class ProxyAuthFailedError extends OverleafError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super('PROXY_AUTH_FAILED', message, context)
  }
}

export class ProjectAccessDeniedError extends OverleafError {
  constructor(projectId: string) {
    super('PROJECT_ACCESS_DENIED', `No access to project ${projectId}`, { projectId })
  }
}

export class NetworkError extends OverleafError {
  constructor(message: string, public override readonly cause?: unknown) {
    super('NETWORK_ERROR', message, {})
  }
}

export class InvalidConfigError extends OverleafError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super('INVALID_CONFIG', message, context)
  }
}

export class NotFoundError extends OverleafError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super('NOT_FOUND', message, context)
  }
}
