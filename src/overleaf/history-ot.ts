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
 * The engine keeps its snapshot, edits and external-change tracking in ShareJS
 * components for both doc types, and this module converts at the socket. What
 * it may NOT share is the transform used to predict what the server does to our
 * in-flight op: the two algorithms agree on most interleavings but not all.
 * When our insert falls inside a range a collaborator *replaced*, ShareJS puts
 * our text before their replacement and editor-core puts it after (its
 * operations list an insert before an adjacent remove, so their insert is
 * emitted before our cursor gets there). Predicting with the wrong one leaves
 * the snapshot silently different from the server's. So for history-ot docs the
 * in-flight op is transformed with a port of editor-core's own algorithm
 * (`TextOperation.transform` below, `transformInFlight`); `history-ot.test.ts`
 * pins the counter-example and checks the prediction against an independent
 * copy of the algorithm over thousands of random interleavings.
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

/**
 * Predict what the server does to our in-flight op when a collaborator's update
 * is applied first: HistoryOTUpdateManager runs `transform(ours, theirs)[0]` for
 * every text operation that beat ours. `before` is the doc both apply to.
 * Returns our op as ShareJS components positioned in the doc *after* theirs.
 */
export function transformInFlight(ours: OtOp[], theirUpdate: unknown[], before: string): OtOp[] {
  let text = before
  let mine = ours
  for (const edit of theirUpdate) {
    if (!isTextOperation(edit)) continue // comment operations and no-ops don't move text
    const theirs = TextOperation.fromJSON(edit)
    const transformed = TextOperation.transform(TextOperation.fromJSON(toTextOperation(mine, text)), theirs)[0]
    text = theirs.apply(text)
    mine = fromTextOperation(transformed.toJSON(), text)
  }
  return mine
}

/**
 * Port of the parts of overleaf-editor-core's TextOperation that
 * document-updater uses on history-ot docs (lib/operation/text_operation.js,
 * AGPL-3.0; derived from ot.js by Tim Baumann, MIT), kept structurally close to
 * the original. Plain text only: tracking and comment ids are parsed and dropped.
 */
type Scan = { retain: number } | { insert: string } | { remove: number }

export class TextOperation {
  ops: Scan[] = []
  baseLength = 0
  targetLength = 0

  retain(n: number): this {
    if (n === 0) return this
    this.baseLength += n
    this.targetLength += n
    const last = this.ops[this.ops.length - 1]
    if (last && 'retain' in last) last.retain += n
    else this.ops.push({ retain: n })
    return this
  }

  insert(s: string): this {
    if (s === '') return this
    this.targetLength += s.length
    const ops = this.ops
    const last = ops[ops.length - 1]
    if (last && 'insert' in last) {
      last.insert += s
    } else if (last && 'remove' in last) {
      // Canonical order: an insert next to a remove goes first.
      const beforeLast = ops[ops.length - 2]
      if (beforeLast && 'insert' in beforeLast) beforeLast.insert += s
      else ops.splice(ops.length - 1, 0, { insert: s })
    } else {
      ops.push({ insert: s })
    }
    return this
  }

  remove(n: number): this {
    if (n === 0) return this
    this.baseLength += n
    const last = this.ops[this.ops.length - 1]
    if (last && 'remove' in last) last.remove += n
    else this.ops.push({ remove: n })
    return this
  }

  static fromJSON(raw: { textOperation: unknown[] }): TextOperation {
    const o = new TextOperation()
    for (const op of raw.textOperation) {
      if (typeof op === 'number' && op > 0) o.retain(op)
      else if (typeof op === 'number' && op < 0) o.remove(-op)
      else if (typeof op === 'string') o.insert(op)
      else if (typeof op === 'object' && op !== null && 'r' in op) o.retain((op as { r: number }).r)
      else if (typeof op === 'object' && op !== null && 'i' in op) o.insert((op as { i: string }).i)
      else throw new Error('unknown operation: ' + JSON.stringify(op))
    }
    return o
  }

  toJSON(): { textOperation: Array<number | string> } {
    return {
      textOperation: this.ops.map((op) => ('retain' in op ? op.retain : 'insert' in op ? op.insert : -op.remove)),
    }
  }

  apply(str: string): string {
    if (str.length !== this.baseLength) {
      throw new Error("The operation's base length must be equal to the string's length.")
    }
    let out = ''
    let index = 0
    for (const op of this.ops) {
      if ('retain' in op) {
        out += str.slice(index, index + op.retain)
        index += op.retain
      } else if ('insert' in op) {
        // containsNonBmpChars: a high surrogate makes the whole update unprocessable.
        if (/[\uD800-\uDBFF]/.test(op.insert)) throw new Error('inserted text contains non BMP characters')
        out += op.insert
      } else {
        index += op.remove
      }
    }
    return out
  }

  /** Both ops apply to the same doc; returns [a', b'] with apply(apply(S, a), b') === apply(apply(S, b), a'). Ties: a's insert first. */
  static transform(operation1: TextOperation, operation2: TextOperation): [TextOperation, TextOperation] {
    if (operation1.baseLength !== operation2.baseLength) {
      throw new Error('Both operations have to have the same base length')
    }
    const operation1prime = new TextOperation()
    const operation2prime = new TextOperation()
    const ops1 = operation1.ops
    const ops2 = operation2.ops
    let i1 = 0
    let i2 = 0
    let op1: Scan | undefined = ops1[i1++]
    let op2: Scan | undefined = ops2[i2++]
    for (;;) {
      if (op1 === undefined && op2 === undefined) break

      if (op1 && 'insert' in op1) {
        operation1prime.insert(op1.insert)
        operation2prime.retain(op1.insert.length)
        op1 = ops1[i1++]
        continue
      }
      if (op2 && 'insert' in op2) {
        operation1prime.retain(op2.insert.length)
        operation2prime.insert(op2.insert)
        op2 = ops2[i2++]
        continue
      }

      if (op1 === undefined) throw new Error('Cannot compose operations: first operation is too short.')
      if (op2 === undefined) throw new Error('Cannot compose operations: first operation is too long.')

      let minl: number
      if ('retain' in op1 && 'retain' in op2) {
        if (op1.retain > op2.retain) {
          minl = op2.retain
          op1 = { retain: op1.retain - op2.retain }
          op2 = ops2[i2++]
        } else if (op1.retain === op2.retain) {
          minl = op2.retain
          op1 = ops1[i1++]
          op2 = ops2[i2++]
        } else {
          minl = op1.retain
          op2 = { retain: op2.retain - op1.retain }
          op1 = ops1[i1++]
        }
        operation1prime.retain(minl)
        operation2prime.retain(minl)
      } else if ('remove' in op1 && 'remove' in op2) {
        if (op1.remove > op2.remove) {
          op1 = { remove: op1.remove - op2.remove }
          op2 = ops2[i2++]
        } else if (op1.remove === op2.remove) {
          op1 = ops1[i1++]
          op2 = ops2[i2++]
        } else {
          op2 = { remove: op2.remove - op1.remove }
          op1 = ops1[i1++]
        }
      } else if ('remove' in op1 && 'retain' in op2) {
        if (op1.remove > op2.retain) {
          minl = op2.retain
          op1 = { remove: op1.remove - op2.retain }
          op2 = ops2[i2++]
        } else if (op1.remove === op2.retain) {
          minl = op2.retain
          op1 = ops1[i1++]
          op2 = ops2[i2++]
        } else {
          minl = op1.remove
          op2 = { retain: op2.retain - op1.remove }
          op1 = ops1[i1++]
        }
        operation1prime.remove(minl)
      } else if ('retain' in op1 && 'remove' in op2) {
        if (op1.retain > op2.remove) {
          minl = op2.remove
          op1 = { retain: op1.retain - op2.remove }
          op2 = ops2[i2++]
        } else if (op1.retain === op2.remove) {
          minl = op1.retain
          op1 = ops1[i1++]
          op2 = ops2[i2++]
        } else {
          minl = op1.retain
          op2 = { remove: op2.remove - op1.retain }
          op1 = ops1[i1++]
        }
        operation2prime.remove(minl)
      } else {
        throw new Error("The two operations aren't compatible")
      }
    }
    return [operation1prime, operation2prime]
  }

  /** Replace `del` characters at `pos` with `ins`, over a doc of `length` characters. */
  static splice(length: number, pos: number, del: number, ins: string): TextOperation {
    return new TextOperation().retain(pos).remove(del).insert(ins).retain(length - pos - del)
  }
}
