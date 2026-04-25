import { AuthFailedError, NetworkError, ProxyAuthFailedError } from '../errors.js'

export interface HttpOptions {
  url: string
  sessionCookie: string
  csrfToken?: string
  extraHeaders?: Record<string, string>
}

export class OverleafHttp {
  constructor(private readonly opts: HttpOptions) {}

  get url() {
    return this.opts.url
  }

  get sessionCookie() {
    return this.opts.sessionCookie
  }

  get extraHeaders() {
    return this.opts.extraHeaders ?? {}
  }

  setCsrfToken(token: string) {
    this.opts.csrfToken = token
  }

  async get(path: string, init: RequestInit = {}): Promise<Response> {
    return this.request('GET', path, init)
  }

  async postJson(path: string, body: unknown, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Content-Type', 'application/json')
    return this.request('POST', path, {
      ...init,
      headers,
      body: JSON.stringify(body),
    })
  }

  async postForm(path: string, body: FormData, init: RequestInit = {}): Promise<Response> {
    return this.request('POST', path, { ...init, body })
  }

  async delete(path: string, init: RequestInit = {}): Promise<Response> {
    return this.request('DELETE', path, init)
  }

  private async request(method: string, path: string, init: RequestInit): Promise<Response> {
    const url = new URL(path, this.opts.url + '/').toString()
    const headers = new Headers(init.headers)
    headers.set('Cookie', this.opts.sessionCookie)
    if (this.opts.csrfToken && method !== 'GET') {
      headers.set('X-Csrf-Token', this.opts.csrfToken)
    }
    for (const [k, v] of Object.entries(this.opts.extraHeaders ?? {})) {
      headers.set(k, v)
    }

    let res: Response
    try {
      res = await fetch(url, { ...init, method, headers, redirect: 'manual' })
    } catch (err) {
      throw new NetworkError(`fetch failed for ${method} ${url}`, err)
    }

    this.checkAuthErrors(res)
    return res
  }

  private checkAuthErrors(res: Response) {
    if (res.status === 403 && (res.headers.has('cf-ray') || res.headers.has('cf-mitigated'))) {
      throw new ProxyAuthFailedError('Upstream proxy (Cloudflare) rejected the request', {
        cfRay: res.headers.get('cf-ray'),
      })
    }
    if (res.status === 401) {
      throw new AuthFailedError('Overleaf returned 401 Unauthorized')
    }
    if (res.status === 302) {
      const loc = res.headers.get('location') ?? ''
      if (loc.startsWith('/login') || loc.endsWith('/login')) {
        throw new AuthFailedError('Session redirected to /login (cookie likely expired)')
      }
    }
  }
}
