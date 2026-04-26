import { describe, it, expect } from 'vitest'
import { computeOps, type OtOp } from '../../src/overleaf/diff.js'

describe('computeOps', () => {
  it('returns empty ops when texts are identical', () => {
    const ops = computeOps('abc', 'abc')
    expect(ops).toEqual([])
  })

  it('emits a single insert op for pure append', () => {
    const ops = computeOps('hello', 'hello world')
    expect(ops).toEqual<OtOp[]>([{ p: 5, i: ' world' }])
  })

  it('emits a single delete op for pure truncation', () => {
    const ops = computeOps('hello world', 'hello')
    expect(ops).toEqual<OtOp[]>([{ p: 5, d: ' world' }])
  })

  it('emits insert at start of doc', () => {
    const ops = computeOps('world', 'hello world')
    expect(ops).toEqual<OtOp[]>([{ p: 0, i: 'hello ' }])
  })

  it('emits delete at start of doc', () => {
    const ops = computeOps('hello world', 'world')
    expect(ops).toEqual<OtOp[]>([{ p: 0, d: 'hello ' }])
  })

  it('emits insert and delete for replacement in middle', () => {
    const ops = computeOps('aaXbb', 'aaYbb')
    // fast-diff yields [EQUAL,'aa'][DELETE,'X'][INSERT,'Y'][EQUAL,'bb']
    // We translate to a delete then an insert at the same offset.
    expect(ops).toEqual<OtOp[]>([
      { p: 2, d: 'X' },
      { p: 2, i: 'Y' },
    ])
  })

  it('handles multi-line LaTeX edit', () => {
    const before = '\\section{Intro}\nHello world.\n'
    const after = '\\section{Introduction}\nHello world.\n'
    const ops = computeOps(before, after)
    // fast-diff yields [EQUAL,'\\section{Intro'][INSERT,'duction'][EQUAL,'}\nHello world.\n']
    // so the only op is an insert of 'duction' at offset 14 (after '\\section{Intro')
    expect(ops).toEqual<OtOp[]>([{ p: 14, i: 'duction' }])
  })

  it('preserves insert+delete order when replacement happens at equal offset', () => {
    // Critical: spec says "A delete op must contain the exact bytes being removed"
    // so we emit delete BEFORE insert at the same position.
    const ops = computeOps('Xb', 'Yb')
    expect(ops[0]).toEqual({ p: 0, d: 'X' })
    expect(ops[1]).toEqual({ p: 0, i: 'Y' })
  })

  it('handles UTF-8 characters correctly via character offsets (not byte offsets)', () => {
    // 'α' is one character regardless of byte length.
    const before = 'αβγ'
    const after = 'αZβγ'
    const ops = computeOps(before, after)
    expect(ops).toEqual<OtOp[]>([{ p: 1, i: 'Z' }])
  })
})
