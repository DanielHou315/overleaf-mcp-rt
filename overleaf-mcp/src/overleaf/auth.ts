import { parse as parseHtml } from 'node-html-parser'
import { AuthFailedError, NetworkError } from '../errors.js'

export interface AuthInput {
  url: string
  sessionCookie?: string
  extraHeaders: Record<string, string>
}

export interface PassportInput {
  url: string
  email: string
  password: string
  extraHeaders: Record<string, string>
}

export interface SessionIdentity {
  sessionCookie: string
  csrfToken: string
}

function applyExtraHeaders(headers: Headers, extra: Record<string, string>) {
  for (const [k, v] of Object.entries(extra)) headers.set(k, v)
}

function scrapeCsrfMeta(html: string): string {
  const root = parseHtml(html)
  const meta = root.querySelector('meta[name="ol-csrfToken"]')
  const content = meta?.getAttribute('content')
  if (!content) {
    throw new AuthFailedError('Could not find <meta name="ol-csrfToken"> in /project HTML')
  }
  return content
}

function scrapeLoginCsrf(html: string): string {
  const root = parseHtml(html)
  const input = root.querySelector('input[name="_csrf"]')
  const value = input?.getAttribute('value')
  if (!value) {
    throw new AuthFailedError('Could not find <input name="_csrf"> on /login page')
  }
  return value
}

/** Validate a pasted cookie and return the scraped POST CSRF token. */
export async function validateCookie(input: AuthInput): Promise<string> {
  if (!input.sessionCookie) {
    throw new AuthFailedError('No session cookie provided')
  }
  const headers = new Headers({ Cookie: input.sessionCookie })
  applyExtraHeaders(headers, input.extraHeaders)

  let res: Response
  try {
    res = await fetch(new URL('/project', input.url + '/').toString(), {
      method: 'GET',
      headers,
      redirect: 'manual',
    })
  } catch (err) {
    throw new NetworkError('fetch failed for /project', err)
  }

  if (res.status === 302) {
    const loc = res.headers.get('location') ?? ''
    if (loc.startsWith('/login') || loc.endsWith('/login')) {
      throw new AuthFailedError('Session expired (redirected to /login)')
    }
  }
  if (res.status === 401) {
    throw new AuthFailedError('Overleaf returned 401 on /project')
  }
  if (!res.ok && res.status !== 302) {
    throw new AuthFailedError(`Unexpected status ${res.status} from /project`)
  }
  const html = await res.text()
  return scrapeCsrfMeta(html)
}

/** POST /login with email + password; return new cookie + CSRF token. */
export async function passportLogin(input: PassportInput): Promise<SessionIdentity> {
  // 1. GET /login → presession cookie + login _csrf
  const loginHeaders = new Headers()
  applyExtraHeaders(loginHeaders, input.extraHeaders)
  let getRes: Response
  try {
    getRes = await fetch(new URL('/login', input.url + '/').toString(), {
      method: 'GET',
      headers: loginHeaders,
      redirect: 'manual',
    })
  } catch (err) {
    throw new NetworkError('fetch failed for GET /login', err)
  }
  if (!getRes.ok) {
    throw new AuthFailedError(`GET /login returned ${getRes.status}`)
  }
  const presession = getRes.headers.getSetCookie?.()[0] ?? getRes.headers.get('set-cookie') ?? ''
  if (!presession) {
    throw new AuthFailedError('No Set-Cookie on GET /login response')
  }
  const csrf = scrapeLoginCsrf(await getRes.text())

  // 2. POST /login with credentials
  const postHeaders = new Headers({
    'Content-Type': 'application/json',
    'X-Csrf-Token': csrf,
    Cookie: presession.split(';')[0]!,
  })
  applyExtraHeaders(postHeaders, input.extraHeaders)
  let postRes: Response
  try {
    postRes = await fetch(new URL('/login', input.url + '/').toString(), {
      method: 'POST',
      headers: postHeaders,
      body: JSON.stringify({ _csrf: csrf, email: input.email, password: input.password }),
      redirect: 'manual',
    })
  } catch (err) {
    throw new NetworkError('fetch failed for POST /login', err)
  }
  if (postRes.status !== 302 && !postRes.ok) {
    throw new AuthFailedError(
      `POST /login returned ${postRes.status}; check email/password`,
    )
  }
  const newCookie =
    postRes.headers.getSetCookie?.().find((c) => c.startsWith('overleaf_session2=')) ??
    postRes.headers.get('set-cookie') ??
    ''
  const sessionCookie = newCookie.split(';')[0]
  if (!sessionCookie) {
    throw new AuthFailedError('No session cookie returned from POST /login')
  }

  // 3. GET /project to scrape POST CSRF token for write ops
  const csrfToken = await validateCookie({
    url: input.url,
    sessionCookie,
    extraHeaders: input.extraHeaders,
  })

  return { sessionCookie, csrfToken }
}
