import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateCookie, passportLogin } from '../../src/overleaf/auth.js'
import { AuthFailedError } from '../../src/errors.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '..', 'fixtures')
const loginHtml = readFileSync(join(FIXTURES, 'login.html'), 'utf-8')
const csrfMetaHtml = readFileSync(join(FIXTURES, 'csrf-meta.html'), 'utf-8')

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('validateCookie', () => {
  it('returns the scraped CSRF token on success', async () => {
    server.use(
      http.get('https://o.example/project', () => HttpResponse.html(csrfMetaHtml)),
    )
    const csrf = await validateCookie({
      url: 'https://o.example',
      sessionCookie: 'overleaf_session2=abc',
      extraHeaders: {},
    })
    expect(csrf).toBe('POST-CSRF-TOKEN')
  })

  it('throws AuthFailedError when /project redirects to /login', async () => {
    server.use(
      http.get('https://o.example/project', () =>
        HttpResponse.text('', { status: 302, headers: { Location: '/login' } }),
      ),
    )
    await expect(
      validateCookie({
        url: 'https://o.example',
        sessionCookie: 'bogus',
        extraHeaders: {},
      }),
    ).rejects.toBeInstanceOf(AuthFailedError)
  })

  it('throws when ol-csrfToken meta tag is absent', async () => {
    server.use(
      http.get('https://o.example/project', () =>
        HttpResponse.html('<html><body>no meta here</body></html>'),
      ),
    )
    await expect(
      validateCookie({
        url: 'https://o.example',
        sessionCookie: 'abc',
        extraHeaders: {},
      }),
    ).rejects.toThrow(/csrf/i)
  })
})

describe('passportLogin', () => {
  it('completes the login flow and returns cookie + csrf', async () => {
    server.use(
      http.get('https://o.example/login', () =>
        HttpResponse.html(loginHtml, {
          headers: { 'Set-Cookie': 'overleaf_session2=presession' },
        }),
      ),
      http.post('https://o.example/login', async ({ request }) => {
        const body = (await request.json()) as Record<string, string>
        expect(body._csrf).toBe('LOGIN-CSRF-TOKEN')
        expect(body.email).toBe('me@example.com')
        expect(body.password).toBe('hunter2')
        expect(request.headers.get('x-csrf-token')).toBe('LOGIN-CSRF-TOKEN')
        return HttpResponse.text('', {
          status: 302,
          headers: {
            Location: '/project',
            'Set-Cookie': 'overleaf_session2=postsession; Path=/; HttpOnly',
          },
        })
      }),
      http.get('https://o.example/project', () => HttpResponse.html(csrfMetaHtml)),
    )

    const result = await passportLogin({
      url: 'https://o.example',
      email: 'me@example.com',
      password: 'hunter2',
      extraHeaders: {},
    })

    expect(result.sessionCookie).toMatch(/overleaf_session2=postsession/)
    expect(result.csrfToken).toBe('POST-CSRF-TOKEN')
  })

  it('throws AuthFailedError on bad credentials', async () => {
    server.use(
      http.get('https://o.example/login', () =>
        HttpResponse.html(loginHtml, {
          headers: { 'Set-Cookie': 'overleaf_session2=presession' },
        }),
      ),
      http.post('https://o.example/login', () =>
        HttpResponse.json({ message: 'invalid credentials' }, { status: 401 }),
      ),
    )

    await expect(
      passportLogin({
        url: 'https://o.example',
        email: 'me@example.com',
        password: 'wrong',
        extraHeaders: {},
      }),
    ).rejects.toBeInstanceOf(AuthFailedError)
  })
})
