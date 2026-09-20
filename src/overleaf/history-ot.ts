/**
 * Wire codec for Overleaf's "history-ot" document type.
 *
 * Overleaf is migrating projects (`overleaf.history.otMigrationStage` > 0) from
 * the ShareJS text type to the operation format of its history system
 * (`overleaf-editor-core`, AGPL-3.0, itself derived from ot.js by Tim Baumann,
 * MIT). For such a doc:
 *
 *   - joinDoc must be sent with `supportsHistoryOT: true`, or real-time refuses
 *     it ("client does not support history-ot");
 *   - the snapshot arrives as one raw object `{content, comments?, trackedChanges?}`
 *     instead of latin1-packed lines, and the response's 5th element is the type;
 *   - an update's `op` is a one-element array holding an *edit operation*: a
 *     text operation `{textOperation: [...]}` spanning the whole doc (positive
 *     number = retain, string = insert, negative number = remove; retains and
 *     inserts can also be objects carrying tracking / comment ids), or a comment
 *     operation, or a no-op.
 *
 * For plain text the two formats say the same thing, and the server breaks
 * insert/insert ties the same way in both (the op being transformed goes first:
 * ShareJS `transform(op, other, 'left')`, editor-core `transform(op, other)[0]`).
 * So the engine keeps working in ShareJS components — snapshot, in-flight
 * transform, external-change tracking all unchanged — and this module converts
 * at the socket. `history-ot.test.ts` checks that equivalence against a port of
 * the server's transform.
 *
 * Verified against the Overleaf 6.0.0 source (document-updater
 * HistoryOTUpdateManager, real-time WebsocketController.joinDoc,
 * overleaf-editor-core TextOperation / EditOperationBuilder).
 */
import type { OtOp } from './diff.js'
import { OverleafError } from '../errors.js'

export type OtType = 'sharejs-text-ot' | 'history-ot'

export type RawScanOp =
  | number
  | string
  | { r: number; tracking?: unknown }
  | { i: string; tracking?: unknown; commentIds?: string[] }

export interface RawTextOperation {
  textOperation: RawScanOp[]
  contentHash?: string
}

export interface RawCommentRange {
  pos: number
  length: number
}

export interface RawAddCommentOperation {
  commentId: string
  ranges: RawCommentRange[]
  resolved?: boolean
}

export type RawEditOperation =
  | RawTextOperation
  | RawAddCommentOperation
  | { deleteComment: string }
  | { commentId: string; resolved: boolean }
  | { noOp: true }

/** Raw StringFileData, as joinDoc returns it for a history-ot doc. */
export interface RawStringFileData {
  content: string
  comments?: Array<{ id: string; ranges: RawCommentRange[]; resolved?: boolean }>
  trackedChanges?: unknown[]
}

export function isRawStringFileData(value: unknown): value is RawStringFileData {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) &&
    typeof (value as { content?: unknown }).content === 'string'
  )
}

export function isTextOperation(op: unknown): op is RawTextOperation {
  return typeof op === 'object' && op !== null && Array.isArray((op as RawTextOperation).textOperation)
}

export function isAddComment(op: unknown): op is RawAddCommentOperation {
  return (
    typeof op === 'object' && op !== null &&
    typeof (op as RawAddCommentOperation).commentId === 'string' &&
    Array.isArray((op as RawAddCommentOperation).ranges)
  )
}

class HistoryOtCodecError extends OverleafError {
  constructor(message: string) {
    super('OVERLEAF_GENERIC', message)
  }
}

/**
 * ShareJS components → one text operation over `text`.
 *
 * ShareJS components apply one after another, each positioned in the doc as
 * the previous ones left it; a text operation is a single left-to-right pass
 * over the original doc. Components in ascending order (what `computeOps`
 * produces, and what edits normally are) map directly. Anything else is first
 * normalised by the caller (see `normalize` in ot.ts).
 *
 * Comment components (`c`) don't change text and are skipped.
 */
export function toTextOperation(ops: OtOp[], text: string): RawTextOperation {
  const out: RawScanOp[] = []
  let cursor = 0 // position in the original text up to which `out` accounts for
  let shift = 0 // (inserted − removed) so far: evolving position − original position
  const retain = (n: number): void => {
    if (n < 0) throw new HistoryOtCodecError('edit components are not in ascending order')
    if (n > 0) out.push(n)
  }
  for (const op of ops) {
    const at = op.p - shift
    if (op.d !== undefined) {
      if (text.slice(at, at + op.d.length) !== op.d) {
        throw new HistoryOtCodecError(`delete component does not match the text at ${op.p}`)
      }
      retain(at - cursor)
      out.push(-op.d.length)
      cursor = at + op.d.length
      shift -= op.d.length
    } else if (op.i !== undefined) {
      retain(at - cursor)
      out.push(op.i)
      cursor = at
      shift += op.i.length
    }
  }
  if (cursor > text.length) throw new HistoryOtCodecError('edit runs past the end of the doc')
  retain(text.length - cursor)
  return { textOperation: mergeAdjacent(out) }
}

/** Adjacent retains / inserts / removes collapse, as the server's builder would do on parse. */
function mergeAdjacent(ops: RawScanOp[]): RawScanOp[] {
  const out: RawScanOp[] = []
  for (const op of ops) {
    const last = out[out.length - 1]
    if (typeof op === 'number' && typeof last === 'number' && Math.sign(op) === Math.sign(last)) {
      out[out.length - 1] = last + op
    } else if (typeof op === 'string' && typeof last === 'string') {
      out[out.length - 1] = last + op
    } else {
      out.push(op)
    }
  }
  return out
}

/**
 * One text operation → ShareJS components, positioned as they apply in turn.
 * `text` is the doc the operation applies to (needed for the removed text and
 * to check the operation's length against ours).
 */
export function fromTextOperation(raw: RawTextOperation, text: string): OtOp[] {
  const out: OtOp[] = []
  let original = 0 // cursor in `text`
  let position = 0 // cursor in the doc as the components so far leave it
  for (const op of raw.textOperation) {
    if (typeof op === 'number' && op > 0) {
      original += op
      position += op
    } else if (typeof op === 'number' && op < 0) {
      out.push({ p: position, d: text.slice(original, original - op) })
      original -= op
    } else if (typeof op === 'string') {
      out.push({ p: position, i: op })
      position += op.length
    } else if (typeof op === 'object' && op !== null && 'r' in op) {
      // Tracked-changes metadata on a retain: no text change.
      original += op.r
      position += op.r
    } else if (typeof op === 'object' && op !== null && 'i' in op) {
      out.push({ p: position, i: op.i })
      position += op.i.length
    } else {
      throw new HistoryOtCodecError(`unknown text operation component ${JSON.stringify(op)}`)
    }
  }
  if (original !== text.length) {
    throw new HistoryOtCodecError(
      `text operation spans ${original} characters but the doc has ${text.length}`,
    )
  }
  return out
}

/**
 * An incoming history-ot update's `op` → ShareJS components (text changes, plus
 * a `c` component for a new comment so anchors stay tracked). Comment deletion,
 * resolution and no-ops change nothing we mirror and yield [].
 */
export function decodeEditOperations(ops: unknown[], text: string): OtOp[] {
  const out: OtOp[] = []
  let current = text
  for (const op of ops) {
    if (isTextOperation(op)) {
      const components = fromTextOperation(op, current)
      out.push(...components)
      current = applyComponents(current, components)
    } else if (isAddComment(op)) {
      for (const range of op.ranges) {
        out.push({ p: range.pos, c: current.slice(range.pos, range.pos + range.length), t: op.commentId })
      }
    }
  }
  return out
}

function applyComponents(text: string, ops: OtOp[]): string {
  for (const op of ops) {
    if (op.d !== undefined) text = text.slice(0, op.p) + text.slice(op.p + op.d.length)
    else if (op.i !== undefined) text = text.slice(0, op.p) + op.i + text.slice(op.p)
  }
  return text
}

/** True when components run left to right without touching earlier output — directly encodable. */
export function isAscending(ops: OtOp[]): boolean {
  let floor = 0
  for (const op of ops) {
    if (op.p < floor) return false
    floor = op.i !== undefined ? op.p + op.i.length : op.p
  }
  return true
}
