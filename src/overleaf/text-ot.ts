// Port of the ShareJS `text` OT type as shipped in Overleaf's document-updater
// (services/document-updater/app/js/sharejs/types/{text,helpers}.js).
// Copyright 2011 Joseph Gentle, 2012-2024 Overleaf; MIT licensed upstream.
//
// The server transforms every op we submit at an old version against the ops
// it has applied since (`transform(ours, theirs, 'left')`), and only tells us
// the resulting version — not the transformed op. To keep our local snapshot
// byte-identical to the server's we must run the *same* transform locally, so
// this file mirrors upstream's control flow (including the single-component
// fast path and `append` compaction) rather than re-deriving it.
import { OtDeleteMismatchError } from '../errors.js'
import type { OtOp } from './diff.js'

type Side = 'left' | 'right'

const strInject = (s1: string, pos: number, s2: string): string =>
  s1.slice(0, pos) + s2 + s1.slice(pos)

/**
 * Apply ops to text. Insert and delete components mutate the text; comment
 * components (`c`, emitted by the review panel) only annotate a range and
 * leave the text untouched.
 */
export function applyOps(text: string, ops: OtOp[]): string {
  let out = text
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    if (op.i !== undefined) {
      out = strInject(out, op.p, op.i)
    } else if (op.d !== undefined) {
      const slice = out.slice(op.p, op.p + op.d.length)
      if (slice !== op.d) {
        throw new OtDeleteMismatchError(
          `Delete op #${i} at position ${op.p} expected ${JSON.stringify(op.d.slice(0, 80))}` +
            ` but doc has ${JSON.stringify(slice.slice(0, 80))}`,
          { p: op.p, expected: op.d, actual: slice, opIndex: i },
        )
      }
      out = out.slice(0, op.p) + out.slice(op.p + op.d.length)
    }
  }
  return out
}

/** Append a component to an op, merging with the previous one where upstream does. */
function append(newOp: OtOp[], c: OtOp): void {
  if (c.i === '' || c.d === '') return
  if (newOp.length === 0) {
    newOp.push(c)
    return
  }
  const last = newOp[newOp.length - 1]!
  if (
    last.i !== undefined && c.i !== undefined &&
    last.p <= c.p && c.p <= last.p + last.i.length
  ) {
    newOp[newOp.length - 1] = { i: strInject(last.i, c.p - last.p, c.i), p: last.p }
  } else if (
    last.d !== undefined && c.d !== undefined &&
    c.p <= last.p && last.p <= c.p + c.d.length
  ) {
    newOp[newOp.length - 1] = { d: strInject(c.d, last.p - c.p, last.d), p: c.p }
  } else {
    newOp.push(c)
  }
}

function transformPosition(pos: number, c: OtOp, insertAfter?: boolean): number {
  if (c.i !== undefined) {
    return c.p < pos || (c.p === pos && insertAfter) ? pos + c.i.length : pos
  }
  if (c.d !== undefined) {
    if (pos <= c.p) return pos
    if (pos <= c.p + c.d.length) return c.p
    return pos - c.d.length
  }
  return pos // comment component: no text change
}

function transformComponent(dest: OtOp[], c: OtOp, otherC: OtOp, side: Side): OtOp[] {
  if (c.i !== undefined) {
    append(dest, { i: c.i, p: transformPosition(c.p, otherC, side === 'right') })
  } else if (c.d !== undefined) {
    if (otherC.i !== undefined) {
      // delete vs insert: the insert may split our delete in two
      let s = c.d
      if (c.p < otherC.p) {
        append(dest, { d: s.slice(0, otherC.p - c.p), p: c.p })
        s = s.slice(otherC.p - c.p)
      }
      if (s !== '') append(dest, { d: s, p: c.p + otherC.i.length })
    } else if (otherC.d !== undefined) {
      if (c.p >= otherC.p + otherC.d.length) {
        append(dest, { d: c.d, p: c.p - otherC.d.length })
      } else if (c.p + c.d.length <= otherC.p) {
        append(dest, c)
      } else {
        // Overlapping deletes: keep only the part the other side didn't remove.
        const newC = { d: '', p: c.p }
        if (c.p < otherC.p) newC.d = c.d.slice(0, otherC.p - c.p)
        if (c.p + c.d.length > otherC.p + otherC.d.length) {
          newC.d += c.d.slice(otherC.p + otherC.d.length - c.p)
        }
        const intersectStart = Math.max(c.p, otherC.p)
        const intersectEnd = Math.min(c.p + c.d.length, otherC.p + otherC.d.length)
        const cIntersect = c.d.slice(intersectStart - c.p, intersectEnd - c.p)
        const otherIntersect = otherC.d.slice(intersectStart - otherC.p, intersectEnd - otherC.p)
        if (cIntersect !== otherIntersect) {
          throw new Error('Delete ops delete different text in the same region of the document')
        }
        if (newC.d !== '') {
          newC.p = transformPosition(newC.p, otherC)
          append(dest, newC)
        }
      }
    } else {
      append(dest, c)
    }
  }
  else if (c.c !== undefined) {
    // Comment: follows the text it is anchored to.
    if (otherC.i !== undefined) {
      if (c.p < otherC.p && otherC.p < c.p + c.c.length) {
        const offset = otherC.p - c.p
        append(dest, { c: c.c.slice(0, offset) + otherC.i + c.c.slice(offset), p: c.p, t: c.t })
      } else {
        append(dest, { c: c.c, p: transformPosition(c.p, otherC, true), t: c.t })
      }
    } else if (otherC.d !== undefined) {
      if (c.p >= otherC.p + otherC.d.length) {
        append(dest, { c: c.c, p: c.p - otherC.d.length, t: c.t })
      } else if (c.p + c.c.length <= otherC.p) {
        append(dest, c)
      } else {
        // The delete overlaps the commented text: keep what survives.
        const newC = { c: '', p: c.p, t: c.t }
        if (c.p < otherC.p) newC.c = c.c.slice(0, otherC.p - c.p)
        if (c.p + c.c.length > otherC.p + otherC.d.length) {
          newC.c += c.c.slice(otherC.p + otherC.d.length - c.p)
        }
        newC.p = transformPosition(newC.p, otherC)
        append(dest, newC)
      }
    } else {
      append(dest, c)
    }
  }
  return dest
}

/** Transforms both ops past each other. Returns [leftOp', rightOp']. */
function transformX(leftOp: OtOp[], rightOp: OtOp[]): [OtOp[], OtOp[]] {
  const newRightOp: OtOp[] = []
  for (const component of rightOp) {
    let rightComponent: OtOp | null = component
    const newLeftOp: OtOp[] = []
    let k = 0
    while (k < leftOp.length) {
      const nextC: OtOp[] = []
      transformComponent(newLeftOp, leftOp[k]!, rightComponent, 'left')
      transformComponent(nextC, rightComponent, leftOp[k]!, 'right')
      k++
      if (nextC.length === 1) {
        rightComponent = nextC[0]!
      } else if (nextC.length === 0) {
        for (const l of leftOp.slice(k)) append(newLeftOp, l)
        rightComponent = null
        break
      } else {
        const [l_, r_] = transformX(leftOp.slice(k), nextC)
        for (const l of l_) append(newLeftOp, l)
        for (const r of r_) append(newRightOp, r)
        rightComponent = null
        break
      }
    }
    if (rightComponent !== null) append(newRightOp, rightComponent)
    leftOp = newLeftOp
  }
  return [leftOp, newRightOp]
}

/**
 * Transform `op` so it can be applied after `otherOp`, where both were
 * authored against the same snapshot. `side` breaks ties between inserts at
 * the same position: the server always transforms incoming ops as 'left'.
 */
export function transformOps(op: OtOp[], otherOp: OtOp[], side: Side): OtOp[] {
  // Comment components don't move text; dropping them keeps the math to i/d.
  const other = otherOp.filter((c) => c.i !== undefined || c.d !== undefined)
  if (other.length === 0) return op
  if (op.length === 1 && other.length === 1) {
    return transformComponent([], op[0]!, other[0]!, side)
  }
  return side === 'left' ? transformX(op, other)[0] : transformX(other, op)[1]
}
