import { describe, it, expect } from 'vitest'
import { computeOps, computeWordOps, type OtOp } from '../../src/overleaf/diff.js'
import { applyOps } from '../../src/overleaf/text-ot.js'
import { prng } from './prng.js'

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

describe('computeWordOps (tracked changes)', () => {
  it('replaces a changed word whole, where a character diff leaves letters', () => {
    const before = 'We propose a novel method.'
    const after = 'We introduce a new approach.'
    expect(computeWordOps(before, after)).toEqual<OtOp[]>([
      { p: 3, d: 'propose' }, { p: 3, i: 'introduce' },
      { p: 15, d: 'novel' }, { p: 15, i: 'new' },
      { p: 19, d: 'method' }, { p: 19, i: 'approach' },
    ])
    expect(computeOps(before, after).length).toBeGreaterThan(6)
  })

  it('replaces a word whole even when only a letter changed', () => {
    expect(computeWordOps('The colour.', 'The colours.')).toEqual<OtOp[]>([{ p: 4, d: 'colour' }, { p: 4, i: 'colours' }])
    expect(computeWordOps('lorem ipsum dolor', 'lorem dolor')).toEqual<OtOp[]>([{ p: 6, d: 'ipsum ' }])
    expect(computeWordOps('abc', 'abc')).toEqual([])
  })

  it('does not cut a surrogate pair in two', () => {
    const ops = computeWordOps('x\u{1D400}y', 'x\u{1D401}y')
    expect(applyOps('x\u{1D400}y', ops)).toBe('x\u{1D401}y')
    for (const op of ops) expect(op.i ?? op.d).toMatch(/^[\uD800-\uDBFF][\uDC00-\uDFFF]$/)
  })

  it('always produces ops that turn the old text into the new one', () => {
    const rand = prng(17)
    const words = ['alpha', 'beta', 'gamma', 'delta', '\\cite{x}', 'naïve', ',', '.', '\n']
    const text = (n: number) => Array.from({ length: n }, () => words[rand(words.length)]).join(rand(4) === 0 ? '  ' : ' ')
    let replacements = 0
    for (let round = 0; round < 300; round++) {
      const before = text(5 + rand(20))
      let after = before
      for (let k = 1 + rand(3); k > 0; k--) {
        const p = rand(after.length + 1)
        const cut = rand(3) === 0 ? rand(6) : 0
        after = after.slice(0, p) + (rand(2) === 0 ? words[rand(words.length)]! : '') + after.slice(p + cut)
      }
      const ops = computeWordOps(before, after)
      expect(applyOps(before, ops), JSON.stringify({ before, after })).toBe(after)
      if (ops.some((op) => op.d !== undefined) && ops.some((op) => op.i !== undefined)) replacements += 1
    }
    // The scenario has to contain what it claims to cover.
    expect(replacements, 'rounds that replaced text').toBeGreaterThan(50)
  })
})
