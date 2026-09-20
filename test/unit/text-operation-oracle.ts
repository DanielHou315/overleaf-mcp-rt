/**
 * Test oracle: a port of the parts of overleaf-editor-core's TextOperation
 * (lib/operation/text_operation.js, AGPL-3.0; derived from ot.js by Tim
 * Baumann, MIT) that document-updater uses for history-ot docs — parse, apply,
 * transform — kept structurally close to the original so it can be compared
 * line by line. Plain text only: tracking and comment ids are parsed and
 * dropped.
 *
 * It exists so the fake server behaves like the real one *independently* of
 * src/overleaf/history-ot.ts and src/overleaf/text-ot.ts, which are what the
 * tests are checking.
 */
export type Scan = { retain: number } | { insert: string } | { remove: number }

export class TextOp {
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

  static fromJSON(raw: { textOperation: unknown[] }): TextOp {
    const o = new TextOp()
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
  static transform(operation1: TextOp, operation2: TextOp): [TextOp, TextOp] {
    if (operation1.baseLength !== operation2.baseLength) {
      throw new Error('Both operations have to have the same base length')
    }
    const operation1prime = new TextOp()
    const operation2prime = new TextOp()
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
  static splice(length: number, pos: number, del: number, ins: string): TextOp {
    return new TextOp().retain(pos).remove(del).insert(ins).retain(length - pos - del)
  }
}
