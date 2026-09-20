import diff from 'fast-diff'

export interface OtOp {
  /** Character offset in the flattened doc where the op applies. */
  p: number
  /** Insert: the text to insert at p. */
  i?: string
  /** Delete: the exact text being removed at p (server validates byte-equality). */
  d?: string
  /** Comment (review panel): anchors thread `t` to the text `c` at p without changing the text. */
  c?: string
  /** Thread id of a comment component. */
  t?: string
}

const SURROGATES = /[\uD800-\uDFFF]/g

/**
 * Overleaf cannot store characters outside the Basic Multilingual Plane
 * (emoji, some CJK extensions, maths alphabets). document-updater rewrites
 * every UTF-16 surrogate in an inserted string to U+FFFD before applying it
 * (UpdateManager._sanitizeUpdate) — and the sender is only sent an ack, never
 * the rewritten op. A client that keeps what it typed therefore disagrees with
 * the server from then on, and its next delete across that text is rejected,
 * which disconnects everyone in the doc. So do the server's rewrite ourselves,
 * before the op is sent and before it is applied to our snapshot. Lengths are
 * unchanged (one code unit for one), so no offsets move.
 */
export function sanitizeOps(ops: OtOp[]): { ops: OtOp[]; replaced: number } {
  let replaced = 0
  const out = ops.map((op) => {
    if (op.i === undefined) return op
    const i = op.i.replace(SURROGATES, () => {
      replaced += 1
      return '\uFFFD'
    })
    return i === op.i ? op : { ...op, i }
  })
  return { ops: out, replaced }
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
