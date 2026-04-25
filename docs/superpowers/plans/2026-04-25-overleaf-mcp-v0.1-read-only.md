# Overleaf MCP v0.1 (Read-Only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `overleaf-mcp` v0.1 — a Node.js MCP server that lets an AI agent list projects, read files, and compile LaTeX in a stock Overleaf Community Edition instance, with auth via either pasted session cookie or interactive passport login, and pass-through HTTP headers for reverse-proxy auth setups (e.g. Cloudflare Access).

**Architecture:** Single Node.js process started by an AI client over MCP stdio. Reads project content by fetching the project zip via Overleaf's public REST API into a TTL-bounded cache; serves MCP tool calls from the cache for text/binary reads, and proxies straight through to Overleaf for compile and file downloads. No OT, no writes — that lands in v0.2. Spec reference: `docs/superpowers/specs/2026-04-25-overleaf-mcp-design.md`.

**Tech Stack:**
- Node.js ≥ 20 (native `fetch`)
- TypeScript 5
- pnpm for package management (npm/yarn also fine)
- `@modelcontextprotocol/sdk` for MCP transport
- `vitest` for testing
- `msw` (Mock Service Worker, Node mode) for HTTP mocking in unit tests
- `node-html-parser` for CSRF + project-list scrape
- `unzipper` for project-zip parsing
- `archiver` for fixture-zip generation (devDependency only)
- AGPL-3.0-or-later license

---

## File Structure

All paths are relative to the project root, which lives at `overleaf-mcp/` inside the existing `/home/houhd/code/overleaf_cc/` repo.

```
overleaf-mcp/
├── package.json                        Task 1
├── pnpm-lock.yaml                      Task 1 (auto)
├── tsconfig.json                       Task 1
├── vitest.config.ts                    Task 1
├── LICENSE                             Task 1 (AGPL-3.0)
├── README.md                           Task 13
├── .gitignore                          Task 1
├── scripts/
│   └── make-fixture-zip.mjs            Task 7
├── src/
│   ├── cli.ts                          Task 11
│   ├── config.ts                       Task 3
│   ├── errors.ts                       Task 2
│   ├── mcp/
│   │   ├── server.ts                   Task 10
│   │   └── tools/
│   │       ├── index.ts                Task 10
│   │       ├── projects.ts             Task 10
│   │       ├── docs.ts                 Task 10
│   │       └── compile.ts              Task 10
│   └── overleaf/
│       ├── http.ts                     Task 4
│       ├── auth.ts                     Task 5
│       ├── rest.ts                     Tasks 6, 7, 8
│       ├── zip.ts                      Task 7
│       ├── tree.ts                     Task 7
│       └── cache.ts                    Task 9
└── test/
    ├── unit/
    │   ├── errors.test.ts              Task 2
    │   ├── config.test.ts              Task 3
    │   ├── http.test.ts                Task 4
    │   ├── auth.test.ts                Task 5
    │   ├── rest.projects.test.ts       Task 6
    │   ├── rest.zip.test.ts            Task 7
    │   ├── tree.test.ts                Task 7
    │   ├── cache.test.ts               Task 9
    │   ├── rest.compile.test.ts        Task 8
    │   └── mcp-tools.test.ts           Task 10
    └── fixtures/
        ├── login.html                  Task 5
        ├── project-list.html           Task 6
        ├── csrf-meta.html              Task 5
        └── project.zip                 Task 7 (script-generated)
```

Each file has one clear responsibility. `src/overleaf/` is the Overleaf adapter (no MCP knowledge). `src/mcp/` exposes that adapter as MCP tools (no HTTP knowledge). `src/cli.ts` and `src/config.ts` are the entry / config layer.

---

## Task 1: Project Scaffolding

**Files:**
- Create: `overleaf-mcp/package.json`
- Create: `overleaf-mcp/tsconfig.json`
- Create: `overleaf-mcp/vitest.config.ts`
- Create: `overleaf-mcp/LICENSE`
- Create: `overleaf-mcp/.gitignore`

- [ ] **Step 1: Create the project directory**

```bash
cd /home/houhd/code/overleaf_cc
mkdir -p overleaf-mcp/src/mcp/tools overleaf-mcp/src/overleaf overleaf-mcp/scripts overleaf-mcp/test/unit overleaf-mcp/test/fixtures
cd overleaf-mcp
```

- [ ] **Step 2: Write package.json**

Path: `overleaf-mcp/package.json`

```json
{
  "name": "overleaf-mcp",
  "version": "0.1.0",
  "description": "MCP server for Overleaf Community Edition without git",
  "license": "AGPL-3.0-or-later",
  "type": "module",
  "bin": {
    "overleaf-mcp": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "make-fixtures": "node scripts/make-fixture-zip.mjs",
    "start": "node dist/cli.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "node-html-parser": "^7.0.0",
    "unzipper": "^0.12.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/unzipper": "^0.10.10",
    "archiver": "^7.0.1",
    "msw": "^2.4.0",
    "typescript": "^5.5.0",
    "vitest": "^2.1.0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

- [ ] **Step 3: Write tsconfig.json**

Path: `overleaf-mcp/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test", "scripts"]
}
```

- [ ] **Step 4: Write vitest.config.ts**

Path: `overleaf-mcp/vitest.config.ts`

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
})
```

- [ ] **Step 5: Write LICENSE**

Run from `overleaf-mcp/`:

```bash
curl -fsSL https://www.gnu.org/licenses/agpl-3.0.txt -o LICENSE
```

Verify: `wc -l LICENSE` should report ~661 lines.

- [ ] **Step 6: Write .gitignore**

Path: `overleaf-mcp/.gitignore`

```
node_modules/
dist/
.env
.env.local
coverage/
*.log
```

- [ ] **Step 7: Install dependencies**

Run: `pnpm install` (or `npm install`).
Expected: clean install, no errors. Lock file appears.

- [ ] **Step 8: Verify scaffolding**

Run: `pnpm typecheck`
Expected: PASS (no source files yet, but tsc completes).

Run: `pnpm test`
Expected: vitest reports "no test files found" — clean exit.

- [ ] **Step 9: Commit**

```bash
cd /home/houhd/code/overleaf_cc
git add overleaf-mcp/
git commit -m "feat(overleaf-mcp): scaffold v0.1 project"
```

---

## Task 2: Error Taxonomy

Define the error classes the rest of the codebase will throw. The MCP layer maps these to MCP error codes; the HTTP layer raises them based on response heuristics.

**Files:**
- Create: `overleaf-mcp/src/errors.ts`
- Create: `overleaf-mcp/test/unit/errors.test.ts`

- [ ] **Step 1: Write the failing test**

Path: `overleaf-mcp/test/unit/errors.test.ts`

```typescript
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
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm test test/unit/errors.test.ts`
Expected: FAIL — `Cannot find module '../../src/errors.js'`.

- [ ] **Step 3: Write the implementation**

Path: `overleaf-mcp/src/errors.ts`

```typescript
export type ErrorCode =
  | 'OVERLEAF_GENERIC'
  | 'OVERLEAF_AUTH_FAILED'
  | 'PROXY_AUTH_FAILED'
  | 'PROJECT_ACCESS_DENIED'
  | 'NETWORK_ERROR'
  | 'INVALID_CONFIG'
  | 'NOT_FOUND'

export class OverleafError extends Error {
  readonly code: ErrorCode
  readonly context: Record<string, unknown>

  constructor(code: ErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(message)
    this.name = this.constructor.name
    this.code = code
    this.context = context
  }
}

export class AuthFailedError extends OverleafError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super('OVERLEAF_AUTH_FAILED', message, context)
  }
}

export class ProxyAuthFailedError extends OverleafError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super('PROXY_AUTH_FAILED', message, context)
  }
}

export class ProjectAccessDeniedError extends OverleafError {
  constructor(projectId: string) {
    super('PROJECT_ACCESS_DENIED', `No access to project ${projectId}`, { projectId })
  }
}

export class NetworkError extends OverleafError {
  constructor(message: string, public override readonly cause?: unknown) {
    super('NETWORK_ERROR', message, {})
  }
}

export class InvalidConfigError extends OverleafError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super('INVALID_CONFIG', message, context)
  }
}

export class NotFoundError extends OverleafError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super('NOT_FOUND', message, context)
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm test test/unit/errors.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add overleaf-mcp/src/errors.ts overleaf-mcp/test/unit/errors.test.ts
git commit -m "feat(overleaf-mcp): add error taxonomy"
```

---

## Task 3: Config Loading

Resolve configuration from environment variables and an optional credentials file at `~/.config/overleaf-mcp/credentials.json`. Resolution order: env > file > error.

**Files:**
- Create: `overleaf-mcp/src/config.ts`
- Create: `overleaf-mcp/test/unit/config.test.ts`

- [ ] **Step 1: Write the failing test**

Path: `overleaf-mcp/test/unit/config.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { InvalidConfigError } from '../../src/errors.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('loadConfig', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'overleaf-mcp-test-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('reads URL and cookie from env', () => {
    const cfg = loadConfig({
      env: {
        OVERLEAF_URL: 'https://overleaf.example.com',
        OVERLEAF_SESSION_COOKIE: 'overleaf_session2=abc',
      },
      credentialsPath: join(tmp, 'noexist.json'),
    })
    expect(cfg.url).toBe('https://overleaf.example.com')
    expect(cfg.sessionCookie).toBe('overleaf_session2=abc')
    expect(cfg.extraHeaders).toEqual({})
  })

  it('parses OVERLEAF_EXTRA_HEADERS as JSON', () => {
    const cfg = loadConfig({
      env: {
        OVERLEAF_URL: 'https://o',
        OVERLEAF_SESSION_COOKIE: 'c',
        OVERLEAF_EXTRA_HEADERS: '{"CF-Access-Client-Id":"abc"}',
      },
      credentialsPath: join(tmp, 'noexist.json'),
    })
    expect(cfg.extraHeaders).toEqual({ 'CF-Access-Client-Id': 'abc' })
  })

  it('falls back to credentials file when env missing', () => {
    const path = join(tmp, 'creds.json')
    writeFileSync(
      path,
      JSON.stringify({
        url: 'https://from-file',
        session_cookie: 'overleaf_session2=fromfile',
        extra_headers: { 'X-Foo': 'bar' },
      }),
    )
    const cfg = loadConfig({ env: {}, credentialsPath: path })
    expect(cfg.url).toBe('https://from-file')
    expect(cfg.sessionCookie).toBe('overleaf_session2=fromfile')
    expect(cfg.extraHeaders).toEqual({ 'X-Foo': 'bar' })
  })

  it('env overrides file', () => {
    const path = join(tmp, 'creds.json')
    writeFileSync(path, JSON.stringify({ url: 'https://from-file', session_cookie: 'a' }))
    const cfg = loadConfig({
      env: { OVERLEAF_URL: 'https://from-env', OVERLEAF_SESSION_COOKIE: 'b' },
      credentialsPath: path,
    })
    expect(cfg.url).toBe('https://from-env')
    expect(cfg.sessionCookie).toBe('b')
  })

  it('throws InvalidConfigError when URL missing', () => {
    expect(() =>
      loadConfig({
        env: { OVERLEAF_SESSION_COOKIE: 'c' },
        credentialsPath: join(tmp, 'nope.json'),
      }),
    ).toThrow(InvalidConfigError)
  })

  it('throws InvalidConfigError when cookie missing', () => {
    expect(() =>
      loadConfig({
        env: { OVERLEAF_URL: 'https://o' },
        credentialsPath: join(tmp, 'nope.json'),
      }),
    ).toThrow(InvalidConfigError)
  })

  it('throws on malformed JSON in OVERLEAF_EXTRA_HEADERS', () => {
    expect(() =>
      loadConfig({
        env: {
          OVERLEAF_URL: 'https://o',
          OVERLEAF_SESSION_COOKIE: 'c',
          OVERLEAF_EXTRA_HEADERS: 'not-json',
        },
        credentialsPath: join(tmp, 'nope.json'),
      }),
    ).toThrow(InvalidConfigError)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm test test/unit/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Path: `overleaf-mcp/src/config.ts`

```typescript
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { InvalidConfigError } from './errors.js'

export interface Config {
  url: string
  sessionCookie: string
  extraHeaders: Record<string, string>
  debug: boolean
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
  credentialsPath?: string
}

interface CredentialsFile {
  url?: string
  session_cookie?: string
  extra_headers?: Record<string, string>
}

const DEFAULT_CREDENTIALS_PATH = join(homedir(), '.config', 'overleaf-mcp', 'credentials.json')

export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const env = opts.env ?? process.env
  const credentialsPath = opts.credentialsPath ?? DEFAULT_CREDENTIALS_PATH

  let fileCfg: CredentialsFile = {}
  if (existsSync(credentialsPath)) {
    try {
      fileCfg = JSON.parse(readFileSync(credentialsPath, 'utf-8')) as CredentialsFile
    } catch (err) {
      throw new InvalidConfigError(`Cannot parse credentials file ${credentialsPath}`, {
        cause: String(err),
      })
    }
  }

  const url = env.OVERLEAF_URL ?? fileCfg.url
  const sessionCookie = env.OVERLEAF_SESSION_COOKIE ?? fileCfg.session_cookie

  if (!url) {
    throw new InvalidConfigError(
      'OVERLEAF_URL is required (set the env var or run `overleaf-mcp login`).',
    )
  }
  if (!sessionCookie) {
    throw new InvalidConfigError(
      'OVERLEAF_SESSION_COOKIE is required (paste from devtools or run `overleaf-mcp login`).',
    )
  }

  let extraHeaders: Record<string, string> = fileCfg.extra_headers ?? {}
  if (env.OVERLEAF_EXTRA_HEADERS) {
    try {
      extraHeaders = JSON.parse(env.OVERLEAF_EXTRA_HEADERS) as Record<string, string>
    } catch (err) {
      throw new InvalidConfigError('OVERLEAF_EXTRA_HEADERS is not valid JSON', {
        cause: String(err),
      })
    }
  }

  return {
    url: url.replace(/\/$/, ''),
    sessionCookie,
    extraHeaders,
    debug: env.OVERLEAF_DEBUG === '1' || env.OVERLEAF_DEBUG === 'true',
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm test test/unit/config.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add overleaf-mcp/src/config.ts overleaf-mcp/test/unit/config.test.ts
git commit -m "feat(overleaf-mcp): add config loader"
```

---

## Task 4: HTTP Client

Wraps native `fetch` to thread the session cookie, CSRF token, and user-supplied extra headers through every outbound request. Maps response heuristics to error classes. Always uses `redirect: 'manual'` so a 302→/login is detectable as auth-expiry.

**Files:**
- Create: `overleaf-mcp/src/overleaf/http.ts`
- Create: `overleaf-mcp/test/unit/http.test.ts`

- [ ] **Step 1: Write the failing test**

Path: `overleaf-mcp/test/unit/http.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { OverleafHttp } from '../../src/overleaf/http.js'
import { AuthFailedError, ProxyAuthFailedError, NetworkError } from '../../src/errors.js'

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
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm test test/unit/http.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Path: `overleaf-mcp/src/overleaf/http.ts`

```typescript
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
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm test test/unit/http.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add overleaf-mcp/src/overleaf/http.ts overleaf-mcp/test/unit/http.test.ts
git commit -m "feat(overleaf-mcp): add HTTP client with extra-header pass-through"
```

---

## Task 5: Authentication

Two flows:

1. **Cookie validation:** given a pasted cookie, fetch `/project` and scrape the `<meta name="ol-csrfToken">` for write ops. Raises `AuthFailedError` if invalid.
2. **Passport login:** GET `/login`, scrape `_csrf` form field, POST `/login` with credentials, capture `Set-Cookie`.

**Files:**
- Create: `overleaf-mcp/src/overleaf/auth.ts`
- Create: `overleaf-mcp/test/unit/auth.test.ts`
- Create: `overleaf-mcp/test/fixtures/login.html`
- Create: `overleaf-mcp/test/fixtures/csrf-meta.html`

- [ ] **Step 1: Create the fixture files**

Path: `overleaf-mcp/test/fixtures/login.html`

```html
<!DOCTYPE html>
<html><head><title>Overleaf, Online LaTeX Editor</title></head><body>
<form action="/login" method="post">
<input type="hidden" name="_csrf" value="LOGIN-CSRF-TOKEN">
<input type="text" name="email">
<input type="password" name="password">
<button type="submit">Log In</button>
</form>
</body></html>
```

Path: `overleaf-mcp/test/fixtures/csrf-meta.html`

```html
<!DOCTYPE html>
<html><head>
<meta name="ol-csrfToken" content="POST-CSRF-TOKEN">
<meta name="ol-user_id" content="user-123">
<meta name="ol-usersEmail" content="me@example.com">
</head><body>Project dashboard</body></html>
```

- [ ] **Step 2: Write the failing test**

Path: `overleaf-mcp/test/unit/auth.test.ts`

```typescript
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
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `pnpm test test/unit/auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation**

Path: `overleaf-mcp/src/overleaf/auth.ts`

```typescript
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
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `pnpm test test/unit/auth.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add overleaf-mcp/src/overleaf/auth.ts overleaf-mcp/test/unit/auth.test.ts overleaf-mcp/test/fixtures/login.html overleaf-mcp/test/fixtures/csrf-meta.html
git commit -m "feat(overleaf-mcp): add cookie + passport auth"
```

---

## Task 6: REST — Project Listing

Scrape the `/project` HTML for the user's project list. Modern Overleaf 5.x renders the list into `<meta name="ol-prefetchedProjectsBlob">` as JSON.

**Files:**
- Create: `overleaf-mcp/src/overleaf/rest.ts`
- Create: `overleaf-mcp/test/unit/rest.projects.test.ts`
- Create: `overleaf-mcp/test/fixtures/project-list.html`

- [ ] **Step 1: Create the fixture**

Path: `overleaf-mcp/test/fixtures/project-list.html`

```html
<!DOCTYPE html>
<html><head>
<meta name="ol-csrfToken" content="csrf">
<meta name="ol-prefetchedProjectsBlob" content='{"projects":[{"id":"p1","name":"Thesis","lastUpdated":"2026-04-20T12:00:00Z","owner":{"email":"me@example.com"}},{"id":"p2","name":"Paper","lastUpdated":"2026-04-22T13:00:00Z","owner":{"email":"me@example.com"}}]}'>
</head><body></body></html>
```

- [ ] **Step 2: Write the failing test**

Path: `overleaf-mcp/test/unit/rest.projects.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OverleafRest } from '../../src/overleaf/rest.js'
import { OverleafHttp } from '../../src/overleaf/http.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '..', 'fixtures')
const projectListHtml = readFileSync(join(FIXTURES, 'project-list.html'), 'utf-8')

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function makeRest() {
  const httpClient = new OverleafHttp({
    url: 'https://o.example',
    sessionCookie: 'overleaf_session2=abc',
    csrfToken: 'csrf',
    extraHeaders: {},
  })
  return new OverleafRest(httpClient)
}

describe('OverleafRest.listProjects', () => {
  it('parses the prefetched projects blob', async () => {
    server.use(
      http.get('https://o.example/project', () => HttpResponse.html(projectListHtml)),
    )
    const projects = await makeRest().listProjects()
    expect(projects).toEqual([
      { id: 'p1', name: 'Thesis', lastUpdated: '2026-04-20T12:00:00Z', ownerEmail: 'me@example.com' },
      { id: 'p2', name: 'Paper', lastUpdated: '2026-04-22T13:00:00Z', ownerEmail: 'me@example.com' },
    ])
  })

  it('returns empty array when blob has no projects field', async () => {
    server.use(
      http.get('https://o.example/project', () =>
        HttpResponse.html(
          '<html><head><meta name="ol-prefetchedProjectsBlob" content=\'{"projects":[]}\'></head></html>',
        ),
      ),
    )
    const projects = await makeRest().listProjects()
    expect(projects).toEqual([])
  })

  it('throws when blob meta tag is missing', async () => {
    server.use(
      http.get('https://o.example/project', () => HttpResponse.html('<html></html>')),
    )
    await expect(makeRest().listProjects()).rejects.toThrow(/prefetchedProjectsBlob/)
  })
})
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `pnpm test test/unit/rest.projects.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the initial implementation**

Path: `overleaf-mcp/src/overleaf/rest.ts`

```typescript
import { parse as parseHtml } from 'node-html-parser'
import { OverleafHttp } from './http.js'
import { OverleafError } from '../errors.js'

export interface ProjectSummary {
  id: string
  name: string
  lastUpdated: string
  ownerEmail: string
}

export interface CompileOutputFile {
  path: string
  url: string
  type: string
  build?: string
}

export interface CompileResponse {
  status: string
  outputFiles: CompileOutputFile[]
  compileGroup?: string
  pdfDownloadDomain?: string
}

export class OverleafRest {
  constructor(private readonly http: OverleafHttp) {}

  async listProjects(): Promise<ProjectSummary[]> {
    const res = await this.http.get('/project')
    const html = await res.text()
    const root = parseHtml(html)
    const meta = root.querySelector('meta[name="ol-prefetchedProjectsBlob"]')
    const content = meta?.getAttribute('content')
    if (!content) {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        'Could not find <meta name="ol-prefetchedProjectsBlob"> in /project HTML',
      )
    }
    let blob: { projects?: Array<Record<string, unknown>> }
    try {
      blob = JSON.parse(content) as typeof blob
    } catch (err) {
      throw new OverleafError('OVERLEAF_GENERIC', 'Invalid JSON in projects blob', {
        cause: String(err),
      })
    }
    return (blob.projects ?? []).map((p) => ({
      id: String(p.id),
      name: String(p.name),
      lastUpdated: String(p.lastUpdated),
      ownerEmail: String((p.owner as { email?: string } | undefined)?.email ?? ''),
    }))
  }
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `pnpm test test/unit/rest.projects.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add overleaf-mcp/src/overleaf/rest.ts overleaf-mcp/test/unit/rest.projects.test.ts overleaf-mcp/test/fixtures/project-list.html
git commit -m "feat(overleaf-mcp): add list_projects via /project HTML scrape"
```

---

## Task 7: Project Zip Parser + Tree + Fixture Generator

Three pieces: a script that generates a deterministic `project.zip` fixture using the `archiver` lib (no shell), a parser that turns zip bytes into typed entries, and a `ProjectTree` cache class that exposes lookups by path.

**Files:**
- Create: `overleaf-mcp/scripts/make-fixture-zip.mjs`
- Create: `overleaf-mcp/src/overleaf/zip.ts`
- Create: `overleaf-mcp/src/overleaf/tree.ts`
- Modify: `overleaf-mcp/src/overleaf/rest.ts` (add `downloadProjectZip`)
- Create: `overleaf-mcp/test/unit/rest.zip.test.ts`
- Create: `overleaf-mcp/test/unit/tree.test.ts`
- Append to: `overleaf-mcp/test/unit/rest.projects.test.ts` (zip download test)
- Generate: `overleaf-mcp/test/fixtures/project.zip`

- [ ] **Step 1: Write the fixture-zip generator script**

Path: `overleaf-mcp/scripts/make-fixture-zip.mjs`

```javascript
import archiver from 'archiver'
import { createWriteStream, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'test', 'fixtures', 'project.zip')
mkdirSync(dirname(out), { recursive: true })

const stream = createWriteStream(out)
const archive = archiver('zip', { zlib: { level: 0 } }) // store-only, deterministic

archive.pipe(stream)
archive.append('\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n', {
  name: 'main.tex',
})
archive.append('@article{x, title={Y}, year={2026}}\n', { name: 'refs.bib' })
archive.append(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
  name: 'figures/img.png',
})

await new Promise((resolve, reject) => {
  stream.on('close', resolve)
  archive.on('error', reject)
  archive.finalize()
})

console.log(`wrote ${out}, ${archive.pointer()} bytes`)
```

- [ ] **Step 2: Generate the fixture**

Run from `overleaf-mcp/`:

```bash
pnpm install   # if not already done
pnpm make-fixtures
```

Expected: `test/fixtures/project.zip` is created (~600 bytes).

Verify with `unzip -l test/fixtures/project.zip` — should show `main.tex`, `figures/img.png`, `refs.bib`.

- [ ] **Step 3: Write the failing zip parser test**

Path: `overleaf-mcp/test/unit/rest.zip.test.ts`

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseProjectZip } from '../../src/overleaf/zip.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '..', 'fixtures')
const zipBytes = readFileSync(join(FIXTURES, 'project.zip'))

describe('parseProjectZip', () => {
  it('returns text and binary entries with paths', async () => {
    const entries = await parseProjectZip(zipBytes)
    const byPath = new Map(entries.map((e) => [e.path, e]))

    expect(byPath.has('main.tex')).toBe(true)
    expect(byPath.has('refs.bib')).toBe(true)
    expect(byPath.has('figures/img.png')).toBe(true)

    const tex = byPath.get('main.tex')!
    expect(tex.kind).toBe('text')
    expect((tex.content as string)).toContain('\\documentclass')

    const png = byPath.get('figures/img.png')!
    expect(png.kind).toBe('binary')
    expect(Buffer.isBuffer(png.content)).toBe(true)
  })

  it('returns empty entries for an empty zip', async () => {
    const empty = Buffer.from([
      0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ])
    const entries = await parseProjectZip(empty)
    expect(entries).toEqual([])
  })
})
```

- [ ] **Step 4: Run the test, verify it fails**

Run: `pnpm test test/unit/rest.zip.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Write the zip parser**

Path: `overleaf-mcp/src/overleaf/zip.ts`

```typescript
import unzipper from 'unzipper'

export type ProjectEntry =
  | { kind: 'text'; path: string; content: string }
  | { kind: 'binary'; path: string; content: Buffer }

const TEXT_EXTENSIONS = new Set([
  '.tex',
  '.bib',
  '.cls',
  '.sty',
  '.bst',
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.tsv',
  '.r',
  '.py',
  '.html',
  '.css',
  '.js',
  '.ts',
])

function isText(path: string): boolean {
  const lastDot = path.lastIndexOf('.')
  if (lastDot < 0) return false
  return TEXT_EXTENSIONS.has(path.slice(lastDot).toLowerCase())
}

export async function parseProjectZip(bytes: Buffer | Uint8Array): Promise<ProjectEntry[]> {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const directory = await unzipper.Open.buffer(buf)
  const entries: ProjectEntry[] = []
  for (const file of directory.files) {
    if (file.type !== 'File') continue
    const content = await file.buffer()
    if (isText(file.path)) {
      entries.push({ kind: 'text', path: file.path, content: content.toString('utf-8') })
    } else {
      entries.push({ kind: 'binary', path: file.path, content })
    }
  }
  return entries
}
```

- [ ] **Step 6: Run the test, verify it passes**

Run: `pnpm test test/unit/rest.zip.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 7: Write the failing tree test**

Path: `overleaf-mcp/test/unit/tree.test.ts`

```typescript
import { describe, it, expect } from 'vitest'
import { ProjectTree, type ProjectEntry } from '../../src/overleaf/tree.js'

const entries: ProjectEntry[] = [
  { kind: 'text', path: 'main.tex', content: 'Hello' },
  { kind: 'text', path: 'chapters/intro.tex', content: 'Intro' },
  { kind: 'binary', path: 'figures/img.png', content: Buffer.from([0]) },
]

describe('ProjectTree', () => {
  it('returns text content by path', () => {
    const tree = new ProjectTree(entries)
    expect(tree.readDoc('main.tex')).toBe('Hello')
    expect(tree.readDoc('chapters/intro.tex')).toBe('Intro')
  })

  it('returns binary content by path', () => {
    const tree = new ProjectTree(entries)
    expect(tree.readFile('figures/img.png')!.length).toBe(1)
  })

  it('returns null for nonexistent paths', () => {
    const tree = new ProjectTree(entries)
    expect(tree.readDoc('missing.tex')).toBeNull()
    expect(tree.readFile('missing.png')).toBeNull()
  })

  it('throws when reading text as binary or vice versa', () => {
    const tree = new ProjectTree(entries)
    expect(() => tree.readDoc('figures/img.png')).toThrow(/binary/)
    expect(() => tree.readFile('main.tex')).toThrow(/text/)
  })

  it('lists the tree as folders + files', () => {
    const tree = new ProjectTree(entries)
    const json = tree.asTree()
    expect(json.files.sort()).toEqual(['main.tex'])
    expect(Object.keys(json.folders).sort()).toEqual(['chapters', 'figures'])
    expect(json.folders.chapters!.files).toEqual(['intro.tex'])
    expect(json.folders.figures!.files).toEqual(['img.png'])
  })
})
```

- [ ] **Step 8: Run the test, verify it fails**

Run: `pnpm test test/unit/tree.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 9: Write the tree implementation**

Path: `overleaf-mcp/src/overleaf/tree.ts`

```typescript
import { OverleafError } from '../errors.js'
import type { ProjectEntry as ZipEntry } from './zip.js'

export type ProjectEntry = ZipEntry

export interface TreeNode {
  files: string[]
  folders: Record<string, TreeNode>
}

export class ProjectTree {
  private readonly byPath: Map<string, ProjectEntry>

  constructor(entries: ProjectEntry[]) {
    this.byPath = new Map(entries.map((e) => [e.path, e]))
  }

  readDoc(path: string): string | null {
    const entry = this.byPath.get(path)
    if (!entry) return null
    if (entry.kind !== 'text') {
      throw new OverleafError('NOT_FOUND', `Path ${path} is binary, not text`)
    }
    return entry.content
  }

  readFile(path: string): Buffer | null {
    const entry = this.byPath.get(path)
    if (!entry) return null
    if (entry.kind !== 'binary') {
      throw new OverleafError('NOT_FOUND', `Path ${path} is text, not binary`)
    }
    return entry.content
  }

  asTree(): TreeNode {
    const root: TreeNode = { files: [], folders: {} }
    for (const path of this.byPath.keys()) {
      const parts = path.split('/')
      let cursor = root
      for (let i = 0; i < parts.length - 1; i++) {
        const folder = parts[i]!
        cursor.folders[folder] ??= { files: [], folders: {} }
        cursor = cursor.folders[folder]!
      }
      cursor.files.push(parts[parts.length - 1]!)
    }
    return root
  }

  listPaths(): string[] {
    return Array.from(this.byPath.keys()).sort()
  }
}
```

- [ ] **Step 10: Run the test, verify it passes**

Run: `pnpm test test/unit/tree.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 11: Add the zip-download REST endpoint**

Modify: `overleaf-mcp/src/overleaf/rest.ts`

Add to the `OverleafRest` class (after `listProjects`):

```typescript
  async downloadProjectZip(projectId: string): Promise<Buffer> {
    const res = await this.http.get(`/project/${encodeURIComponent(projectId)}/download/zip`)
    if (!res.ok) {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        `download/zip returned ${res.status} for ${projectId}`,
      )
    }
    const arrayBuf = await res.arrayBuffer()
    return Buffer.from(arrayBuf)
  }
```

- [ ] **Step 12: Append a zip-download test to rest.projects.test.ts**

Append to `overleaf-mcp/test/unit/rest.projects.test.ts`:

```typescript
import { readFileSync as _read } from 'node:fs'
const projectZip = _read(join(FIXTURES, 'project.zip'))

describe('OverleafRest.downloadProjectZip', () => {
  it('returns the zip bytes', async () => {
    server.use(
      http.get('https://o.example/project/p1/download/zip', () =>
        HttpResponse.arrayBuffer(
          projectZip.buffer.slice(
            projectZip.byteOffset,
            projectZip.byteOffset + projectZip.byteLength,
          ),
        ),
      ),
    )
    const buf = await makeRest().downloadProjectZip('p1')
    expect(buf.equals(projectZip)).toBe(true)
  })
})
```

- [ ] **Step 13: Run all tests, verify they pass**

Run: `pnpm test test/unit/`
Expected: PASS, all suites green.

- [ ] **Step 14: Commit**

```bash
git add overleaf-mcp/src/overleaf/ overleaf-mcp/scripts/ overleaf-mcp/test/unit/rest.zip.test.ts overleaf-mcp/test/unit/tree.test.ts overleaf-mcp/test/unit/rest.projects.test.ts overleaf-mcp/test/fixtures/project.zip
git commit -m "feat(overleaf-mcp): add project zip download + tree cache"
```

---

## Task 8: REST — Compile, Logs, PDF, Binary Files

Three more endpoints: `compile`, `downloadOutputFile` (fetches a build URL like `/project/:id/build/:bid/output/output.log` or `output.pdf`), and `downloadFile` for binary file content by file ID.

**Files:**
- Modify: `overleaf-mcp/src/overleaf/rest.ts`
- Create: `overleaf-mcp/test/unit/rest.compile.test.ts`

- [ ] **Step 1: Write the failing test**

Path: `overleaf-mcp/test/unit/rest.compile.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { OverleafHttp } from '../../src/overleaf/http.js'
import { OverleafRest } from '../../src/overleaf/rest.js'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function makeRest() {
  return new OverleafRest(
    new OverleafHttp({
      url: 'https://o.example',
      sessionCookie: 'overleaf_session2=abc',
      csrfToken: 'csrf',
      extraHeaders: {},
    }),
  )
}

describe('OverleafRest.compile', () => {
  it('POSTs and returns the parsed compile response', async () => {
    server.use(
      http.post('https://o.example/project/p1/compile', async ({ request }) => {
        const url = new URL(request.url)
        expect(url.searchParams.get('auto_compile')).toBe('true')
        const body = (await request.json()) as Record<string, unknown>
        expect(body.draft).toBe(false)
        expect(body.stopOnFirstError).toBe(false)
        return HttpResponse.json({
          status: 'success',
          outputFiles: [
            { path: 'output.pdf', url: '/project/p1/build/b1/output/output.pdf', type: 'pdf' },
            { path: 'output.log', url: '/project/p1/build/b1/output/output.log', type: 'log' },
          ],
        })
      }),
    )
    const result = await makeRest().compile('p1')
    expect(result.status).toBe('success')
    expect(result.outputFiles.map((f) => f.path)).toEqual(['output.pdf', 'output.log'])
  })

  it('passes draft and stopOnFirstError', async () => {
    server.use(
      http.post('https://o.example/project/p1/compile', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        expect(body.draft).toBe(true)
        expect(body.stopOnFirstError).toBe(true)
        return HttpResponse.json({ status: 'success', outputFiles: [] })
      }),
    )
    await makeRest().compile('p1', { draft: true, stopOnFirstError: true })
  })
})

describe('OverleafRest.downloadOutputFile', () => {
  it('returns the bytes', async () => {
    server.use(
      http.get('https://o.example/project/p1/build/b1/output/output.log', () =>
        HttpResponse.text('LaTeX log lines'),
      ),
    )
    const buf = await makeRest().downloadOutputFile('/project/p1/build/b1/output/output.log')
    expect(buf.toString('utf-8')).toBe('LaTeX log lines')
  })
})

describe('OverleafRest.downloadFile', () => {
  it('GETs /project/:id/file/:fid and returns bytes', async () => {
    server.use(
      http.get('https://o.example/project/p1/file/f1', () =>
        HttpResponse.arrayBuffer(new Uint8Array([1, 2, 3]).buffer),
      ),
    )
    const buf = await makeRest().downloadFile('p1', 'f1')
    expect(Array.from(buf)).toEqual([1, 2, 3])
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm test test/unit/rest.compile.test.ts`
Expected: FAIL — methods not defined on `OverleafRest`.

- [ ] **Step 3: Add the implementations**

Modify: `overleaf-mcp/src/overleaf/rest.ts`

Add to the `OverleafRest` class:

```typescript
  async compile(
    projectId: string,
    opts: { draft?: boolean; stopOnFirstError?: boolean; rootResourcePath?: string } = {},
  ): Promise<CompileResponse> {
    const res = await this.http.postJson(
      `/project/${encodeURIComponent(projectId)}/compile?auto_compile=true`,
      {
        check: 'silent',
        draft: opts.draft ?? false,
        incrementalCompilesEnabled: true,
        rootResourcePath: opts.rootResourcePath ?? 'main.tex',
        stopOnFirstError: opts.stopOnFirstError ?? false,
      },
    )
    if (!res.ok) {
      throw new OverleafError('OVERLEAF_GENERIC', `compile returned ${res.status}`)
    }
    return (await res.json()) as CompileResponse
  }

  async downloadOutputFile(buildUrl: string): Promise<Buffer> {
    const res = await this.http.get(buildUrl)
    if (!res.ok) {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        `output file ${buildUrl} returned ${res.status}`,
      )
    }
    return Buffer.from(await res.arrayBuffer())
  }

  async downloadFile(projectId: string, fileId: string): Promise<Buffer> {
    const res = await this.http.get(
      `/project/${encodeURIComponent(projectId)}/file/${encodeURIComponent(fileId)}`,
    )
    if (!res.ok) {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        `file ${fileId} returned ${res.status}`,
      )
    }
    return Buffer.from(await res.arrayBuffer())
  }
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `pnpm test test/unit/`
Expected: PASS, all tests across all files.

- [ ] **Step 5: Commit**

```bash
git add overleaf-mcp/src/overleaf/rest.ts overleaf-mcp/test/unit/rest.compile.test.ts
git commit -m "feat(overleaf-mcp): add compile, output, and file download endpoints"
```

---

## Task 9: Project Cache

A small TTL cache that owns the zip + tree per project. The MCP layer will call `cache.get(projectId)` and trust it to refresh as needed. Coalesces concurrent requests for the same project so we don't double-download zips.

**Files:**
- Create: `overleaf-mcp/src/overleaf/cache.ts`
- Create: `overleaf-mcp/test/unit/cache.test.ts`

- [ ] **Step 1: Write the failing test**

Path: `overleaf-mcp/test/unit/cache.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest'
import { ProjectCache } from '../../src/overleaf/cache.js'
import { ProjectTree } from '../../src/overleaf/tree.js'

describe('ProjectCache', () => {
  it('fetches once within the TTL', async () => {
    const fetcher = vi.fn(async (id: string) =>
      new ProjectTree([{ kind: 'text', path: 'main.tex', content: id }]),
    )
    const cache = new ProjectCache(fetcher, { ttlMs: 60_000 })
    const a = await cache.get('p1')
    const b = await cache.get('p1')
    expect(a).toBe(b)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refetches after TTL expiry', async () => {
    const fetcher = vi.fn(async (id: string) =>
      new ProjectTree([{ kind: 'text', path: 'main.tex', content: id }]),
    )
    const cache = new ProjectCache(fetcher, { ttlMs: 10 })
    await cache.get('p1')
    await new Promise((r) => setTimeout(r, 20))
    await cache.get('p1')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('invalidate() forces a refetch', async () => {
    const fetcher = vi.fn(async (id: string) =>
      new ProjectTree([{ kind: 'text', path: 'main.tex', content: id }]),
    )
    const cache = new ProjectCache(fetcher, { ttlMs: 60_000 })
    await cache.get('p1')
    cache.invalidate('p1')
    await cache.get('p1')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent requests for the same id', async () => {
    let resolved = false
    const fetcher = vi.fn(async (id: string) => {
      await new Promise((r) => setTimeout(r, 10))
      resolved = true
      return new ProjectTree([{ kind: 'text', path: 'main.tex', content: id }])
    })
    const cache = new ProjectCache(fetcher, { ttlMs: 60_000 })
    const [a, b] = await Promise.all([cache.get('p1'), cache.get('p1')])
    expect(a).toBe(b)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(resolved).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm test test/unit/cache.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Path: `overleaf-mcp/src/overleaf/cache.ts`

```typescript
import { ProjectTree } from './tree.js'

export interface CacheOptions {
  ttlMs?: number
}

interface Entry {
  tree: ProjectTree
  fetchedAt: number
}

export class ProjectCache {
  private readonly entries = new Map<string, Entry>()
  private readonly inflight = new Map<string, Promise<ProjectTree>>()
  private readonly ttlMs: number

  constructor(
    private readonly fetcher: (projectId: string) => Promise<ProjectTree>,
    opts: CacheOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 60_000
  }

  async get(projectId: string): Promise<ProjectTree> {
    const existing = this.entries.get(projectId)
    if (existing && Date.now() - existing.fetchedAt < this.ttlMs) {
      return existing.tree
    }
    const inflight = this.inflight.get(projectId)
    if (inflight) return inflight

    const promise = this.fetcher(projectId)
      .then((tree) => {
        this.entries.set(projectId, { tree, fetchedAt: Date.now() })
        this.inflight.delete(projectId)
        return tree
      })
      .catch((err: unknown) => {
        this.inflight.delete(projectId)
        throw err
      })
    this.inflight.set(projectId, promise)
    return promise
  }

  invalidate(projectId: string) {
    this.entries.delete(projectId)
  }

  invalidateAll() {
    this.entries.clear()
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm test test/unit/cache.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add overleaf-mcp/src/overleaf/cache.ts overleaf-mcp/test/unit/cache.test.ts
git commit -m "feat(overleaf-mcp): add TTL project cache"
```

---

## Task 10: MCP Server + Tools

Wire the Overleaf adapter into MCP. One file per tool group; a single `register(server, ctx)` per group keeps things composable.

**Files:**
- Create: `overleaf-mcp/src/mcp/server.ts`
- Create: `overleaf-mcp/src/mcp/tools/index.ts`
- Create: `overleaf-mcp/src/mcp/tools/projects.ts`
- Create: `overleaf-mcp/src/mcp/tools/docs.ts`
- Create: `overleaf-mcp/src/mcp/tools/compile.ts`
- Create: `overleaf-mcp/test/unit/mcp-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Path: `overleaf-mcp/test/unit/mcp-tools.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildContext } from '../../src/mcp/server.js'
import { handleListProjects, handleGetProjectTree } from '../../src/mcp/tools/projects.js'
import { handleReadDoc, handleReadFile } from '../../src/mcp/tools/docs.js'
import {
  handleCompile,
  handleReadCompileLog,
  handleDownloadPdf,
} from '../../src/mcp/tools/compile.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '..', 'fixtures')
const projectListHtml = readFileSync(join(FIXTURES, 'project-list.html'), 'utf-8')
const projectZip = readFileSync(join(FIXTURES, 'project.zip'))

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const ctx = buildContext({
  url: 'https://o.example',
  sessionCookie: 'overleaf_session2=abc',
  extraHeaders: {},
  debug: false,
  csrfToken: 'csrf',
})

function arrayBufferOf(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

describe('list_projects tool', () => {
  it('returns id+name list', async () => {
    server.use(
      http.get('https://o.example/project', () => HttpResponse.html(projectListHtml)),
    )
    const out = await handleListProjects(ctx, {})
    expect(out.projects).toHaveLength(2)
    expect(out.projects[0]).toMatchObject({ id: 'p1', name: 'Thesis' })
  })
})

describe('get_project_tree tool', () => {
  it('returns the parsed tree', async () => {
    server.use(
      http.get('https://o.example/project/p1/download/zip', () =>
        HttpResponse.arrayBuffer(arrayBufferOf(projectZip)),
      ),
    )
    const out = await handleGetProjectTree(ctx, { projectId: 'p1' })
    expect(out.tree.files.sort()).toEqual(['main.tex', 'refs.bib'])
    expect(out.tree.folders.figures!.files).toEqual(['img.png'])
  })
})

describe('read_doc tool', () => {
  it('returns text content', async () => {
    server.use(
      http.get('https://o.example/project/p2/download/zip', () =>
        HttpResponse.arrayBuffer(arrayBufferOf(projectZip)),
      ),
    )
    const out = await handleReadDoc(ctx, { projectId: 'p2', path: 'main.tex' })
    expect(out.content).toContain('\\documentclass')
  })
})

describe('read_file tool', () => {
  it('returns base64-encoded bytes', async () => {
    server.use(
      http.get('https://o.example/project/p3/download/zip', () =>
        HttpResponse.arrayBuffer(arrayBufferOf(projectZip)),
      ),
    )
    const out = await handleReadFile(ctx, { projectId: 'p3', path: 'figures/img.png' })
    const decoded = Buffer.from(out.contentBase64, 'base64')
    expect(decoded[0]).toBe(0x89) // PNG magic
  })
})

describe('compile tool', () => {
  it('triggers compile and returns log + pdf URLs', async () => {
    server.use(
      http.post('https://o.example/project/p4/compile', () =>
        HttpResponse.json({
          status: 'success',
          outputFiles: [
            { path: 'output.pdf', url: '/project/p4/build/b/output/output.pdf', type: 'pdf' },
            { path: 'output.log', url: '/project/p4/build/b/output/output.log', type: 'log' },
          ],
        }),
      ),
    )
    const out = await handleCompile(ctx, { projectId: 'p4' })
    expect(out.status).toBe('success')
    expect(out.logUrl).toBe('/project/p4/build/b/output/output.log')
    expect(out.pdfUrl).toBe('/project/p4/build/b/output/output.pdf')
  })
})

describe('read_compile_log tool', () => {
  it('returns log text', async () => {
    server.use(
      http.post('https://o.example/project/p5/compile', () =>
        HttpResponse.json({
          status: 'success',
          outputFiles: [{ path: 'output.log', url: '/project/p5/build/b/output/output.log', type: 'log' }],
        }),
      ),
      http.get('https://o.example/project/p5/build/b/output/output.log', () =>
        HttpResponse.text('LaTeX Warning: blah'),
      ),
    )
    const out = await handleReadCompileLog(ctx, { projectId: 'p5' })
    expect(out.log).toContain('LaTeX Warning')
  })
})

describe('download_pdf tool', () => {
  it('returns base64-encoded pdf bytes', async () => {
    server.use(
      http.post('https://o.example/project/p6/compile', () =>
        HttpResponse.json({
          status: 'success',
          outputFiles: [{ path: 'output.pdf', url: '/project/p6/build/b/output/output.pdf', type: 'pdf' }],
        }),
      ),
      http.get('https://o.example/project/p6/build/b/output/output.pdf', () =>
        HttpResponse.arrayBuffer(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer),
      ),
    )
    const out = await handleDownloadPdf(ctx, { projectId: 'p6' })
    const decoded = Buffer.from(out.pdfBase64, 'base64')
    expect(decoded.toString('utf-8').startsWith('%PDF')).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm test test/unit/mcp-tools.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the context builder + MCP server bootstrap**

Path: `overleaf-mcp/src/mcp/server.ts`

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { OverleafHttp } from '../overleaf/http.js'
import { OverleafRest } from '../overleaf/rest.js'
import { ProjectCache } from '../overleaf/cache.js'
import { parseProjectZip } from '../overleaf/zip.js'
import { ProjectTree } from '../overleaf/tree.js'
import { registerAllTools } from './tools/index.js'

export interface ServerContext {
  http: OverleafHttp
  rest: OverleafRest
  cache: ProjectCache
}

export interface ContextOptions {
  url: string
  sessionCookie: string
  csrfToken: string
  extraHeaders: Record<string, string>
  debug: boolean
  cacheTtlMs?: number
}

export function buildContext(opts: ContextOptions): ServerContext {
  const http = new OverleafHttp({
    url: opts.url,
    sessionCookie: opts.sessionCookie,
    csrfToken: opts.csrfToken,
    extraHeaders: opts.extraHeaders,
  })
  const rest = new OverleafRest(http)
  const cache = new ProjectCache(
    async (projectId: string) => {
      const bytes = await rest.downloadProjectZip(projectId)
      const entries = await parseProjectZip(bytes)
      return new ProjectTree(entries)
    },
    { ttlMs: opts.cacheTtlMs ?? 60_000 },
  )
  return { http, rest, cache }
}

export async function runMcpServer(ctx: ServerContext) {
  const server = new Server(
    { name: 'overleaf-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )
  registerAllTools(server, ctx)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
```

- [ ] **Step 4: Write the project tools**

Path: `overleaf-mcp/src/mcp/tools/projects.ts`

```typescript
import type { ServerContext } from '../server.js'
import type { TreeNode } from '../../overleaf/tree.js'

export async function handleListProjects(
  ctx: ServerContext,
  _input: Record<string, never>,
): Promise<{ projects: Array<{ id: string; name: string; lastUpdated: string; ownerEmail: string }> }> {
  const projects = await ctx.rest.listProjects()
  return { projects }
}

export async function handleGetProjectTree(
  ctx: ServerContext,
  input: { projectId: string },
): Promise<{ tree: TreeNode }> {
  const tree = await ctx.cache.get(input.projectId)
  return { tree: tree.asTree() }
}
```

- [ ] **Step 5: Write the doc tools**

Path: `overleaf-mcp/src/mcp/tools/docs.ts`

```typescript
import type { ServerContext } from '../server.js'
import { NotFoundError } from '../../errors.js'

export async function handleReadDoc(
  ctx: ServerContext,
  input: { projectId: string; path: string },
): Promise<{ content: string }> {
  const tree = await ctx.cache.get(input.projectId)
  const content = tree.readDoc(input.path)
  if (content === null) {
    throw new NotFoundError(`No doc at ${input.path} in project ${input.projectId}`)
  }
  return { content }
}

export async function handleReadFile(
  ctx: ServerContext,
  input: { projectId: string; path: string },
): Promise<{ contentBase64: string }> {
  const tree = await ctx.cache.get(input.projectId)
  const buf = tree.readFile(input.path)
  if (buf === null) {
    throw new NotFoundError(`No file at ${input.path} in project ${input.projectId}`)
  }
  return { contentBase64: buf.toString('base64') }
}
```

- [ ] **Step 6: Write the compile tools**

Path: `overleaf-mcp/src/mcp/tools/compile.ts`

```typescript
import type { ServerContext } from '../server.js'
import { OverleafError } from '../../errors.js'

interface CompileResult {
  status: string
  pdfUrl: string | null
  logUrl: string | null
}

async function compileAndCache(
  ctx: ServerContext,
  projectId: string,
  opts: { draft?: boolean; stopOnFirstError?: boolean } = {},
): Promise<CompileResult> {
  const res = await ctx.rest.compile(projectId, opts)
  const pdf = res.outputFiles.find((f) => f.type === 'pdf' || f.path === 'output.pdf')
  const log = res.outputFiles.find((f) => f.type === 'log' || f.path === 'output.log')
  ctx.cache.invalidate(projectId)
  return {
    status: res.status,
    pdfUrl: pdf?.url ?? null,
    logUrl: log?.url ?? null,
  }
}

export async function handleCompile(
  ctx: ServerContext,
  input: { projectId: string; draft?: boolean; stopOnFirstError?: boolean },
): Promise<CompileResult> {
  return compileAndCache(ctx, input.projectId, {
    draft: input.draft,
    stopOnFirstError: input.stopOnFirstError,
  })
}

export async function handleReadCompileLog(
  ctx: ServerContext,
  input: { projectId: string },
): Promise<{ log: string }> {
  const result = await compileAndCache(ctx, input.projectId)
  if (!result.logUrl) {
    throw new OverleafError('NOT_FOUND', `No log produced for project ${input.projectId}`)
  }
  const buf = await ctx.rest.downloadOutputFile(result.logUrl)
  return { log: buf.toString('utf-8') }
}

export async function handleDownloadPdf(
  ctx: ServerContext,
  input: { projectId: string },
): Promise<{ pdfBase64: string }> {
  const result = await compileAndCache(ctx, input.projectId)
  if (!result.pdfUrl) {
    throw new OverleafError(
      'NOT_FOUND',
      `No PDF produced for project ${input.projectId} (compile status: ${result.status})`,
    )
  }
  const buf = await ctx.rest.downloadOutputFile(result.pdfUrl)
  return { pdfBase64: buf.toString('base64') }
}
```

- [ ] **Step 7: Write the tool registration**

Path: `overleaf-mcp/src/mcp/tools/index.ts`

```typescript
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { ServerContext } from '../server.js'
import { handleListProjects, handleGetProjectTree } from './projects.js'
import { handleReadDoc, handleReadFile } from './docs.js'
import { handleCompile, handleReadCompileLog, handleDownloadPdf } from './compile.js'
import { OverleafError } from '../../errors.js'

const TOOL_DEFINITIONS = [
  {
    name: 'list_projects',
    description: 'List Overleaf projects accessible to the configured account.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_project_tree',
    description: 'Return the file/folder tree of a project.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
  {
    name: 'read_doc',
    description: 'Read a text document by path within a project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['projectId', 'path'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a binary file by path within a project (returned base64).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['projectId', 'path'],
    },
  },
  {
    name: 'compile',
    description: 'Trigger a LaTeX compile and return output URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        draft: { type: 'boolean' },
        stopOnFirstError: { type: 'boolean' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'read_compile_log',
    description: 'Compile and return the output.log contents.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
  {
    name: 'download_pdf',
    description: 'Compile and return the output.pdf bytes (base64).',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
] as const

export function registerAllTools(server: Server, ctx: ServerContext) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((t) => ({ ...t })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params
    try {
      switch (name) {
        case 'list_projects':
          return wrap(await handleListProjects(ctx, args as Record<string, never>))
        case 'get_project_tree':
          return wrap(await handleGetProjectTree(ctx, args as { projectId: string }))
        case 'read_doc':
          return wrap(await handleReadDoc(ctx, args as { projectId: string; path: string }))
        case 'read_file':
          return wrap(await handleReadFile(ctx, args as { projectId: string; path: string }))
        case 'compile':
          return wrap(
            await handleCompile(
              ctx,
              args as { projectId: string; draft?: boolean; stopOnFirstError?: boolean },
            ),
          )
        case 'read_compile_log':
          return wrap(await handleReadCompileLog(ctx, args as { projectId: string }))
        case 'download_pdf':
          return wrap(await handleDownloadPdf(ctx, args as { projectId: string }))
        default:
          throw new OverleafError('NOT_FOUND', `Unknown tool: ${name}`)
      }
    } catch (err) {
      if (err instanceof OverleafError) {
        return {
          content: [{ type: 'text', text: `${err.code}: ${err.message}` }],
          isError: true,
        }
      }
      throw err
    }
  })
}

function wrap(payload: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  }
}
```

- [ ] **Step 8: Run the tests, verify they pass**

Run: `pnpm test test/unit/mcp-tools.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 9: Run full unit suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: All tests PASS, no TypeScript errors.

- [ ] **Step 10: Commit**

```bash
git add overleaf-mcp/src/mcp/ overleaf-mcp/test/unit/mcp-tools.test.ts
git commit -m "feat(overleaf-mcp): add MCP server bootstrap and v0.1 tools"
```

---

## Task 11: CLI Entry

`overleaf-mcp` (no args) → run as MCP stdio server. `overleaf-mcp login` → interactive credential setup. `overleaf-mcp ls` → smoke test. `overleaf-mcp diagnose` → connectivity check.

**Files:**
- Create: `overleaf-mcp/src/cli.ts`

- [ ] **Step 1: Write the CLI**

Path: `overleaf-mcp/src/cli.ts`

```typescript
#!/usr/bin/env node
import { writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output, stderr } from 'node:process'
import { loadConfig } from './config.js'
import { validateCookie, passportLogin } from './overleaf/auth.js'
import { buildContext, runMcpServer } from './mcp/server.js'
import { OverleafError } from './errors.js'

const HELP = `
overleaf-mcp — MCP server for Overleaf Community Edition (v0.1)

Usage:
  overleaf-mcp                Run as MCP stdio server (default).
  overleaf-mcp login          Interactive: paste a cookie or log in with email + password.
  overleaf-mcp ls             List accessible projects (smoke test).
  overleaf-mcp diagnose       Verify connectivity, auth, and (eventually) OT handshake.
  overleaf-mcp --help         Show this help.

Environment variables:
  OVERLEAF_URL                Required. e.g. https://overleaf.example.com
  OVERLEAF_SESSION_COOKIE     Required (or run \`overleaf-mcp login\`).
  OVERLEAF_EXTRA_HEADERS      JSON object of extra headers (e.g. CF Access service token).
  OVERLEAF_DEBUG              "1" for verbose stderr logging.
`

async function main() {
  const [, , cmd, ...rest] = process.argv

  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    output.write(HELP)
    return
  }

  if (cmd === 'login') {
    await runLogin(rest)
    return
  }

  if (cmd === 'ls' || cmd === 'diagnose') {
    const cfg = loadConfig()
    const csrfToken = await validateCookie({
      url: cfg.url,
      sessionCookie: cfg.sessionCookie,
      extraHeaders: cfg.extraHeaders,
    })
    const ctx = buildContext({ ...cfg, csrfToken })
    if (cmd === 'ls') {
      const projects = await ctx.rest.listProjects()
      for (const p of projects) {
        output.write(`${p.id}\t${p.name}\t${p.lastUpdated}\n`)
      }
    } else {
      stderr.write(`✓ Connected to ${cfg.url}\n`)
      stderr.write(`✓ Auth (cookie + CSRF) valid\n`)
      const projects = await ctx.rest.listProjects()
      stderr.write(`✓ ${projects.length} project(s) accessible\n`)
    }
    return
  }

  // Default: MCP stdio server
  const cfg = loadConfig()
  const csrfToken = await validateCookie({
    url: cfg.url,
    sessionCookie: cfg.sessionCookie,
    extraHeaders: cfg.extraHeaders,
  })
  const ctx = buildContext({ ...cfg, csrfToken })
  await runMcpServer(ctx)
}

interface LoginArgs {
  url?: string
  email?: string
  cookie?: string
  headers: string[]
}

function parseLoginArgs(argv: string[]): LoginArgs {
  const args: LoginArgs = { headers: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--url') args.url = argv[++i]
    else if (a === '--email') args.email = argv[++i]
    else if (a === '--cookie') args.cookie = argv[++i]
    else if (a === '--header') args.headers.push(argv[++i]!)
  }
  return args
}

async function runLogin(argv: string[]) {
  const args = parseLoginArgs(argv)
  const rl = createInterface({ input, output })

  const url = args.url ?? (await rl.question('Overleaf URL: ')).trim()
  const extraHeaders: Record<string, string> = {}
  for (const h of args.headers) {
    const eq = h.indexOf('=')
    if (eq < 0) throw new Error(`--header must be KEY=VALUE, got: ${h}`)
    extraHeaders[h.slice(0, eq)] = h.slice(eq + 1)
  }

  let sessionCookie: string
  if (args.cookie) {
    sessionCookie = args.cookie
  } else {
    const useCookie = (
      await rl.question('Auth method? [c]ookie paste / [p]assword login: ')
    )
      .trim()
      .toLowerCase()
    if (useCookie.startsWith('c')) {
      sessionCookie = (await rl.question('Paste overleaf_session2 cookie: ')).trim()
    } else {
      const email = args.email ?? (await rl.question('Email: ')).trim()
      const password = await rl.question('Password: ')
      const id = await passportLogin({ url, email, password, extraHeaders })
      sessionCookie = id.sessionCookie
      stderr.write('✓ Login successful\n')
    }
  }

  // Verify and persist
  await validateCookie({ url, sessionCookie, extraHeaders })
  stderr.write(`✓ Cookie valid; CSRF token scraped\n`)

  const target = join(homedir(), '.config', 'overleaf-mcp', 'credentials.json')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(
    target,
    JSON.stringify({ url, session_cookie: sessionCookie, extra_headers: extraHeaders }, null, 2),
  )
  chmodSync(target, 0o600)
  stderr.write(`✓ Credentials saved to ${target}\n`)
  rl.close()
}

main().catch((err: unknown) => {
  if (err instanceof OverleafError) {
    stderr.write(`error: ${err.code}: ${err.message}\n`)
    process.exit(2)
  }
  stderr.write(`error: ${String((err as Error).message ?? err)}\n`)
  process.exit(1)
})
```

- [ ] **Step 2: Build and verify there are no type errors**

Run: `pnpm typecheck && pnpm build`
Expected: PASS — no errors. `dist/cli.js` and other compiled files appear.

- [ ] **Step 3: Smoke-test help output**

Run: `node dist/cli.js --help`
Expected: usage text printed.

- [ ] **Step 4: Commit**

```bash
git add overleaf-mcp/src/cli.ts
git commit -m "feat(overleaf-mcp): add CLI entrypoint with login/ls/diagnose"
```

---

## Task 12: Integration Test Against a Live CE Container

A single end-to-end test that boots `sharelatex/sharelatex` via docker-compose, registers a regular user, and verifies that `listProjects`, `downloadProjectZip`, and `compile` work end-to-end.

This task is **optional for v0.1 ship** but strongly recommended. Tag the test as integration so unit CI doesn't pull docker.

**Files:**
- Create: `overleaf-mcp/test/integration/docker-compose.yml`
- Create: `overleaf-mcp/test/integration/setup.sh`
- Create: `overleaf-mcp/test/integration/ce-fixture.test.ts`
- Modify: `overleaf-mcp/vitest.config.ts` (already restricted to `test/unit/**` in Task 1; no change needed)
- Create: `overleaf-mcp/vitest.integration.config.ts`
- Modify: `overleaf-mcp/package.json` (add `test:integration` script)

- [ ] **Step 1: Write a minimal docker-compose**

Path: `overleaf-mcp/test/integration/docker-compose.yml`

```yaml
services:
  sharelatex:
    image: sharelatex/sharelatex:5.5.4
    ports:
      - "8080:80"
    environment:
      OVERLEAF_LISTEN_IP: 0.0.0.0
      OVERLEAF_APP_NAME: "Overleaf Test"
      OVERLEAF_MONGO_URL: "mongodb://mongo/sharelatex?directConnection=true"
      OVERLEAF_REDIS_HOST: redis
      REDIS_HOST: redis
      OVERLEAF_SESSION_SECRET: testsecret
      OVERLEAF_BEHIND_PROXY: "true"
    depends_on:
      - mongo
      - redis
  mongo:
    image: mongo:6
    command: --replSet overleaf
  redis:
    image: redis:6
```

- [ ] **Step 2: Write the setup script**

Path: `overleaf-mcp/test/integration/setup.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
docker compose up -d

echo "Waiting for sharelatex to come up..."
for i in $(seq 1 60); do
  if curl -fsS http://localhost:8080/login >/dev/null 2>&1; then
    echo "  ready after ${i} attempts"
    break
  fi
  sleep 2
done

# Initialize MongoDB replica set (CE 5.x requires this)
docker compose exec -T mongo mongosh --quiet --eval 'try { rs.initiate({_id: "overleaf", members: [{_id: 0, host: "mongo:27017"}]}) } catch(e) { print(e) }' || true
sleep 5

# Create a regular user. The activation URL will be printed to stdout; capture it.
docker compose exec -T sharelatex /sbin/setuser sharelatex /bin/bash -c \
  'cd /overleaf/services/web && node modules/server-ce-scripts/scripts/create-user --email=user@test.local --admin=false' \
  || true

echo "If the script above printed an activation URL, follow it once in a browser to set the password."
echo "Then run:"
echo "  TEST_OVERLEAF_PASSWORD=<your-password> pnpm test:integration"
```

> Note: CE 5.x bootstrap is fiddly. Treat this script as a scaffold. If activation flow proves too painful, switch to driving setup through the public REST endpoints (POST /register / POST /login) once an admin exists.

Make it executable: `chmod +x overleaf-mcp/test/integration/setup.sh`

- [ ] **Step 3: Write the integration test**

Path: `overleaf-mcp/test/integration/ce-fixture.test.ts`

```typescript
import { describe, it, expect } from 'vitest'
import { OverleafHttp } from '../../src/overleaf/http.js'
import { OverleafRest } from '../../src/overleaf/rest.js'
import { passportLogin } from '../../src/overleaf/auth.js'

const URL = process.env.TEST_OVERLEAF_URL ?? 'http://localhost:8080'
const EMAIL = process.env.TEST_OVERLEAF_EMAIL ?? 'user@test.local'
const PASSWORD = process.env.TEST_OVERLEAF_PASSWORD ?? 'password'

const skip = process.env.RUN_INTEGRATION !== '1'

describe.skipIf(skip)('overleaf-mcp against live CE', () => {
  it('lists projects, reads main.tex, and compiles', async () => {
    const id = await passportLogin({ url: URL, email: EMAIL, password: PASSWORD, extraHeaders: {} })
    const http = new OverleafHttp({
      url: URL,
      sessionCookie: id.sessionCookie,
      csrfToken: id.csrfToken,
      extraHeaders: {},
    })
    const rest = new OverleafRest(http)

    const projects = await rest.listProjects()
    expect(projects.length).toBeGreaterThan(0)

    const projectId = projects[0]!.id
    const zip = await rest.downloadProjectZip(projectId)
    expect(zip.length).toBeGreaterThan(50)

    const compileRes = await rest.compile(projectId)
    expect(['success', 'failure']).toContain(compileRes.status)
  }, 60_000)
})
```

- [ ] **Step 4: Add the vitest integration config**

Create: `overleaf-mcp/vitest.integration.config.ts`

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
})
```

Modify `overleaf-mcp/package.json` `scripts` (add this entry):

```json
"test:integration": "RUN_INTEGRATION=1 vitest run --config vitest.integration.config.ts"
```

- [ ] **Step 5: Manually verify the integration test (one-time)**

```bash
cd overleaf-mcp/test/integration
bash setup.sh
# Follow the activation URL printed above; set a password.
cd ../..
TEST_OVERLEAF_PASSWORD='<the password you set>' pnpm test:integration
```

Expected: PASS. The user must have at least one project (create one in the UI before running).

- [ ] **Step 6: Commit**

```bash
git add overleaf-mcp/test/integration/ overleaf-mcp/vitest.integration.config.ts overleaf-mcp/package.json
git commit -m "test(overleaf-mcp): add docker-compose CE integration test"
```

---

## Task 13: README

User-facing docs covering install, config, and reverse-proxy auth examples. AGPL attribution to Overleaf-Workshop.

**Files:**
- Create: `overleaf-mcp/README.md`

- [ ] **Step 1: Write README.md**

Path: `overleaf-mcp/README.md`

````markdown
# overleaf-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) server for **Overleaf Community Edition** that lets AI coding agents (Claude Code, Claude Desktop, Codex via MCP, Cursor, …) read, navigate, and compile LaTeX projects in your self-hosted Overleaf instance — **without** git-bridge or Server Pro.

This is **v0.1: read-only**. Future versions will add writes via Overleaf's native realtime OT pipeline (no "file changed externally" toast).

## Install

```bash
npx overleaf-mcp@latest --help
```

## Quick start

```bash
# 1. Get a session cookie (paste from devtools or use --email/--password)
npx overleaf-mcp login --url https://overleaf.example.com

# 2. Smoke test
npx overleaf-mcp ls
```

## MCP client config

```jsonc
{
  "mcpServers": {
    "overleaf": {
      "command": "npx",
      "args": ["-y", "overleaf-mcp@latest"],
      "env": {
        "OVERLEAF_URL": "https://overleaf.example.com",
        "OVERLEAF_SESSION_COOKIE": "overleaf_session2=s%3A..."
      }
    }
  }
}
```

## Reverse-proxy auth (Cloudflare Access, basic auth, …)

```jsonc
"env": {
  "OVERLEAF_URL": "https://overleaf.example.com",
  "OVERLEAF_SESSION_COOKIE": "overleaf_session2=s%3A...",
  "OVERLEAF_EXTRA_HEADERS": "{\"CF-Access-Client-Id\":\"abc.access\",\"CF-Access-Client-Secret\":\"...\"}"
}
```

The headers in `OVERLEAF_EXTRA_HEADERS` are merged into both REST requests **and** the WebSocket handshake (when OT mode lands in v0.2).

## Tools (v0.1)

| Tool | Purpose |
|---|---|
| `list_projects` | List accessible projects |
| `get_project_tree(projectId)` | Folder + file tree |
| `read_doc(projectId, path)` | Text doc content |
| `read_file(projectId, path)` | Binary file (base64) |
| `compile(projectId, draft?, stopOnFirstError?)` | Trigger compile, return URLs |
| `read_compile_log(projectId)` | Compile and return log text |
| `download_pdf(projectId)` | Compile and return PDF bytes (base64) |

## License

AGPL-3.0-or-later.

## Acknowledgements

This project ports significant portions of the auth and (in v0.2) OT code from
[**Overleaf-Workshop**](https://github.com/iamhyc/Overleaf-Workshop) by iamhyc and contributors. Used under AGPL-3.0.
````

- [ ] **Step 2: Commit**

```bash
git add overleaf-mcp/README.md
git commit -m "docs(overleaf-mcp): add README"
```

---

## Final smoke pass

- [ ] **Step 1: Run full unit suite + typecheck**

```bash
cd overleaf-mcp
pnpm test && pnpm typecheck
```

Expected: all green.

- [ ] **Step 2: Build**

```bash
pnpm build
```

Expected: `dist/` populated.

- [ ] **Step 3: Verify CLI works against your real CE instance**

```bash
node dist/cli.js login --url https://overleaf.example.com
node dist/cli.js ls
```

Expected: project list prints.

- [ ] **Step 4: Verify MCP tool calls from Claude Code**

Configure Claude Code with the MCP config block from the README. Ask Claude to "list my Overleaf projects" and "compile project X." Confirm both work.

- [ ] **Step 5: Tag v0.1.0**

```bash
cd /home/houhd/code/overleaf_cc
git tag overleaf-mcp-v0.1.0
```

---

## Spec coverage check

Each spec requirement maps to a task:

- Auth (cookie paste + passport login + extra headers): **Tasks 4, 5, 11**
- HTTP client: **Task 4**
- REST endpoints (list_projects, download_zip, compile, output, file): **Tasks 6, 7, 8**
- Zip parsing + tree: **Task 7**
- TTL cache: **Task 9**
- MCP server bootstrap + tools: **Task 10**
- CLI subcommands (default, login, ls, diagnose): **Task 11**
- Integration test against CE: **Task 12**
- README + AGPL attribution: **Task 13** (+ Task 1 LICENSE)

Out of scope for v0.1 — written tools (`write_doc`, `apply_patch`, tree mutations) are deferred to v0.2 along with the OT engine port. `subscribe_changes` is deferred indefinitely.
