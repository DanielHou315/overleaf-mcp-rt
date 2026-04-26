export type ErrorCode =
  | 'OVERLEAF_GENERIC'
  | 'OVERLEAF_AUTH_FAILED'
  | 'PROXY_AUTH_FAILED'
  | 'PROJECT_ACCESS_DENIED'
  | 'NETWORK_ERROR'
  | 'INVALID_CONFIG'
  | 'NOT_FOUND'
  | 'OT_VERSION_CONFLICT'
  | 'OT_DELETE_MISMATCH'
  | 'OT_VERSION_DRIFT'

export interface ErrorEnvelope {
  code: ErrorCode
  message: string
  context: Record<string, unknown>
  retryable: boolean
  hint?: string
}

export class OverleafError extends Error {
  readonly code: ErrorCode
  readonly context: Record<string, unknown>

  constructor(code: ErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(message)
    this.name = this.constructor.name
    this.code = code
    this.context = context
  }

  toEnvelope(): ErrorEnvelope {
    return {
      code: this.code,
      message: this.message,
      context: this.context,
      retryable: isRetryable(this.code),
      hint: hintFor(this.code),
    }
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

export class OtVersionConflictError extends OverleafError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super('OT_VERSION_CONFLICT', message, context)
  }
}

export class OtDeleteMismatchError extends OverleafError {
  constructor(
    message: string,
    context: { p: number; expected: string; actual: string; opIndex: number },
  ) {
    super('OT_DELETE_MISMATCH', message, context)
  }
}

export class OtVersionDriftError extends OverleafError {
  constructor(
    message: string,
    context: { docId: string; expected: number; actual: number },
  ) {
    super('OT_VERSION_DRIFT', message, context)
  }
}

const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set([
  'NETWORK_ERROR',
  'OT_VERSION_CONFLICT',
  'OT_VERSION_DRIFT',
])

function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE_CODES.has(code)
}

const HINTS: Partial<Record<ErrorCode, string>> = {
  OT_DELETE_MISMATCH:
    'The d-string did not match the doc at position p. Re-read the doc to get the current text, then recompute offsets.',
  OT_VERSION_DRIFT:
    'The doc was modified concurrently. Re-read the doc and retry the edit.',
  OVERLEAF_AUTH_FAILED:
    'The session cookie is invalid or expired. Run `overleaf-mcp-rt login` to refresh.',
  PROXY_AUTH_FAILED:
    'A reverse proxy (e.g. Cloudflare Access) blocked the request. Configure OVERLEAF_EXTRA_HEADERS.',
}

function hintFor(code: ErrorCode): string | undefined {
  return HINTS[code]
}
