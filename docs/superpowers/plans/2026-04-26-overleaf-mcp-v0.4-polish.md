# overleaf-mcp v0.4 Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `overleaf-mcp` v0.4 — a polish/hardening release. No new MCP tools; instead, fix the latent bugs we've documented through v0.1–v0.3, improve error mapping per the spec's error taxonomy, harden reconnect with jitter + give-up signaling, sharpen the `diagnose` subcommand into a real connectivity report, support `pdfDownloadDomain` for `overleaf.com`-style deployments, and fill out the README with worked auth-pass-through examples.

**Architecture:** Targeted edits across the existing layers — no new modules. Highest-leverage fixes:
1. **Per-doc write serialization** in `OtEngine.applyOps` — concurrent writes to the same doc currently race the baseline mutation. A per-docId promise queue eliminates the race without changing the public surface.
2. **Error taxonomy completeness** — REST 401 currently surfaces as `OVERLEAF_GENERIC: ...401` because per-endpoint `!res.ok` paths bypass the auth check. Centralize the auth-error mapping in `OverleafHttp.checkAuthErrors` and wire `ProjectAccessDeniedError` (defined since v0.1, never thrown) for project-scoped 403s.
3. **`diagnose` subcommand** — currently equivalent to `ls`. Replace with a stepped report: REST auth → CF/proxy detection → REST listProjects → OT handshake → cleanup, with ✓/✗ per step.
4. **`upload_file` MIME inference** — `mimeType` becomes optional, with the same `EXT_TO_MIME` table `read_file` uses.
5. **Reconnect jitter** — multiply delay by `0.5 + Math.random()` so concurrent clients don't thundering-herd a recovering CE. When max attempts exhausted, surface a `reconnectFailed` callback instead of silently leaving the engine wedged.
6. **`pdfDownloadDomain`** — `compile()` already captures it; `downloadOutputFile` now joins it onto relative output URLs when present.
7. **Trailing-slash + URL normalization in `config.ts`** — `url.replace(/\/$/, '')` corrupts `https://` (yields `https:/`); replace with WHATWG-URL-based normalization.

**Tech Stack:** Carry-over from v0.3. No new runtime deps.

**Spec reference:** `docs/superpowers/specs/2026-04-25-overleaf-mcp-design.md` § "v0.4 — Polish (~3 days)" lines 278–283 (`diagnose`, error mapping, reconnect/backoff hardening, README examples) plus the punch list accumulated through prior reviews.

---

## File Structure

```
src/
├── config.ts                       (Task 1: WHATWG-URL normalization)
├── overleaf/
│   ├── http.ts                     (Task 2: error mapping completeness)
│   ├── ot.ts                       (Tasks 3, 4: write serialization, reconnect jitter)
│   └── rest.ts                     (Task 5: pdfDownloadDomain wiring)
├── mcp/
│   └── tools/
│       └── tree.ts                 (Task 6: upload_file MIME sniff fallback)
├── cli.ts                          (Task 7: diagnose stepped report)
└── …                               (everything else unchanged)

test/unit/
├── config.test.ts                  (Task 1)
├── http.test.ts                    (Task 2)
├── ot.write-serialization.test.ts  (Task 3 — NEW)
├── ot.reconnect-jitter.test.ts     (Task 4 — NEW; merge w/ existing reconnect tests if cleaner)
├── rest.compile.test.ts            (Task 5: pdfDownloadDomain assertions)
├── mcp-tree.test.ts                (Task 6: optional mimeType + sniff)
└── cli.diagnose.test.ts            (Task 7 — NEW)

docs/
└── superpowers/
    ├── plans/2026-04-26-overleaf-mcp-v0.4-polish.md  (this file)
    └── specs/…                      (Task 9: status update only)

README.md                            (Task 8: Cloudflare Access / basic-auth / Tailscale-or-Authelia examples)
package.json                         (Task 9: 0.3.0 → 0.4.0)
src/cli.ts                           (Task 9: HELP "v0.3" → "v0.4")
src/mcp/server.ts                    (Task 9: server version literal)
CLAUDE.md                            (Task 9: status section)
```

---

## Task 1: URL normalization + scheme + host validation in `loadConfig`

The current trailing-slash strip is a regex (`url.replace(/\/$/, '')`) that corrupts `https://` to `https:/`. Replace with WHATWG-URL parsing so we get host validation + cleaner trailing-slash handling for free.

**Files:**
- Modify: `src/config.ts`
- Modify: `test/unit/config.test.ts`

- [ ] **Step 1: Append the failing tests** to `test/unit/config.test.ts`:

```typescript
  it('strips trailing slashes via URL parsing (no corruption of bare https://)', () => {
    const cfg = loadConfig({
      env: { OVERLEAF_URL: 'https://o.example.com/', OVERLEAF_SESSION_COOKIE: 'c' },
      credentialsPath: join(tmp, 'noexist.json'),
    })
    expect(cfg.url).toBe('https://o.example.com')
  })

  it('preserves a configured subpath (no trailing slash)', () => {
    const cfg = loadConfig({
      env: { OVERLEAF_URL: 'https://corp.example.com/overleaf/', OVERLEAF_SESSION_COOKIE: 'c' },
      credentialsPath: join(tmp, 'noexist.json'),
    })
    expect(cfg.url).toBe('https://corp.example.com/overleaf')
  })

  it('throws InvalidConfigError when URL has no host (e.g. bare https://)', () => {
    expect(() =>
      loadConfig({
        env: { OVERLEAF_URL: 'https://', OVERLEAF_SESSION_COOKIE: 'c' },
        credentialsPath: join(tmp, 'nope.json'),
      }),
    ).toThrow(/host/i)
  })

  it('throws InvalidConfigError when URL is malformed', () => {
    expect(() =>
      loadConfig({
        env: { OVERLEAF_URL: 'http:/missing-slashes', OVERLEAF_SESSION_COOKIE: 'c' },
        credentialsPath: join(tmp, 'nope.json'),
      }),
    ).toThrow(/InvalidConfigError|invalid url/i)
  })
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- test/unit/config.test.ts
```

Expected: FAIL — `https://` returns `https:/` (corrupted) and other assertions fail.

- [ ] **Step 3: Replace the URL normalization in `src/config.ts`**

Find this block in `loadConfig`:

```typescript
  if (!/^https?:\/\//i.test(url)) {
    throw new InvalidConfigError(
      `OVERLEAF_URL must start with http:// or https:// (got: ${url})`,
    )
  }
```

Replace with:

```typescript
  if (!/^https?:\/\//i.test(url)) {
    throw new InvalidConfigError(
      `OVERLEAF_URL must start with http:// or https:// (got: ${url})`,
    )
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new InvalidConfigError(`OVERLEAF_URL is not a valid URL: ${url}`)
  }
  if (!parsed.host) {
    throw new InvalidConfigError(`OVERLEAF_URL must have a host (got: ${url})`)
  }
  const normalizedUrl = parsed.origin + parsed.pathname.replace(/\/+$/, '')
```

Then change the return value's `url` field from the old `url.replace(/\/$/, '')` to `normalizedUrl`:

```typescript
  return {
    url: normalizedUrl,
    sessionCookie,
    extraHeaders,
    debug: env.OVERLEAF_DEBUG === '1' || env.OVERLEAF_DEBUG === 'true',
  }
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/config.test.ts
```

Expected: PASS — 4 new tests + the existing 7 (`url.replace(/\/$/, '')` was tested loosely; verify the existing tests still pass with the new normalization).

- [ ] **Step 5: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; full suite at 144 (was 140, +4 new).

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/unit/config.test.ts
git commit -m "fix(config): WHATWG-URL normalization (preserve subpath, reject hostless URLs)"
```

---

## Task 2: Error-mapping completeness in `OverleafHttp`

Three real bugs accumulated through v0.1–v0.3:

1. REST 401 from a project endpoint surfaces as `OVERLEAF_GENERIC: ... 401` instead of `OVERLEAF_AUTH_FAILED`. The 401 branch in `checkAuthErrors` already throws `AuthFailedError`, but only for non-2xx-non-302 responses on the GET path; per-endpoint methods (`compile`, `downloadFile`, etc.) construct their own `OverleafError('OVERLEAF_GENERIC', ...)` for `!res.ok`.
2. `ProjectAccessDeniedError` is defined in `errors.ts` but never thrown anywhere.
3. CF-Access detection is a 403 + `cf-ray`/`cf-mitigated` heuristic, but Overleaf can also return 403 directly when the agent isn't a collaborator on the requested project — and we currently misattribute that to the proxy.

The fix: extend `checkAuthErrors` so all auth-shaped statuses map to typed errors before `!res.ok` is checked by callers, and have callers re-raise the typed errors instead of swallowing them.

**Files:**
- Modify: `src/overleaf/http.ts`
- Modify: `test/unit/http.test.ts`

- [ ] **Step 1: Append the failing tests** to `test/unit/http.test.ts`:

```typescript
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
```

(`ProjectAccessDeniedError` needs an import alongside the existing imports at the top of the test:)

```typescript
import { AuthFailedError, ProxyAuthFailedError, NetworkError, ProjectAccessDeniedError } from '../../src/errors.js'
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- test/unit/http.test.ts
```

Expected: FAIL — `ProjectAccessDeniedError` never thrown.

- [ ] **Step 3: Extend `OverleafHttp.checkAuthErrors`**

In `src/overleaf/http.ts`, update the imports:

```typescript
import { AuthFailedError, NetworkError, ProjectAccessDeniedError, ProxyAuthFailedError } from '../errors.js'
```

Replace the `checkAuthErrors` method with:

```typescript
  private checkAuthErrors(res: Response, requestPath: string) {
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
    if (res.status === 403) {
      // Project-scoped 403 (no CF headers) means the configured account is
      // not a collaborator on the project. Pull the projectId out of the
      // path if possible for the error context.
      const match = requestPath.match(/\/project\/([^/?#]+)/)
      if (match) {
        throw new ProjectAccessDeniedError(decodeURIComponent(match[1]!))
      }
    }
  }
```

The `request` method currently calls `this.checkAuthErrors(res)`. Update that call site to pass the request path:

```typescript
    this.checkAuthErrors(res, path)
    return res
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/http.test.ts
```

Expected: PASS — 7 prior + 3 new = 10.

- [ ] **Step 5: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; full suite at 147.

- [ ] **Step 6: Commit**

```bash
git add src/overleaf/http.ts test/unit/http.test.ts
git commit -m "fix(http): wire ProjectAccessDeniedError + clarify 401/403 branching"
```

---

## Task 3: Per-doc write serialization in `OtEngine`

Concurrent `writeDoc(docId, ...)` for the SAME doc currently race because `applyOps` reads the baseline, computes ops, and emits — all without locking. A second concurrent caller sees the same baseline, computes against it, and the server's `applyOtUpdate` ack for the second emit may arrive before the first's, ordering the baseline mutation incorrectly.

Fix: chain calls per docId via a Map<docId, Promise<void>>. Each new `applyOps` awaits the previous one for that doc before starting its own emit-and-mutate sequence.

**Files:**
- Modify: `src/overleaf/ot.ts`
- Create: `test/unit/ot.write-serialization.test.ts`

- [ ] **Step 1: Write the failing test** at `test/unit/ot.write-serialization.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { OtEngine } from '../../src/overleaf/ot.js'
import { FakeSocket } from './fake-socket.js'
import type { JoinProjectResponse, UpdateSchema } from '../../src/overleaf/ot.types.js'

const join = (): JoinProjectResponse => ({
  project: {
    _id: 'p1', name: 'Test', rootDoc_id: 'd1',
    rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [{ _id: 'd1', name: 'main.tex' }], fileRefs: [], folders: [] }],
  },
  permissionsLevel: 'owner', protocolVersion: 2, publicId: 'pub-AGENT',
})

describe('OtEngine concurrent writes are serialized per docId', () => {
  it('two concurrent writeDoc calls produce sequential applyOtUpdate emits with correct version chain', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const cp = engine.connect()
    sock.simulate('connectionAccepted', null, 'pub-AGENT')
    sock.simulate('joinProjectResponse', join())
    await cp

    sock.respondToEmit('joinDoc', () => [null, ['hello'], 0, []])
    await engine.joinDoc('d1')

    // Capture the order of applyOtUpdate emits and their version numbers.
    const seenVersions: number[] = []
    sock.respondToEmit('applyOtUpdate', (_docId, update) => {
      const u = update as UpdateSchema
      seenVersions.push(u.v)
      return [null]
    })

    // Fire two concurrent writes against the same doc.
    const p1 = engine.writeDoc('d1', 'hello a')
    const p2 = engine.writeDoc('d1', 'hello a b')
    await Promise.all([p1, p2])

    // Both writes must have completed (no hang). The second saw the
    // baseline produced by the first, so the version emitted for the
    // second update must be exactly one greater than the first.
    expect(seenVersions.length).toBe(2)
    expect(seenVersions[1]).toBe(seenVersions[0]! + 1)
  })

  it('concurrent writes against different docIds are NOT serialized against each other', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const cp = engine.connect()
    sock.simulate('connectionAccepted', null, 'pub-AGENT')
    sock.simulate('joinProjectResponse', { ...join(), project: { ...join().project,
      rootFolder: [{ _id: 'root', name: 'rootFolder',
        docs: [{ _id: 'd1', name: 'main.tex' }, { _id: 'd2', name: 'b.tex' }],
        fileRefs: [], folders: [] }] } })
    await cp

    sock.respondToEmit('joinDoc', (docId) => [null, [docId === 'd1' ? 'a' : 'b'], 0, []])

    let inflight = 0
    let maxInflight = 0
    sock.respondToEmit('applyOtUpdate', () => {
      inflight += 1
      maxInflight = Math.max(maxInflight, inflight)
      // Defer ack to the next microtask so a SECOND emit can land before the first acks.
      queueMicrotask(() => { inflight -= 1 })
      return [null]
    })

    const p1 = engine.writeDoc('d1', 'aX')
    const p2 = engine.writeDoc('d2', 'bY')
    await Promise.all([p1, p2])

    // Per-doc serialization must NOT block cross-doc concurrency.
    expect(maxInflight).toBeGreaterThanOrEqual(2)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- test/unit/ot.write-serialization.test.ts
```

Expected: FAIL on the first test (versions not sequential because both writes saw baseline.version=0).

- [ ] **Step 3: Add the per-doc queue to `OtEngine`**

In `src/overleaf/ot.ts`, add a private field alongside `inflightJoinDoc` and `baselines`:

```typescript
  /** Per-docId promise chain for write serialization. */
  private writeQueues = new Map<string, Promise<void>>()
```

Replace the `applyOps` method:

```typescript
  async applyOps(docId: string, ops: OtOp[]): Promise<void> {
    // Chain onto any in-flight write for the same docId so concurrent
    // callers can't both read the same baseline. Across different docIds,
    // calls run in parallel.
    const previous = this.writeQueues.get(docId) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined) // a prior failure must not block the next caller
      .then(() => this.applyOpsWithResync(docId, ops, /* attemptsLeft */ 1))
    this.writeQueues.set(docId, next)
    try {
      await next
    } finally {
      // If we're the tail of the queue, clear the entry so the map doesn't grow.
      if (this.writeQueues.get(docId) === next) {
        this.writeQueues.delete(docId)
      }
    }
  }
```

(`applyOpsWithResync` is unchanged.)

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/ot.write-serialization.test.ts
```

Expected: PASS — 2 tests.

- [ ] **Step 5: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; full suite at 149 (was 147, +2 new).

- [ ] **Step 6: Commit**

```bash
git add src/overleaf/ot.ts test/unit/ot.write-serialization.test.ts
git commit -m "fix(ot): serialize concurrent applyOps per-doc to prevent baseline race"
```

---

## Task 4: Reconnect jitter + give-up signaling

Two improvements to `scheduleReconnect`:

1. **Jitter.** When a CE restarts and many clients reconnect, all of them ramp through `500ms × 2^n` in lockstep. Multiply each delay by a random factor in `[0.5, 1.5)` so they spread.
2. **Give-up signal.** When `reconnectMaxAttempts` is exhausted, the engine currently flips `_isConnected = false` and stops — silent. Surface a `reconnectFailed` callback option so consumers (the registry) know the engine is dead.

**Files:**
- Modify: `src/overleaf/ot.ts`
- Modify: `test/unit/ot.reconnect.test.ts`

- [ ] **Step 1: Append the failing tests** to `test/unit/ot.reconnect.test.ts`:

```typescript
  it('applies jitter ∈ [0.5, 1.5) × base delay across attempts', async () => {
    const observed: number[] = []
    const sockets: FakeSocket[] = []
    const factory = vi.fn(() => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    })
    const engine = new OtEngine({
      socket: factory(),
      projectId: 'p1',
      socketFactory: factory,
      reconnectInitialDelayMs: 100,
      reconnectMaxAttempts: 5,
      now: () => Date.now(),
      schedule: (cb: () => void, ms: number) => {
        observed.push(ms)
        // Fire immediately so the test runs synchronously.
        return setTimeout(cb, 0)
      },
    } as any)
    const cp = engine.connect()
    sockets[0]!.simulate('connectionAccepted', null, 'pub')
    sockets[0]!.simulate('joinProjectResponse', join())
    await cp

    // Force three failed attempts: each fresh socket immediately rejects.
    for (let i = 1; i <= 3; i++) {
      sockets[i - 1]!.simulate('forceDisconnect', 'kick')
      // Wait for the next factory() call.
      await new Promise((r) => setTimeout(r, 5))
      // The new socket rejects — back to scheduling another attempt.
      sockets[i]?.simulate('connectionRejected', { message: 'still down' })
      await new Promise((r) => setTimeout(r, 5))
    }

    // We should have observed 3 scheduled delays. Each must be in
    // [0.5*base, 1.5*base) where base = 100 * 2^attemptIndex.
    expect(observed.length).toBeGreaterThanOrEqual(3)
    for (let i = 0; i < Math.min(observed.length, 3); i++) {
      const base = 100 * 2 ** i
      expect(observed[i]).toBeGreaterThanOrEqual(Math.floor(base * 0.5))
      expect(observed[i]).toBeLessThan(Math.ceil(base * 1.5))
    }
  })

  it('calls reconnectFailed callback when max attempts exhausted', async () => {
    const sockets: FakeSocket[] = []
    const factory = vi.fn(() => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    })
    const failed = vi.fn()
    const engine = new OtEngine({
      socket: factory(),
      projectId: 'p1',
      socketFactory: factory,
      reconnectInitialDelayMs: 1,
      reconnectMaxAttempts: 2,
      onReconnectFailed: failed,
    } as any)
    const cp = engine.connect()
    sockets[0]!.simulate('connectionAccepted', null, 'pub')
    sockets[0]!.simulate('joinProjectResponse', join())
    await cp

    // First disconnect → first reconnect attempt → it rejects → second attempt → also rejects → give up.
    sockets[0]!.simulate('forceDisconnect', 'flap')
    await new Promise((r) => setTimeout(r, 30))
    sockets[1]?.simulate('connectionRejected', { message: 'down' })
    await new Promise((r) => setTimeout(r, 30))
    sockets[2]?.simulate('connectionRejected', { message: 'still down' })
    await new Promise((r) => setTimeout(r, 30))

    expect(failed).toHaveBeenCalledTimes(1)
    expect(engine.isConnected).toBe(false)
  })
```

(The first test uses a dependency-injected `schedule` to capture delays without time-warping. We add support for that injection in step 3.)

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- test/unit/ot.reconnect.test.ts
```

Expected: FAIL — neither feature implemented.

- [ ] **Step 3: Extend `OtEngineOptions` and `scheduleReconnect`**

In `src/overleaf/ot.ts`, extend `OtEngineOptions`:

```typescript
export interface OtEngineOptions {
  socket: SocketLike
  projectId: string
  socketFactory?: () => SocketLike
  reconnectInitialDelayMs?: number
  reconnectMaxAttempts?: number
  /**
   * Called when the engine has exhausted reconnectMaxAttempts and given up.
   * The OtEngineRegistry uses this to evict the dead engine from its cache so
   * the next consumer gets a fresh one.
   */
  onReconnectFailed?: () => void
  /**
   * Test seam: override setTimeout for reconnect scheduling. Defaults to the
   * global setTimeout.
   */
  schedule?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
}
```

Add the corresponding fields and constructor wiring:

```typescript
  private readonly onReconnectFailed: (() => void) | null
  private readonly schedule: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
```

```typescript
    this.onReconnectFailed = opts.onReconnectFailed ?? null
    this.schedule = opts.schedule ?? setTimeout
```

Replace the `scheduleReconnect` method body (the part that computes the delay and schedules the timer). Find the existing block:

```typescript
    const delay = Math.min(
      this.reconnectInitialDelayMs * 2 ** this.reconnectAttempt,
      30_000,
    )
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      ...
    }, delay)
```

Replace with:

```typescript
    const baseDelay = Math.min(
      this.reconnectInitialDelayMs * 2 ** this.reconnectAttempt,
      30_000,
    )
    // Jitter ∈ [0.5, 1.5) × base. Spreads coordinated client herds.
    const delay = Math.round(baseDelay * (0.5 + Math.random()))
    this.reconnectAttempt += 1
    this.reconnectTimer = this.schedule(() => {
      this.reconnectTimer = null
      this.currentSocket = this.socketFactory!()
      void this.connect().then(
        () => { this.reconnectAttempt = 0 },
        () => this.scheduleReconnect(),
      )
    }, delay)
```

And update the give-up branch (early in `scheduleReconnect`):

```typescript
    if (this.reconnectAttempt >= this.reconnectMaxAttempts) {
      this._isConnected = false
      if (this.onReconnectFailed) this.onReconnectFailed()
      return
    }
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/ot.reconnect.test.ts
```

Expected: PASS — prior tests still green + 2 new.

- [ ] **Step 5: Wire `onReconnectFailed` through `OtEngineRegistry`**

Update `src/overleaf/ot.ts`'s `OtEngineRegistry.get`:

```typescript
    const promise = (async () => {
      const inputs = this.factory(projectId)
      const engine = new OtEngine({
        projectId,
        ...inputs,
        onReconnectFailed: () => {
          // Evict the dead engine so the next get() rebuilds it.
          this.engines.delete(projectId)
        },
      })
      try {
        await engine.connect()
        this.engines.set(projectId, engine)
        return engine
      } catch (err) {
        try { engine.disconnect() } catch { /* may already be torn down */ }
        throw err
      } finally {
        this.inflight.delete(projectId)
      }
    })()
```

(The merge of `...inputs` with `onReconnectFailed` is order-sensitive — `onReconnectFailed` must come AFTER the spread so a factory-supplied callback would NOT override the registry's eviction. If the factory wants to compose its own callback, it can.)

- [ ] **Step 6: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; full suite at 151 (was 149, +2 new).

- [ ] **Step 7: Commit**

```bash
git add src/overleaf/ot.ts test/unit/ot.reconnect.test.ts
git commit -m "fix(ot): reconnect jitter + onReconnectFailed signaling for engine eviction"
```

---

## Task 5: `pdfDownloadDomain` consumption in `OverleafRest.downloadOutputFile`

Overleaf's compile response can include a `pdfDownloadDomain` (e.g. `https://xhr-cdn.fly.dev`) — `output.pdf` and `output.log` URLs are then served from that domain rather than the main origin. Stock self-hosted CE leaves it empty; `overleaf.com` populates it. Currently we ignore it, so downloads against `overleaf.com` 404.

**Files:**
- Modify: `src/overleaf/rest.ts`
- Modify: `test/unit/rest.compile.test.ts`

- [ ] **Step 1: Append the failing test** to `test/unit/rest.compile.test.ts`:

```typescript
describe('OverleafRest.downloadOutputFile (with pdfDownloadDomain)', () => {
  it('joins a relative buildUrl onto pdfDownloadDomain when set', async () => {
    const rest = makeRest()
    server.use(
      http.post('https://o.example/project/p7/compile', () =>
        HttpResponse.json({
          status: 'success',
          pdfDownloadDomain: 'https://cdn.o.example',
          outputFiles: [
            { path: 'output.pdf', url: '/project/p7/build/b/output/output.pdf', type: 'pdf' },
          ],
        }),
      ),
      http.get('https://cdn.o.example/project/p7/build/b/output/output.pdf', () =>
        HttpResponse.arrayBuffer(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer, {
          headers: { 'Content-Type': 'application/pdf' },
        }),
      ),
    )
    const compileRes = await rest.compile('p7')
    expect(compileRes.pdfDownloadDomain).toBe('https://cdn.o.example')

    const url = compileRes.outputFiles.find((f) => f.path === 'output.pdf')!.url
    const { bytes, contentType } = await rest.downloadOutputFile(url, compileRes.pdfDownloadDomain)
    expect(bytes.toString('utf-8').startsWith('%PDF')).toBe(true)
    expect(contentType).toBe('application/pdf')
  })

  it('falls back to the main origin when pdfDownloadDomain is omitted', async () => {
    const rest = makeRest()
    server.use(
      http.get('https://o.example/project/p7/build/b/output/output.pdf', () =>
        HttpResponse.arrayBuffer(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer),
      ),
    )
    const { bytes } = await rest.downloadOutputFile('/project/p7/build/b/output/output.pdf')
    expect(bytes[0]).toBe(0x25)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- test/unit/rest.compile.test.ts
```

Expected: FAIL — `downloadOutputFile` only takes 1 argument; `pdfDownloadDomain` ignored.

- [ ] **Step 3: Update `downloadOutputFile`'s signature**

In `src/overleaf/rest.ts`, change `downloadOutputFile`:

```typescript
  async downloadOutputFile(
    buildUrl: string,
    pdfDownloadDomain?: string,
  ): Promise<DownloadedBytes> {
    const url = pdfDownloadDomain && buildUrl.startsWith('/')
      ? pdfDownloadDomain.replace(/\/+$/, '') + buildUrl
      : buildUrl
    const res = await this.http.get(url)
    if (!res.ok) {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        `output file ${url} returned ${res.status}`,
      )
    }
    const bytes = Buffer.from(await res.arrayBuffer())
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
    return { bytes, contentType }
  }
```

(`OverleafHttp.get(absUrl)` already handles absolute URLs because `new URL(path, base)` short-circuits when `path` is absolute — but verify by reading `src/overleaf/http.ts:request`. If it doesn't, we'd need a separate `getAbsolute(url)` method; the existing implementation does handle this correctly since v0.1.)

- [ ] **Step 4: Update `compile.ts`'s `compileAndCache` to pass through `pdfDownloadDomain`**

In `src/mcp/tools/compile.ts`, find the `handleDownloadPdf` and `handleReadCompileLog` handlers — they call `ctx.rest.downloadOutputFile(result.<...>Url)`. Update both to pass `result.pdfDownloadDomain`:

```typescript
  const { bytes, contentType } = await ctx.rest.downloadOutputFile(
    result.pdfUrl,
    result.pdfDownloadDomain,
  )
```

```typescript
  const buf = await ctx.rest.downloadOutputFile(result.logUrl, result.pdfDownloadDomain)
```

(Both pass the optional domain; if absent, `downloadOutputFile` no-ops and uses the main origin.)

`compileAndCache` already returns `pdfUrl` and `logUrl`. Add `pdfDownloadDomain` to its return type:

```typescript
interface CompileResult {
  status: string
  pdfUrl: string | null
  logUrl: string | null
  pdfDownloadDomain?: string
}
```

And in the function body:

```typescript
  return {
    status: res.status,
    pdfUrl: pdf?.url ?? null,
    logUrl: log?.url ?? null,
    pdfDownloadDomain: res.pdfDownloadDomain,
  }
```

- [ ] **Step 5: Run the test, verify it passes**

```bash
npm test -- test/unit/rest.compile.test.ts
```

Expected: PASS — prior tests + 2 new.

- [ ] **Step 6: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; full suite at 153.

- [ ] **Step 7: Commit**

```bash
git add src/overleaf/rest.ts src/mcp/tools/compile.ts test/unit/rest.compile.test.ts
git commit -m "fix(rest): consume pdfDownloadDomain for output downloads (overleaf.com support)"
```

---

## Task 6: `upload_file` MIME inference

Make `mimeType` optional. When omitted (or `application/octet-stream`), sniff the path extension using the same `EXT_TO_MIME` table `read_file`'s `formatBinaryFile` already uses.

**Files:**
- Modify: `src/mcp/tools/tree.ts`
- Modify: `src/mcp/tools/index.ts` (tool definition: drop required mimeType)
- Modify: `test/unit/mcp-tree.test.ts`
- Modify: `src/mcp/tools/index.ts` — export the existing `EXT_TO_MIME` and `effectiveMime` from `index.ts` so `tree.ts` can reuse them, OR factor them into a small helper module. Plan picks the helper-module path so neither file imports the other circularly.
- Create: `src/mcp/tools/mime.ts`
- Modify: `src/mcp/tools/index.ts` (re-import from the new helper)

- [ ] **Step 1: Move `EXT_TO_MIME` and `effectiveMime` into `src/mcp/tools/mime.ts`**

Path: `src/mcp/tools/mime.ts`

```typescript
/** Map common file extensions to MIME types. Used when the server's
 *  Content-Type is missing or generic (Overleaf's filestore returns no
 *  Content-Type and sets `x-content-type-options: nosniff`, so the path
 *  extension is the only signal we have). */
export const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  md: 'text/markdown',
  html: 'text/html',
}

/**
 * Return a refined MIME for a path: trust an explicit non-generic server
 * MIME if present; otherwise fall back to extension lookup; finally default
 * to application/octet-stream.
 */
export function effectiveMime(serverMime: string, path: string): string {
  if (serverMime && serverMime !== 'application/octet-stream') return serverMime
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  if (ext && EXT_TO_MIME[ext]) return EXT_TO_MIME[ext]
  return serverMime || 'application/octet-stream'
}
```

In `src/mcp/tools/index.ts`, replace the inline `EXT_TO_MIME` and `effectiveMime` with an import:

```typescript
import { effectiveMime } from './mime.js'
```

(Delete the inline `EXT_TO_MIME` constant and the inline `effectiveMime` function — `formatBinaryFile` already uses `effectiveMime`, so the call sites stay intact.)

- [ ] **Step 2: Append the failing test** to `test/unit/mcp-tree.test.ts`:

```typescript
describe('upload_file MIME sniff fallback', () => {
  it('infers image/png from .png when mimeType is omitted', async () => {
    const { ctx, sock } = buildTreeTestCtx()
    let receivedForm: FormData | null = null
    server.use(
      http.post('https://o.example/project/p1/upload', async ({ request }) => {
        receivedForm = await request.formData()
        setTimeout(() => sock.simulate('reciveNewFile', 'root', { _id: 'f-up', name: 'logo.png' }), 5)
        return HttpResponse.json({ success: true, entity_id: 'f-up', entity_type: 'file' })
      }),
    )
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
    const out = await handleUploadFile(ctx, {
      projectId: 'p1', parentPath: '', name: 'logo.png', contentBase64: png,
    })
    expect(out.kind).toBe('file')
    expect(receivedForm!.get('type')).toBe('image/png')
  })

  it('falls back to application/octet-stream for unknown extensions', async () => {
    const { ctx, sock } = buildTreeTestCtx()
    let receivedForm: FormData | null = null
    server.use(
      http.post('https://o.example/project/p1/upload', async ({ request }) => {
        receivedForm = await request.formData()
        setTimeout(() => sock.simulate('reciveNewFile', 'root', { _id: 'f-up', name: 'mystery.bin' }), 5)
        return HttpResponse.json({ success: true, entity_id: 'f-up', entity_type: 'file' })
      }),
    )
    await handleUploadFile(ctx, {
      projectId: 'p1', parentPath: '', name: 'mystery.bin',
      contentBase64: Buffer.from([0xab, 0xcd]).toString('base64'),
    })
    expect(receivedForm!.get('type')).toBe('application/octet-stream')
  })
})
```

- [ ] **Step 3: Run the test, verify it fails**

```bash
npm test -- test/unit/mcp-tree.test.ts
```

Expected: FAIL — `mimeType` is required.

- [ ] **Step 4: Make `mimeType` optional in `handleUploadFile`**

In `src/mcp/tools/tree.ts`, replace:

```typescript
export async function handleUploadFile(
  ctx: ServerContext,
  input: {
    projectId: string
    parentPath: string
    name: string
    contentBase64: string
    mimeType: string
  },
): Promise<MutationResult> {
```

with:

```typescript
import { effectiveMime } from './mime.js'

export async function handleUploadFile(
  ctx: ServerContext,
  input: {
    projectId: string
    parentPath: string
    name: string
    contentBase64: string
    mimeType?: string
  },
): Promise<MutationResult> {
  const parentFolderId = await resolveParentFolderId(ctx, input.projectId, input.parentPath)
  const bytes = new Uint8Array(Buffer.from(input.contentBase64, 'base64'))
  const mime = effectiveMime(input.mimeType ?? '', input.name)
  const { id, kind } = await ctx.rest.uploadFile(
    input.projectId,
    parentFolderId,
    input.name,
    bytes,
    mime,
  )
  const engine = await ctx.ot.get(input.projectId)
  const newPath = input.parentPath === '' ? input.name : `${input.parentPath}/${input.name}`
  await engine.waitForPath(newPath).catch(() => undefined)
  return { ok: true, id, kind }
}
```

- [ ] **Step 5: Update the tool definition in `src/mcp/tools/index.ts`**

Find the `upload_file` entry in `TOOL_DEFINITIONS` and:
- Drop `mimeType` from the `required` array.
- Update the description: `'Upload a binary file (base64) under parentPath. mimeType is optional — when omitted, inferred from the path extension (png/jpg/pdf/etc); fallback is application/octet-stream. Overleaf may auto-promote text MIME types to docs.'`

- [ ] **Step 6: Run the test, verify it passes**

```bash
npm test -- test/unit/mcp-tree.test.ts
```

Expected: PASS — prior 14 + 2 new.

- [ ] **Step 7: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; full suite at 155.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/tools/tree.ts src/mcp/tools/index.ts src/mcp/tools/mime.ts test/unit/mcp-tree.test.ts
git commit -m "feat(mcp): upload_file mimeType is now optional (path-extension sniff)"
```

---

## Task 7: Stepped `diagnose` subcommand

The current `diagnose` is just `ls` plus a few `✓` lines. Replace with a real probe that runs each step independently and reports `✓`/`✗` per step. This is what users actually need when wiring the MCP server to a new CE and something breaks.

**Files:**
- Modify: `src/cli.ts`
- Create: `test/unit/cli.diagnose.test.ts`

The probe runs:
1. **Config** — env vars present, URL parses, has host.
2. **REST handshake** — GET `/project` validates the cookie + scrapes CSRF.
3. **Reverse-proxy detection** — sniff for CF-Access on the same response (cf-ray etc.) and warn if `OVERLEAF_EXTRA_HEADERS` is empty but the response says CF.
4. **Project listing** — `listProjects()` confirms read-side REST works.
5. **OT handshake** — open a Socket.IO connection to the first project (or one specified by `--project-id`), verify `joinProjectResponse` arrives.

We expose `runDiagnose(ctx)` so it's testable.

- [ ] **Step 1: Write the failing test** at `test/unit/cli.diagnose.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDiagnose } from '../../src/cli.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '..', 'fixtures')
const csrfMetaHtml = readFileSync(join(FIXTURES, 'csrf-meta.html'), 'utf-8')

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('runDiagnose', () => {
  it('reports each step with ✓ on a healthy connection', async () => {
    server.use(
      http.get('https://o.example/project', () => HttpResponse.html(csrfMetaHtml)),
    )
    const lines: string[] = []
    const result = await runDiagnose(
      {
        url: 'https://o.example',
        sessionCookie: 'overleaf_session2=abc',
        extraHeaders: {},
      },
      { writeLine: (s) => lines.push(s), skipOt: true },
    )
    expect(result.ok).toBe(true)
    expect(lines.join('\n')).toMatch(/✓ config/i)
    expect(lines.join('\n')).toMatch(/✓ REST handshake/i)
    expect(lines.join('\n')).toMatch(/✓ project listing/i)
  })

  it('reports ✗ + AuthFailedError when the cookie is invalid', async () => {
    server.use(
      http.get('https://o.example/project', () =>
        HttpResponse.text('', { status: 302, headers: { Location: '/login' } }),
      ),
    )
    const lines: string[] = []
    const result = await runDiagnose(
      {
        url: 'https://o.example',
        sessionCookie: 'overleaf_session2=expired',
        extraHeaders: {},
      },
      { writeLine: (s) => lines.push(s), skipOt: true },
    )
    expect(result.ok).toBe(false)
    expect(lines.join('\n')).toMatch(/✗ REST handshake/i)
    expect(lines.join('\n')).toMatch(/OVERLEAF_AUTH_FAILED/i)
  })

  it('warns when CF-Access-style headers are detected but extraHeaders is empty', async () => {
    server.use(
      http.get('https://o.example/project', () =>
        HttpResponse.html(csrfMetaHtml, { headers: { 'cf-ray': 'abc-LHR' } }),
      ),
    )
    const lines: string[] = []
    await runDiagnose(
      {
        url: 'https://o.example',
        sessionCookie: 'overleaf_session2=abc',
        extraHeaders: {},
      },
      { writeLine: (s) => lines.push(s), skipOt: true },
    )
    expect(lines.join('\n')).toMatch(/⚠.*CF/i)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- test/unit/cli.diagnose.test.ts
```

Expected: FAIL — `runDiagnose` not exported.

- [ ] **Step 3: Add `runDiagnose` to `src/cli.ts`**

In `src/cli.ts`, add new imports near the existing ones:

```typescript
import { OverleafHttp } from './overleaf/http.js'
import { OverleafRest } from './overleaf/rest.js'
import { OverleafSocket } from './overleaf/socket.js'
import { OtEngine } from './overleaf/ot.js'
```

Add the exported function (before the `main` function):

```typescript
export interface DiagnoseConfig {
  url: string
  sessionCookie: string
  extraHeaders: Record<string, string>
}

export interface DiagnoseOptions {
  writeLine?: (line: string) => void
  skipOt?: boolean
  projectId?: string
}

export interface DiagnoseResult {
  ok: boolean
  steps: Array<{ name: string; status: 'ok' | 'fail' | 'warn'; detail?: string }>
}

/**
 * Stepped connectivity / auth / OT probe. Each step runs independently; a
 * failure in one is logged but the next steps still run when they don't
 * structurally depend on it.
 */
export async function runDiagnose(
  cfg: DiagnoseConfig,
  options: DiagnoseOptions = {},
): Promise<DiagnoseResult> {
  const writeLine = options.writeLine ?? ((s: string) => stderr.write(s + '\n'))
  const steps: DiagnoseResult['steps'] = []
  let ok = true

  // Step 1: config
  steps.push({ name: 'config', status: 'ok', detail: `URL ${cfg.url}` })
  writeLine(`✓ config — URL ${cfg.url}`)

  // Step 2: REST handshake — GET /project, capture CF headers + scrape CSRF
  let csrfToken: string | null = null
  let cfDetected = false
  try {
    const headers = new Headers({ Cookie: cfg.sessionCookie })
    for (const [k, v] of Object.entries(cfg.extraHeaders)) headers.set(k, v)
    const res = await fetch(new URL('/project', cfg.url + '/').toString(), {
      method: 'GET', headers, redirect: 'manual',
    })
    cfDetected = res.headers.has('cf-ray') || res.headers.has('cf-mitigated')
    if (res.status === 302 && (res.headers.get('location') ?? '').includes('/login')) {
      throw new AuthFailedError('Session redirected to /login (cookie expired)')
    }
    if (!res.ok) {
      throw new OverleafError('OVERLEAF_GENERIC', `GET /project returned ${res.status}`)
    }
    const html = await res.text()
    const m = html.match(/<meta\s+name="ol-csrfToken"\s+content="([^"]+)"/)
    if (!m) throw new OverleafError('OVERLEAF_GENERIC', 'CSRF meta not found')
    csrfToken = m[1]!
    steps.push({ name: 'REST handshake', status: 'ok' })
    writeLine('✓ REST handshake — cookie valid, CSRF scraped')
  } catch (err) {
    ok = false
    const msg = err instanceof OverleafError ? `${err.code}: ${err.message}` : String((err as Error).message ?? err)
    steps.push({ name: 'REST handshake', status: 'fail', detail: msg })
    writeLine(`✗ REST handshake — ${msg}`)
    return { ok, steps } // Subsequent steps require a session
  }

  // Step 3: Reverse-proxy hint
  if (cfDetected && Object.keys(cfg.extraHeaders).length === 0) {
    steps.push({
      name: 'reverse-proxy',
      status: 'warn',
      detail: 'CF-Access headers detected on /project response but OVERLEAF_EXTRA_HEADERS is empty; OT handshake may fail',
    })
    writeLine('⚠ reverse-proxy — CF detected but no extra headers configured')
  } else if (cfDetected) {
    writeLine('✓ reverse-proxy — CF detected, extraHeaders configured')
  }

  // Step 4: project listing
  let projectId: string | undefined = options.projectId
  try {
    const http = new OverleafHttp({ url: cfg.url, sessionCookie: cfg.sessionCookie, csrfToken: csrfToken ?? undefined, extraHeaders: cfg.extraHeaders })
    const rest = new OverleafRest(http)
    const projects = await rest.listProjects()
    steps.push({ name: 'project listing', status: 'ok', detail: `${projects.length} project(s)` })
    writeLine(`✓ project listing — ${projects.length} project(s) accessible`)
    projectId = projectId ?? projects[0]?.id
  } catch (err) {
    ok = false
    const msg = err instanceof OverleafError ? `${err.code}: ${err.message}` : String((err as Error).message ?? err)
    steps.push({ name: 'project listing', status: 'fail', detail: msg })
    writeLine(`✗ project listing — ${msg}`)
  }

  // Step 5: OT handshake
  if (!options.skipOt && projectId) {
    try {
      const sock = new OverleafSocket({ url: cfg.url, projectId, sessionCookie: cfg.sessionCookie, extraHeaders: cfg.extraHeaders })
      const engine = new OtEngine({ socket: sock, projectId })
      await Promise.race([
        engine.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new OverleafError('OVERLEAF_GENERIC', 'OT handshake timeout 8s')), 8000)),
      ])
      steps.push({ name: 'OT handshake', status: 'ok', detail: `publicId ${engine.publicId}` })
      writeLine(`✓ OT handshake — publicId ${engine.publicId}`)
      engine.disconnect()
    } catch (err) {
      ok = false
      const msg = err instanceof OverleafError ? `${err.code}: ${err.message}` : String((err as Error).message ?? err)
      steps.push({ name: 'OT handshake', status: 'fail', detail: msg })
      writeLine(`✗ OT handshake — ${msg}`)
    }
  }

  return { ok, steps }
}
```

`AuthFailedError` is already imported in the file (it's part of the existing top-level catcher). Add `OverleafError` to that import if not already present.

Now replace the existing `diagnose` branch in `main()`:

```typescript
  if (cmd === 'ls' || cmd === 'diagnose') {
    if (cmd === 'diagnose') {
      const cfg = loadConfig()
      const result = await runDiagnose(cfg)
      process.exit(result.ok ? 0 : 2)
    }
    // (existing ls path stays)
    const cfg = loadConfig()
    ...
  }
```

(Refactor so `ls` is its own branch and `diagnose` calls `runDiagnose` and exits with its status.)

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/cli.diagnose.test.ts
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; full suite at 158.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts test/unit/cli.diagnose.test.ts
git commit -m "feat(cli): stepped diagnose subcommand (config, REST, CF, projects, OT)"
```

---

## Task 8: README config examples for reverse-proxy auth

Per the spec § "Auth pass-through headers" (lines 73–86), document the four common deployment shapes the user may hit. Currently the README has a single Cloudflare Access example; expand to a dedicated section with worked examples.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a new "Reverse-proxy auth (worked examples)" section to `README.md`**

Find the existing "Reverse-proxy auth" section (containing the single CF Access example). Replace it entirely with:

```markdown
## Reverse-proxy auth (worked examples)

Many self-hosted Overleaf deployments are fronted by an authentication proxy. `OVERLEAF_EXTRA_HEADERS` is a JSON object whose keys/values are merged into every REST request **and** the Socket.IO upgrade — both layers see the same headers.

### Cloudflare Access (service token)

Generate a service token in the Zero Trust dashboard, then:

```jsonc
{
  "mcpServers": {
    "overleaf": {
      "command": "npx",
      "args": ["-y", "overleaf-mcp@latest"],
      "env": {
        "OVERLEAF_URL": "https://overleaf.corp.example",
        "OVERLEAF_SESSION_COOKIE": "overleaf.sid=s%3A...",
        "OVERLEAF_EXTRA_HEADERS": "{\"CF-Access-Client-Id\":\"abc.access\",\"CF-Access-Client-Secret\":\"...\"}"
      }
    }
  }
}
```

The pair `CF-Access-Client-Id` / `CF-Access-Client-Secret` is a CF service-token credential.

### HTTP Basic Auth in front of Overleaf

```jsonc
"env": {
  "OVERLEAF_URL": "https://overleaf.corp.example",
  "OVERLEAF_SESSION_COOKIE": "overleaf.sid=s%3A...",
  "OVERLEAF_EXTRA_HEADERS": "{\"Authorization\":\"Basic dXNlcjpwYXNzd29yZA==\"}"
}
```

The `Basic ...` value is `base64(user:password)`. Generate with `printf 'user:password' | base64` (don't include a trailing newline).

### Authelia / oauth2-proxy / forward-auth

These proxies typically inject `Remote-User` / `X-Forwarded-User` / `X-Forwarded-Email` after the user has already authenticated, but if you have a service-account flow that lets you skip the interactive auth, set those headers directly:

```jsonc
"env": {
  "OVERLEAF_URL": "https://overleaf.corp.example",
  "OVERLEAF_SESSION_COOKIE": "overleaf.sid=s%3A...",
  "OVERLEAF_EXTRA_HEADERS": "{\"Remote-User\":\"agent@local\",\"X-Forwarded-User\":\"agent@local\"}"
}
```

If your proxy expects a bearer token from a long-lived service account, send `Authorization: Bearer ...` instead. Run `overleaf-mcp diagnose` after configuring — a missing or wrong header surfaces as `OVERLEAF_AUTH_FAILED` on the REST step or `OT connectionRejected: invalid session` on the OT step.

### Tailscale / VPN (no extra headers)

If Overleaf is reachable only via a Tailscale node or a VPN, no headers are needed at the application layer — the network already authenticates. Just point `OVERLEAF_URL` at the internal hostname:

```jsonc
"env": {
  "OVERLEAF_URL": "http://overleaf.tail-scale.ts.net",
  "OVERLEAF_SESSION_COOKIE": "overleaf.sid=s%3A..."
}
```

### Sanity-check: `overleaf-mcp diagnose`

After wiring credentials, run from a shell:

```bash
overleaf-mcp diagnose
```

Output is a step-by-step report:

```
✓ config — URL https://overleaf.corp.example
✓ REST handshake — cookie valid, CSRF scraped
✓ reverse-proxy — CF detected, extraHeaders configured
✓ project listing — 3 project(s) accessible
✓ OT handshake — publicId P.abc...
```

A `✗` on any step prints the underlying error code (`OVERLEAF_AUTH_FAILED`, `PROXY_AUTH_FAILED`, `PROJECT_ACCESS_DENIED`) so you know which layer to fix.
```

- [ ] **Step 2: Run typecheck and full suite (sanity)**

```bash
npm run typecheck && npm test
```

Expected: still 158/158, typecheck clean (docs change doesn't affect either).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(README): worked auth-pass-through examples (CF Access, basic, Authelia, Tailscale)"
```

---

## Task 9: Status update + version bump to 0.4.0

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-04-25-overleaf-mcp-design.md`
- Modify: `package.json`
- Modify: `src/cli.ts` (HELP)
- Modify: `src/mcp/server.ts` (server `version` literal)

- [ ] **Step 1: Update CLAUDE.md status**

Replace the Status section in `CLAUDE.md` with:

```markdown
## Status

- v0.1 (read-only via REST + project-zip cache) — superseded by v0.2
- v0.2 (OT-live reads + writes via ported Overleaf-Workshop Socket.IO client) — superseded by v0.3
- v0.3 (REST tree mutations: create_doc, create_folder, upload_file, rename, move, delete_entity) — superseded by v0.4
- v0.4 (polish: error mapping, per-doc write serialization, reconnect jitter, diagnose subcommand, pdfDownloadDomain, README auth examples) — shipped
- v1.0 (npm publish under AGPL-3.0 with Workshop attribution) — not yet started
- Implementation lives at the repo root (`src/`, `test/`, `scripts/`, `package.json`, …)
```

- [ ] **Step 2: Update spec status**

In `docs/superpowers/specs/2026-04-25-overleaf-mcp-design.md`, change:

```markdown
### v0.4 — Polish (~3 days)
```

to:

```markdown
### v0.4 — Polish (~3 days) — shipped
```

- [ ] **Step 3: Bump version**

In `package.json`: `"version": "0.3.0"` → `"version": "0.4.0"`.

In `src/cli.ts`: find `MCP server for Overleaf Community Edition (v0.3)` in the HELP string → change to `(v0.4)`.

In `src/mcp/server.ts`: find `version: '0.3.0'` (in the `new Server(...)` constructor) → change to `'0.4.0'`.

- [ ] **Step 4: Run typecheck + full suite**

```bash
npm run typecheck && npm test
```

Expected: still 158/158; typecheck clean.

- [ ] **Step 5: Build to confirm dist is current**

```bash
npm run build
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-04-25-overleaf-mcp-design.md package.json src/cli.ts src/mcp/server.ts
git commit -m "docs(v0.4): mark v0.4 shipped, bump to 0.4.0"
```

---

## Final smoke pass

After all 9 tasks merge, run:

- [ ] **Step 1: Build**

```bash
npm run build
```

- [ ] **Step 2: Live diagnose**

```bash
node dist/cli.js diagnose
```

Expected: 5 ✓ lines (or 4 ✓ + 1 ⚠ if your CE is behind CF and headers are configured), exit 0.

- [ ] **Step 3: Verify the existing live integration still passes**

```bash
# Credentials live in .env.integration (gitignored). See .env.integration.example.
set -a; source .env.integration; set +a
RUN_INTEGRATION=1 npm run test:integration
```

Expected: 3 tests pass — REST listing+compile, OT roundtrip, v0.3 tree CRUD.

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| `diagnose` subcommand | Task 7 |
| Improved error mapping (CF Access vs. Overleaf 401) | Task 2 |
| Reconnect / backoff hardening | Task 4 |
| README config examples | Task 8 |
| (punch list) Per-doc write serialization | Task 3 |
| (punch list) `pdfDownloadDomain` consumption | Task 5 |
| (punch list) `upload_file` MIME sniff fallback | Task 6 |
| (punch list) Trailing-slash strip URL bug | Task 1 |
| (punch list) `ProjectAccessDeniedError` wiring | Task 2 |
| Version bump + spec status | Task 9 |

**Deferred to a future minor (not in v0.4):**
- Subpath-deployed Overleaf support — would need refactoring of `OverleafHttp` URL composition and a CE deploy in that config to test against. Carried into v0.5 if/when there's a real user need.
- v1.0 npm publish — surface is now stable enough but publishing is a separate concern (LICENSE+README packaging, npm-publish script, tagging).

---

## Self-review notes

- **Type consistency**: `runDiagnose`'s `DiagnoseConfig` is the same shape as the existing `Config` type's URL/cookie/extraHeaders triple, but explicitly defined in `cli.ts` to keep the export self-contained for tests.
- **`OtEngine` schema migration**: Task 4 adds optional `onReconnectFailed` and `schedule` to `OtEngineOptions` — both default-friendly, no breaking change to existing call sites in `OtEngineRegistry` or `buildContext`.
- **`writeQueues` in Task 3** is keyed by `docId` not `path`, which is intentional: the queue must be invariant across renames since the write targets the doc's stable id.
- **`pdfDownloadDomain` join in Task 5** uses string concat on a leading-slash buildUrl. Don't use `new URL(buildUrl, base)` because it would resolve absolute URLs against the base differently than expected. The `buildUrl.startsWith('/')` guard ensures we only prepend when the URL is relative.
- **`mime.ts` factoring in Task 6** is a deliberate small split: extracting the MIME table is cleaner than re-exporting from `index.ts` and avoids any import cycles between `tools/index.ts` and `tools/tree.ts`.
- **`diagnose` test in Task 7** uses `skipOt: true` because the OT step needs a real Socket.IO mock that's harder than msw can provide. The OT-step coverage comes from the integration test (Task 14 from v0.3, still gated).
