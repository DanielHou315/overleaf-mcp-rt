import { describe, it, expect } from 'vitest'
import {
  OverleafError,
  AuthFailedError,
  ProxyAuthFailedError,
  ProjectAccessDeniedError,
  NetworkError,
} from '../../src/errors.js'

describe('errors', () => {
  it('OverleafError is the base class', () => {
    const e = new OverleafError('OVERLEAF_GENERIC', 'oops')
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('OVERLEAF_GENERIC')
    expect(e.message).toBe('oops')
  })

  it('AuthFailedError carries a stable code', () => {
    const e = new AuthFailedError('session expired')
    expect(e.code).toBe('OVERLEAF_AUTH_FAILED')
    expect(e).toBeInstanceOf(OverleafError)
  })

  it('ProxyAuthFailedError carries a stable code', () => {
    const e = new ProxyAuthFailedError('CF Access rejected', { cfRay: 'abc123' })
    expect(e.code).toBe('PROXY_AUTH_FAILED')
    expect(e.context).toEqual({ cfRay: 'abc123' })
  })

  it('ProjectAccessDeniedError carries a stable code', () => {
    const e = new ProjectAccessDeniedError('xyz')
    expect(e.code).toBe('PROJECT_ACCESS_DENIED')
    expect(e.context).toEqual({ projectId: 'xyz' })
  })

  it('NetworkError wraps a cause', () => {
    const cause = new Error('ECONNREFUSED')
    const e = new NetworkError('cannot connect', cause)
    expect(e.code).toBe('NETWORK_ERROR')
    expect(e.cause).toBe(cause)
  })
})
