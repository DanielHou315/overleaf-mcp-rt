import { describe, it, expect } from 'vitest'
import { OtDeleteMismatchError, AuthFailedError } from '../../src/errors.js'
import { NetworkError, NotFoundError } from '../../src/errors.js'

describe('OverleafError.toEnvelope', () => {
  it('returns code, message, context, retryable=false, and a hint for OT_DELETE_MISMATCH', () => {
    const err = new OtDeleteMismatchError('test', { p: 5, expected: 'a', actual: 'b', opIndex: 0 })
    const env = err.toEnvelope()
    expect(env.code).toBe('OT_DELETE_MISMATCH')
    expect(env.retryable).toBe(false)
    expect(env.hint).toMatch(/Re-read the doc/)
    expect(env.context).toEqual({ p: 5, expected: 'a', actual: 'b', opIndex: 0 })
  })

  it('marks AUTH_FAILED as not retryable but includes a login hint', () => {
    const env = new AuthFailedError('cookie expired').toEnvelope()
    expect(env.retryable).toBe(false)
    expect(env.hint).toMatch(/login/)
  })

  it('marks NetworkError as retryable', () => {
    const env = new NetworkError('socket timeout').toEnvelope()
    expect(env.retryable).toBe(true)
  })

  it('omits hint when no entry is registered for the code', () => {
    const env = new NotFoundError('no such doc').toEnvelope()
    expect(env.hint).toBeUndefined()
  })
})
