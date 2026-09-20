export type ErrorCode =
  | 'OVERLEAF_GENERIC'
  | 'OVERLEAF_AUTH_FAILED'
  | 'PROXY_AUTH_FAILED'
  | 'PROJECT_ACCESS_DENIED'
  | 'NETWORK_ERROR'
  | 'INVALID_CONFIG'
  | 'NOT_FOUND'
  | 'OT_DELETE_MISMATCH'
  | 'OT_VERSION_DRIFT'
  | 'EDIT_NO_MATCH'
  | 'EDIT_AMBIGUOUS'
  | 'DOC_CHANGED_EXTERNALLY'
  | 'DOC_NOT_READ'
  | 'COMMENTS_UNSUPPORTED'
  | 'HISTORY_OT_WRITES_DISABLED'
  | 'HISTORY_OT_MISMATCH'

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

export class EditNoMatchError extends OverleafError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super('EDIT_NO_MATCH', message, context)
  }
}

export class EditAmbiguousError extends OverleafError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super('EDIT_AMBIGUOUS', message, context)
  }
}

export class DocChangedExternallyError extends OverleafError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super('DOC_CHANGED_EXTERNALLY', message, context)
  }
}

export class CommentsUnsupportedError extends OverleafError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super('COMMENTS_UNSUPPORTED', message, context)
  }
}

export class HistoryOtWritesDisabledError extends OverleafError {
  constructor(context: Record<string, unknown> = {}) {
    super(
      'HISTORY_OT_WRITES_DISABLED',
      'This project uses Overleaf\'s newer document format (history-OT). Reading works; writing to it is switched off by default because it has not been verified against overleaf.com yet. Nothing was changed.',
      context,
    )
  }
}

export class HistoryOtMismatchError extends OverleafError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super('HISTORY_OT_MISMATCH', message, context)
  }
}

export class DocNotReadError extends OverleafError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super('DOC_NOT_READ', message, context)
  }
}

const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set([
  'NETWORK_ERROR',
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
  EDIT_NO_MATCH:
    'old_string must match the current doc text. If collaborators edited the doc, the external-changes block in this response shows what moved; otherwise re-read the region with overleaf_read_doc_range and copy the text exactly.',
  EDIT_AMBIGUOUS:
    'Include more surrounding text in old_string so it identifies one location, or set replace_all to change every occurrence.',
  DOC_CHANGED_EXTERNALLY:
    'A collaborator edited this doc after you last read it; the external-changes block in this response shows their edits. Nothing was written. Use overleaf_edit_doc (it targets text, so it composes with their edits) or merge their changes into your content and retry.',
  COMMENTS_UNSUPPORTED:
    'Comments are not available here: either this is a stock Community Edition (no review panel — overleaf.com and Server Pro have one), or the project uses Overleaf\'s newer document format (history-OT), where this server can read and edit text but not yet attach comments. Nothing was changed. Put the note in the text as a LaTeX comment (% ...) instead.',
  HISTORY_OT_WRITES_DISABLED:
    'Tell the user: their project is on Overleaf\'s newer document format, which this tool can read but only edits when they opt in, by starting the MCP server with OVERLEAF_HISTORY_OT_WRITES=1 (see the README FAQ; first try it on a scratch file, ideally with nobody else in the doc). Until then, propose the change as text for them to paste.',
  HISTORY_OT_MISMATCH:
    'Stop editing this project and tell the user: after a write, Overleaf\'s copy of the document did not match what this tool expected, so its handling of the newer document format (history-OT) is wrong for this server. The document on Overleaf is intact as Overleaf stored it; re-read it to see the current text. Further writes to history-OT documents are refused for this session. Please report it.',
  DOC_NOT_READ:
    'Read the doc first (overleaf_read_doc) so you do not overwrite text you have not seen, or use overleaf_edit_doc for a targeted change. Pass overwrite=true to replace it regardless.',
  OVERLEAF_AUTH_FAILED:
    'The session cookie is invalid or expired. Run `overleaf-mcp-rt login` to refresh.',
  PROXY_AUTH_FAILED:
    'A reverse proxy (e.g. Cloudflare Access) blocked the request. Configure OVERLEAF_EXTRA_HEADERS.',
}

function hintFor(code: ErrorCode): string | undefined {
  return HINTS[code]
}
