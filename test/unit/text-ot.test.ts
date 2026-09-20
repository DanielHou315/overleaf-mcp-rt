import { describe, it, expect } from 'vitest'
import { applyOps, transformOps } from '../../src/overleaf/text-ot.js'
import type { OtOp } from '../../src/overleaf/diff.js'

describe('transformOps (port of ShareJS text type)', () => {
  it('shifts an insert past an earlier insert', () => {
    expect(transformOps([{ p: 5, i: 'X' }], [{ p: 0, i: 'abc' }], 'left')).toEqual([{ p: 8, i: 'X' }])
  })

  it("breaks same-position insert ties by side: 'left' stays put, 'right' moves after", () => {
    expect(transformOps([{ p: 2, i: 'L' }], [{ p: 2, i: 'R' }], 'left')).toEqual([{ p: 2, i: 'L' }])
    expect(transformOps([{ p: 2, i: 'R' }], [{ p: 2, i: 'L' }], 'right')).toEqual([{ p: 3, i: 'R' }])
  })

  it('splits a delete around text inserted inside its range', () => {
    // 'hello world' — we delete 'lo wo', they insert '_' at 5
    expect(transformOps([{ p: 3, d: 'lo wo' }], [{ p: 5, i: '_' }], 'left')).toEqual([
      { p: 3, d: 'lo' },
      { p: 4, d: ' wo' },
    ])
  })

  it('trims a delete that overlaps text the other side already deleted', () => {
    expect(transformOps([{ p: 2, d: 'cdef' }], [{ p: 0, d: 'abcd' }], 'left')).toEqual([{ p: 0, d: 'ef' }])
    expect(transformOps([{ p: 2, d: 'cd' }], [{ p: 0, d: 'abcdef' }], 'left')).toEqual([])
  })

  it('ignores comment components, which do not move text', () => {
    const op: OtOp[] = [{ p: 4, i: 'x' }]
    expect(transformOps(op, [{ p: 0, c: 'abc' }], 'left')).toEqual(op)
  })

  it('converges for random concurrent ops (TP1)', () => {
    let seed = 7
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const randomOp = (text: string): OtOp[] => {
      const ops: OtOp[] = []
      let cur = text
      for (let k = 1 + rand(3); k > 0; k--) {
        const p = rand(cur.length + 1)
        if (rand(2) === 0 || cur.length - p < 1) {
          const i = 'xyz'.slice(0, 1 + rand(3))
          ops.push({ p, i })
          cur = cur.slice(0, p) + i + cur.slice(p)
        } else {
          const d = cur.slice(p, p + 1 + rand(Math.min(4, cur.length - p)))
          ops.push({ p, d })
          cur = cur.slice(0, p) + cur.slice(p + d.length)
        }
      }
      return ops
    }
    for (let n = 0; n < 2000; n++) {
      const base = 'abcdefghijklmnop'.slice(0, 4 + rand(12))
      const a = randomOp(base)
      const b = randomOp(base)
      const viaA = applyOps(applyOps(base, a), transformOps(b, a, 'right'))
      const viaB = applyOps(applyOps(base, b), transformOps(a, b, 'left'))
      expect(viaA, `base=${base} a=${JSON.stringify(a)} b=${JSON.stringify(b)}`).toBe(viaB)
    }
  })
})
