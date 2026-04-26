import { describe, it, expect } from 'vitest'
import { OtDeleteMismatchError } from '../../src/errors.js'
import { applyOpsLocal } from '../../src/overleaf/ot.js'

describe('applyOpsLocal', () => {
  it('throws OtDeleteMismatchError when d does not match the substring at p', () => {
    expect(() =>
      applyOpsLocal('hello world', [{ p: 6, d: 'XXXXX' }]),
    ).toThrow(OtDeleteMismatchError)
  })

  it('includes p, expected, actual, opIndex in the error context', () => {
    try {
      applyOpsLocal('hello world', [{ p: 6, d: 'XXXXX' }])
      expect.fail('expected throw')
    } catch (err) {
      if (!(err instanceof OtDeleteMismatchError)) throw err
      expect(err.context.p).toBe(6)
      expect(err.context.expected).toBe('XXXXX')
      expect(err.context.actual).toBe('world')
      expect(err.context.opIndex).toBe(0)
    }
  })

  it('still applies clean inserts and matching deletes', () => {
    const out = applyOpsLocal('hello world', [
      { p: 5, i: ' lovely' },
      { p: 12, d: ' world' },
    ])
    expect(out).toBe('hello lovely')
  })
})
