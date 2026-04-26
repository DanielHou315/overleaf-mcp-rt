import diff from 'fast-diff'

export interface OtOp {
  /** Character offset in the flattened doc where the op applies. */
  p: number
  /** Insert: the text to insert at p. */
  i?: string
  /** Delete: the exact text being removed at p (server validates byte-equality). */
  d?: string
}

const EQUAL = 0
const DELETE = -1
const INSERT = 1

/**
 * Compute the minimal `OtOp[]` that transforms `oldText` into `newText`.
 *
 * Walks fast-diff's `[op, text]` tuples, tracking a running character offset.
 * Equal segments advance the offset; deletes emit a delete op at the current
 * offset (offset is NOT advanced — the deleted chars no longer exist after);
 * inserts emit an insert op at the current offset and advance the offset by
 * the inserted text length.
 *
 * For replace patterns (delete immediately followed by insert at the same
 * offset), we emit the delete first, then the insert at the SAME offset.
 * Spec § "Write path" requires deletes to carry the exact bytes being removed
 * for server validation, so the order matters.
 */
export function computeOps(oldText: string, newText: string): OtOp[] {
  if (oldText === newText) return []
  const tuples = diff(oldText, newText)
  const ops: OtOp[] = []
  let p = 0
  for (const [kind, text] of tuples) {
    if (kind === EQUAL) {
      p += text.length
    } else if (kind === DELETE) {
      ops.push({ p, d: text })
      // Do NOT advance p: the deleted chars are gone after this op applies.
    } else if (kind === INSERT) {
      ops.push({ p, i: text })
      p += text.length
    }
  }
  return ops
}
