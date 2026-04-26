import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { OverleafHttp } from '../../src/overleaf/http.js'
import { AuthFailedError, ProxyAuthFailedError, NetworkError, ProjectAccessDeniedError } from '../../src/errors.js'

const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function makeClient(extraHeaders: Record<string, string> = {}) {
  return new OverleafHttp({
    url: 'https://overleaf.example.com',
    sessionCookie: 'overleaf_session2=abc',
    csrfToken: 'csrf-token-xyz',
    extraHeaders,
  })
}

describe('OverleafHttp', () => {
  it('attaches Cookie header on GET', async () => {
    server.use(
      http.get('https://overleaf.example.com/some/path', ({ request }) => {
        expect(request.headers.get('cookie')).toBe('overleaf_session2=abc')
        return HttpResponse.text('ok')
      }),
    )
    const client = makeClient()
    const res = await client.get('/some/path')
    expect(await res.text()).toBe('ok')
  })

  it('attaches X-Csrf-Token on POST', async () => {
    server.use(
      http.post('https://overleaf.example.com/some/path', ({ request }) => {
        expect(request.headers.get('x-csrf-token')).toBe('csrf-token-xyz')
        return HttpResponse.json({ ok: true })
      }),
    )
    const client = makeClient()
    await client.postJson('/some/path', { hi: 1 })
  })

  it('merges extra headers into requests', async () => {
    server.use(
      http.get('https://overleaf.example.com/p', ({ request }) => {
        expect(request.headers.get('cf-access-client-id')).toBe('abc.access')
        expect(request.headers.get('cf-access-client-secret')).toBe('shh')
        return HttpResponse.text('ok')
      }),
    )
    const client = makeClient({
      'CF-Access-Client-Id': 'abc.access',
      'CF-Access-Client-Secret': 'shh',
    })
    await client.get('/p')
  })

  it('throws AuthFailedError on 401', async () => {
    server.use(
      http.get('https://overleaf.example.com/p', () =>
        HttpResponse.text('Unauthorized', { status: 401 }),
      ),
    )
    await expect(makeClient().get('/p')).rejects.toBeInstanceOf(AuthFailedError)
  })

  it('throws AuthFailedError on 302 to /login', async () => {
    server.use(
      http.get('https://overleaf.example.com/p', () =>
        HttpResponse.text('', { status: 302, headers: { Location: '/login' } }),
      ),
    )
    await expect(makeClient().get('/p')).rejects.toBeInstanceOf(AuthFailedError)
  })

  it('throws ProxyAuthFailedError on 403 with Cf-Ray header', async () => {
    server.use(
      http.get('https://overleaf.example.com/p', () =>
        HttpResponse.text('blocked', {
          status: 403,
          headers: { 'Cf-Ray': 'abc-LHR' },
        }),
      ),
    )
    await expect(makeClient().get('/p')).rejects.toBeInstanceOf(ProxyAuthFailedError)
  })

  it('throws NetworkError on fetch failure', async () => {
    server.use(
      http.get('https://overleaf.example.com/p', () => HttpResponse.error()),
    )
    await expect(makeClient().get('/p')).rejects.toBeInstanceOf(NetworkError)
  })

  it('throws ProjectAccessDeniedError on 403 from /project/:id/* without CF headers', async () => {
    server.use(
      http.get('https://overleaf.example.com/project/p1/file/f1', () =>
        HttpResponse.text('forbidden', { status: 403 }),
      ),
    )
    await expect(makeClient().get('/project/p1/file/f1')).rejects.toMatchObject({
      code: 'PROJECT_ACCESS_DENIED',
      context: { projectId: 'p1' },
    })
  })

  it('still throws ProxyAuthFailedError on 403 with cf-ray (CF wins over project-403)', async () => {
    server.use(
      http.get('https://overleaf.example.com/project/p1/file/f1', () =>
        HttpResponse.text('blocked', { status: 403, headers: { 'Cf-Ray': 'abc' } }),
      ),
    )
    await expect(makeClient().get('/project/p1/file/f1')).rejects.toBeInstanceOf(ProxyAuthFailedError)
  })

  it('throws AuthFailedError on 401 regardless of path', async () => {
    server.use(
      http.get('https://overleaf.example.com/project/p1/compile', () =>
        HttpResponse.text('Unauthorized', { status: 401 }),
      ),
    )
    await expect(makeClient().get('/project/p1/compile')).rejects.toBeInstanceOf(AuthFailedError)
  })
})
