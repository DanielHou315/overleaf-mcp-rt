# overleaf-mcp v0.2 OT Writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `overleaf-mcp` v0.2 — adds `write_doc` and `apply_patch` MCP tools that flow edits through Overleaf's native Socket.IO operational-transform pipeline so changes appear as live collaborator edits (no "file changed externally" toast). Read tools (`read_doc`, `get_project_tree`) migrate from the v0.1 zip cache to live OT-backed state. The v0.1 zip-cache machinery is retired.

**Architecture:** Port the Socket.IO client and OT lifecycle from [Overleaf-Workshop](https://github.com/iamhyc/Overleaf-Workshop) (`src/api/socketio.ts`). Per project: one persistent Socket.IO connection (using the `github:overleaf/socket.io-client#0.9.17-overleaf-5` fork), opened lazily on first `read_doc` / `write_doc`. The connection joins the project (server-driven `joinProjectResponse` returns the tree + the agent's `publicId`), and joins individual docs lazily via `joinDoc(docId, { encodeRanges: true })`. Writes diff old→new text via `fast-diff`, convert to `[{p, i?, d?}]` ops, and emit `applyOtUpdate { doc, op, v }` with an ack callback. Tree-mutation events from other clients (`reciveNewDoc`, `reciveEntityRename`, `removeEntity`, …) update the in-memory tree so reads stay coherent. Cursor presence is suppressed (no `clientTracking.updatePosition`).

**Tech Stack:**
- Node.js ≥ 20 (carry-over from v0.1)
- TypeScript 5 (strict, NodeNext ESM — carry-over)
- `socket.io-client@github:overleaf/socket.io-client#0.9.17-overleaf-5` (Overleaf's fork; v0.9 protocol)
- `fast-diff` for text diffing (Myers diff)
- `vitest` + `msw` (carry-over)
- Reference port source: Overleaf-Workshop's `src/api/socketio.ts` (AGPL-3.0, attribution preserved)

**Spec reference:** `docs/superpowers/specs/2026-04-25-overleaf-mcp-design.md` — especially § "File sync details (OT engine)" and § "v0.2 — OT writes and live reads".

---

## Prerequisites

Before Task 1, clone Overleaf-Workshop locally as a read-only reference (gitignored):

```bash
cd /home/daniel/Code/overleaf-ot-mcp
git clone https://github.com/iamhyc/Overleaf-Workshop.git overleaf-workshop
echo "overleaf-workshop/" >> .gitignore
git add .gitignore && git commit -m "Ignore overleaf-workshop research clone"
```

The implementer will read `overleaf-workshop/src/api/socketio.ts`, `overleaf-workshop/src/api/base.ts`, and `overleaf-workshop/package.json` for protocol details and dep versions during Tasks 5–12.

---

## File Structure

After v0.2 the repo root contains:

```
src/
├── cli.ts                          (unchanged from v0.1)
├── config.ts                       (unchanged)
├── errors.ts                       (Task 2: add OT_VERSION_CONFLICT)
├── mcp/
│   ├── server.ts                   (Task 13: ServerContext.ot replaces .cache)
│   └── tools/
│       ├── index.ts                (Tasks 16/17: register write_doc + apply_patch)
│       ├── projects.ts             (Task 15: get_project_tree uses OT)
│       ├── docs.ts                 (Tasks 14, 16: read_doc uses OT, add write_doc)
│       ├── compile.ts              (unchanged)
│       └── writes.ts               (Tasks 16, 17: write_doc + apply_patch handlers)
└── overleaf/
    ├── http.ts                     (unchanged)
    ├── auth.ts                     (unchanged)
    ├── rest.ts                     (Task 16: keep listProjects + compile + downloadOutputFile + downloadFile; downloadProjectZip kept until Task 19)
    ├── diff.ts                     (Task 3: NEW — text → OT ops)
    ├── socket.ts                   (Task 5: NEW — Socket.IO fork wrapper, SocketLike interface)
    ├── ot.types.ts                 (Task 4: NEW — wire schemas)
    ├── ot.ts                       (Tasks 6–12: NEW — OtEngine + OtEngineRegistry)
    ├── zip.ts                      (DELETED in Task 19)
    ├── tree.ts                     (DELETED in Task 19 — replaced by tree state inside ot.ts)
    └── cache.ts                    (DELETED in Task 19 — replaced by OtEngineRegistry)

test/
├── fixtures/                       (project.zip, *-list.html etc.; Task 19 removes the v0.1-only ones)
├── unit/
│   ├── (existing v0.1 tests — most stay; cache/zip/tree tests deleted in Task 19)
│   ├── diff.test.ts                (Task 3)
│   ├── ot.handshake.test.ts        (Task 6)
│   ├── ot.joindoc.test.ts          (Task 7)
│   ├── ot.write.test.ts            (Task 8)
│   ├── ot.resync.test.ts           (Task 9)
│   ├── ot.tree-events.test.ts      (Task 10)
│   ├── ot.reconnect.test.ts        (Task 11)
│   ├── ot.registry.test.ts         (Task 12)
│   └── fake-socket.ts              (Task 5: shared SocketLike test double)
└── integration/
    └── ce-fixture.test.ts          (Task 20: extend with OT write E2E)
```

Each module has one clear responsibility. `socket.ts` is wire transport + auth threading, `diff.ts` is a pure function, `ot.ts` is the stateful engine that orchestrates them. The MCP tool layer never touches Socket.IO directly — it goes through the engine.

---

## Task 1: Install OT dependencies

**Files:**
- Modify: `package.json` (add deps + types)
- Modify: `package-lock.json` (regenerated)

- [ ] **Step 1: Inspect Workshop's package.json for the exact fork ref**

```bash
curl -fsSL https://raw.githubusercontent.com/iamhyc/Overleaf-Workshop/master/package.json | jq '.dependencies | with_entries(select(.key | test("socket|fast-diff")))'
```

Expected: prints something like
```json
{
  "fast-diff": "^1.3.0",
  "socket.io-client": "github:overleaf/socket.io-client#0.9.17-overleaf-5"
}
```

- [ ] **Step 2: Add the runtime deps**

In `package.json`, add to `"dependencies"`:

```json
"fast-diff": "^1.3.0",
"socket.io-client": "github:overleaf/socket.io-client#0.9.17-overleaf-5"
```

(Keep alphabetical order: between `@modelcontextprotocol/sdk` and `node-html-parser` if alphabetised, or wherever the existing keys sort — match the file's existing convention.)

- [ ] **Step 3: Add types**

In `"devDependencies"`, add:

```json
"@types/fast-diff": "^1.2.5"
```

There is no `@types/socket.io-client` for v0.9 — the fork ships untyped. We'll declare a minimal ambient type in Task 5.

- [ ] **Step 4: Install**

```bash
npm install
```

Expected: clean install. The github fork pulls a tarball; this can take ~10–30s.

- [ ] **Step 5: Smoke-import**

Run an inline check that the deps actually load:

```bash
node --input-type=module -e "
  import diff from 'fast-diff';
  import io from 'socket.io-client';
  console.log('fast-diff:', typeof diff);
  console.log('socket.io-client:', typeof io.connect);
"
```

Expected output:
```
fast-diff: function
socket.io-client: function
```

If `socket.io-client` doesn't resolve, the github fork failed to install. Re-run `npm install` and inspect npm's stderr.

- [ ] **Step 6: Run existing test suite**

```bash
npm test
```

Expected: 51/51 still passing — adding deps must not break anything.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(deps): add socket.io-client fork + fast-diff for OT"
```

---

## Task 2: Add OT_VERSION_CONFLICT error code

The OT engine needs a stable error code for version-mismatch escalation per the spec § "Error taxonomy". Add it to the existing taxonomy.

**Files:**
- Modify: `src/errors.ts`
- Modify: `test/unit/errors.test.ts`

- [ ] **Step 1: Update the failing test first**

Append to `test/unit/errors.test.ts` inside the `describe('errors', ...)` block (before the closing `})`):

```typescript
  it('OtVersionConflictError carries a stable code and context', () => {
    const e = new OtVersionConflictError('doc fell behind', { docId: 'd1', version: 5 })
    expect(e.code).toBe('OT_VERSION_CONFLICT')
    expect(e.context).toEqual({ docId: 'd1', version: 5 })
    expect(e).toBeInstanceOf(OverleafError)
  })
```

And add the import at the top of the file:

```typescript
import {
  OverleafError,
  AuthFailedError,
  ProxyAuthFailedError,
  ProjectAccessDeniedError,
  NetworkError,
  OtVersionConflictError,
} from '../../src/errors.js'
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- test/unit/errors.test.ts
```

Expected: FAIL — `OtVersionConflictError` is not exported.

- [ ] **Step 3: Add the new code to ErrorCode union**

In `src/errors.ts`, change the `ErrorCode` union to add `OT_VERSION_CONFLICT`:

```typescript
export type ErrorCode =
  | 'OVERLEAF_GENERIC'
  | 'OVERLEAF_AUTH_FAILED'
  | 'PROXY_AUTH_FAILED'
  | 'PROJECT_ACCESS_DENIED'
  | 'NETWORK_ERROR'
  | 'INVALID_CONFIG'
  | 'NOT_FOUND'
  | 'OT_VERSION_CONFLICT'
```

- [ ] **Step 4: Add the OtVersionConflictError class**

Append to the bottom of `src/errors.ts`:

```typescript
export class OtVersionConflictError extends OverleafError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super('OT_VERSION_CONFLICT', message, context)
  }
}
```

- [ ] **Step 5: Run the test, verify it passes**

```bash
npm test -- test/unit/errors.test.ts
```

Expected: PASS — 6 tests now (5 from v0.1 + 1 new).

- [ ] **Step 6: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; full suite 52/52.

- [ ] **Step 7: Commit**

```bash
git add src/errors.ts test/unit/errors.test.ts
git commit -m "feat(errors): add OtVersionConflictError for OT resync failures"
```

---

## Task 3: Diff translator (`src/overleaf/diff.ts`)

Pure function: `(oldText, newText) → OtOp[]`. Wraps `fast-diff` and converts its `[op, text]` triples into Overleaf's `{p, i?, d?}` shape with character offsets. This is the only OT primitive that's testable as a pure function.

**Files:**
- Create: `src/overleaf/diff.ts`
- Create: `test/unit/diff.test.ts`

- [ ] **Step 1: Write the failing test**

Path: `test/unit/diff.test.ts`

```typescript
import { describe, it, expect } from 'vitest'
import { computeOps, type OtOp } from '../../src/overleaf/diff.js'

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
    // 'Intro' → 'Introduction' is a delete + insert at offset 9
    expect(ops).toEqual<OtOp[]>([
      { p: 9, d: 'Intro' },
      { p: 9, i: 'Introduction' },
    ])
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
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- test/unit/diff.test.ts
```

Expected: FAIL — `Cannot find module '../../src/overleaf/diff.js'`.

- [ ] **Step 3: Write the implementation**

Path: `src/overleaf/diff.ts`

```typescript
import diff from 'fast-diff'

export interface OtOp {
  /** Character offset in the flattened doc where the op applies. */
  p: number
  /** Insert: the text to insert at p. */
  i?: string
  /** Delete: the exact text being removed at p (server validates byte-equality). */
  d?: string
}

const EQUAL = 0
const DELETE = -1
const INSERT = 1

/**
 * Compute the minimal `OtOp[]` that transforms `oldText` into `newText`.
 *
 * Walks fast-diff's `[op, text]` tuples, tracking a running character offset.
 * Equal segments advance the offset; deletes emit a delete op at the current
 * offset (offset is NOT advanced — the deleted chars no longer exist after);
 * inserts emit an insert op at the current offset and advance the offset by
 * the inserted text length.
 *
 * For replace patterns (delete immediately followed by insert at the same
 * offset), we emit the delete first, then the insert at the SAME offset.
 * Spec § "Write path" requires deletes to carry the exact bytes being removed
 * for server validation, so the order matters.
 */
export function computeOps(oldText: string, newText: string): OtOp[] {
  if (oldText === newText) return []
  const tuples = diff(oldText, newText)
  const ops: OtOp[] = []
  let p = 0
  for (const [kind, text] of tuples) {
    if (kind === EQUAL) {
      p += text.length
    } else if (kind === DELETE) {
      ops.push({ p, d: text })
      // Do NOT advance p: the deleted chars are gone after this op applies.
    } else if (kind === INSERT) {
      ops.push({ p, i: text })
      p += text.length
    }
  }
  return ops
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/diff.test.ts
```

Expected: PASS — 8 tests.

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/overleaf/diff.ts test/unit/diff.test.ts
git commit -m "feat(overleaf): add fast-diff → OT op translator"
```

---

## Task 4: OT wire schemas (`src/overleaf/ot.types.ts`)

Define the TypeScript types for Overleaf's Socket.IO wire payloads. These mirror Workshop's `UpdateSchema`, `ProjectEntity`, etc., but trimmed to what v0.2 actually consumes (no chat, no spell-check, no compiler-update events).

**Files:**
- Create: `src/overleaf/ot.types.ts`

This task has no test of its own — these are pure type definitions, exercised via the OT engine tests in later tasks. Just write the file and verify typecheck passes.

- [ ] **Step 1: Write the types file**

Path: `src/overleaf/ot.types.ts`

```typescript
import type { OtOp } from './diff.js'

/**
 * Server response to `joinProject` emit. The v2 server-driven handshake.
 * Workshop reference: src/api/socketio.ts: socket.on('joinProjectResponse', ...)
 */
export interface JoinProjectResponse {
  project: ProjectEntity
  permissionsLevel: 'owner' | 'readAndWrite' | 'readOnly' | string
  protocolVersion: number
  publicId: string
}

/** Server response to `connectionAccepted` event — the second source of publicId. */
export interface ConnectionAcceptedPayload {
  publicId: string
}

/** Top-level project tree entity. */
export interface ProjectEntity {
  _id: string
  name: string
  rootDoc_id: string
  rootFolder: FolderEntity[]
  features?: Record<string, unknown>
  // Other fields (compiler, owner, etc.) ignored for v0.2.
}

/** A folder in the project tree. */
export interface FolderEntity {
  _id: string
  name: string
  docs: DocEntity[]
  fileRefs: FileRefEntity[]
  folders: FolderEntity[]
}

/** A text doc in the tree (content not included; fetch via joinDoc). */
export interface DocEntity {
  _id: string
  name: string
}

/** A binary file in the tree. */
export interface FileRefEntity {
  _id: string
  name: string
  linkedFileData?: unknown
  created?: string
}

/**
 * OT update payload — the shape both directions on the wire.
 * Workshop reference: src/api/socketio.ts: UpdateSchema.
 */
export interface UpdateSchema {
  /** Doc ID the update applies to. */
  doc: string
  /** Ops, omitted on no-op acks. */
  op?: OtOp[]
  /** Doc version this update brings the doc TO. */
  v: number
  /** Optional: last known version (some Overleaf versions require it). */
  lastV?: number
  /** Server-stamped metadata, present on otUpdateApplied broadcasts. */
  meta?: {
    source: string  // socket.io client publicId
    ts: number      // unix epoch ms
    user_id: string
  }
}

/**
 * Server response to `joinDoc(docId, { encodeRanges: true })` emit.
 *
 * Returns the doc as an array of lines (latin1-packed UTF-8), the version
 * number, and pending updates that haven't been applied yet (we ignore
 * pending ops in v0.2 — server applies them server-side).
 *
 * Note: the lines come back as latin1 bytes. To recover UTF-8 text:
 *   Buffer.from(line, 'latin1').toString('utf-8')
 */
export type JoinDocResponse = [
  lines: string[],
  version: number,
  /** Pending updates the server has buffered; we don't replay them. */
  updates: UpdateSchema[],
  /** Optional ranges payload; not consumed in v0.2. */
  ranges?: unknown,
]
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: clean — these are pure type definitions, no runtime code.

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: still 52/52 (no behaviour change).

- [ ] **Step 4: Commit**

```bash
git add src/overleaf/ot.types.ts
git commit -m "feat(overleaf): add Socket.IO OT wire schemas"
```

---

## Task 5: Socket wrapper + SocketLike interface + FakeSocket test util

Wraps the socket.io-client v0.9 fork in a thin promisified facade so the OT engine can be tested against a fake. The fork is untyped, so we declare an ambient type for the bits we use.

**Files:**
- Create: `src/overleaf/socket.ts`
- Create: `src/overleaf/socket.d.ts` (ambient type for socket.io-client v0.9)
- Create: `test/unit/fake-socket.ts` (test double; not a test itself)
- Create: `test/unit/socket.test.ts` (verifies the wrapper threads auth correctly)

- [ ] **Step 1: Write the ambient type for the v0.9 fork**

Path: `src/overleaf/socket.d.ts`

```typescript
/**
 * Minimal ambient declaration for github:overleaf/socket.io-client#0.9.17-overleaf-5.
 * The fork ships untyped; we only depend on a small surface.
 */
declare module 'socket.io-client' {
  export interface ClientOptions {
    'force new connection'?: boolean
    reconnect?: boolean
    'reconnection limit'?: number
    'max reconnection attempts'?: number
    transports?: string[]
    extraHeaders?: Record<string, string>
    query?: string
  }

  export interface ClientSocket {
    emit(event: string, ...args: unknown[]): void
    on(event: string, handler: (...args: unknown[]) => void): void
    off(event: string, handler?: (...args: unknown[]) => void): void
    removeListener(event: string, handler?: (...args: unknown[]) => void): void
    disconnect(): void
    socket: { connected: boolean; connect: () => void }
    json: { emit(event: string, ...args: unknown[]): void }
  }

  export function connect(url: string, options?: ClientOptions): ClientSocket

  const _default: { connect: typeof connect }
  export default _default
}
```

- [ ] **Step 2: Write the failing test for the wrapper**

Path: `test/unit/socket.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest'
import { OverleafSocket, type SocketLike } from '../../src/overleaf/socket.js'

describe('OverleafSocket', () => {
  it('builds the v2-scheme connection URL with projectId query', () => {
    const calls: Array<{ url: string; options: Record<string, unknown> }> = []
    const fakeConnect = vi.fn((url: string, options: Record<string, unknown>) => {
      calls.push({ url, options })
      return {
        emit: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        removeListener: vi.fn(),
        disconnect: vi.fn(),
        socket: { connected: false, connect: vi.fn() },
        json: { emit: vi.fn() },
      }
    })

    const sock = new OverleafSocket(
      {
        url: 'https://overleaf.example.com',
        projectId: 'p1',
        sessionCookie: 'overleaf_session2=abc',
        extraHeaders: { 'CF-Access-Client-Id': 'xyz' },
      },
      fakeConnect as unknown as typeof import('socket.io-client').connect,
    )
    void sock // construct only

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toMatch(/^https:\/\/overleaf\.example\.com\/?\?projectId=p1&t=\d+$/)
    const headers = calls[0]!.options.extraHeaders as Record<string, string>
    expect(headers.Cookie).toBe('overleaf_session2=abc')
    expect(headers.Origin).toBe('https://overleaf.example.com')
    expect(headers['CF-Access-Client-Id']).toBe('xyz')
  })

  it('emit-with-ack resolves with the ack args (skipping the err slot)', async () => {
    const onMap = new Map<string, (...args: unknown[]) => void>()
    const fakeRaw = {
      emit: vi.fn((event: string, ...args: unknown[]) => {
        // simulate immediate ack
        const ack = args[args.length - 1] as (...a: unknown[]) => void
        if (event === 'joinDoc') ack(null, ['line1', 'line2'], 7, [])
      }),
      on: vi.fn((e: string, h: (...args: unknown[]) => void) => onMap.set(e, h)),
      off: vi.fn(),
      removeListener: vi.fn(),
      disconnect: vi.fn(),
      socket: { connected: true, connect: vi.fn() },
      json: { emit: vi.fn() },
    }
    const fakeConnect = vi.fn(() => fakeRaw)
    const sock: SocketLike = new OverleafSocket(
      { url: 'http://o', projectId: 'p', sessionCookie: 'c', extraHeaders: {} },
      fakeConnect as unknown as typeof import('socket.io-client').connect,
    )

    const result = await sock.emitWithAck('joinDoc', 'd1', { encodeRanges: true })
    expect(result).toEqual([['line1', 'line2'], 7, []])
  })

  it('emit-with-ack rejects when ack carries an error', async () => {
    const fakeRaw = {
      emit: vi.fn((event: string, ...args: unknown[]) => {
        const ack = args[args.length - 1] as (...a: unknown[]) => void
        ack({ message: 'doc not found' })
      }),
      on: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
      disconnect: vi.fn(),
      socket: { connected: true, connect: vi.fn() },
      json: { emit: vi.fn() },
    }
    const fakeConnect = vi.fn(() => fakeRaw)
    const sock = new OverleafSocket(
      { url: 'http://o', projectId: 'p', sessionCookie: 'c', extraHeaders: {} },
      fakeConnect as unknown as typeof import('socket.io-client').connect,
    )
    await expect(sock.emitWithAck('joinDoc', 'd1')).rejects.toMatchObject({ message: 'doc not found' })
  })

  it('on() and off() forward to the underlying socket', () => {
    const onSpy = vi.fn()
    const offSpy = vi.fn()
    const fakeRaw = {
      emit: vi.fn(),
      on: onSpy,
      off: offSpy,
      removeListener: vi.fn(),
      disconnect: vi.fn(),
      socket: { connected: true, connect: vi.fn() },
      json: { emit: vi.fn() },
    }
    const sock = new OverleafSocket(
      { url: 'http://o', projectId: 'p', sessionCookie: 'c', extraHeaders: {} },
      vi.fn(() => fakeRaw) as unknown as typeof import('socket.io-client').connect,
    )
    const handler = () => {}
    sock.on('joinProjectResponse', handler)
    sock.off('joinProjectResponse', handler)
    expect(onSpy).toHaveBeenCalledWith('joinProjectResponse', handler)
    expect(offSpy).toHaveBeenCalledWith('joinProjectResponse', handler)
  })

  it('disconnect() closes the underlying socket', () => {
    const disconnectSpy = vi.fn()
    const fakeRaw = {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
      disconnect: disconnectSpy,
      socket: { connected: true, connect: vi.fn() },
      json: { emit: vi.fn() },
    }
    const sock = new OverleafSocket(
      { url: 'http://o', projectId: 'p', sessionCookie: 'c', extraHeaders: {} },
      vi.fn(() => fakeRaw) as unknown as typeof import('socket.io-client').connect,
    )
    sock.disconnect()
    expect(disconnectSpy).toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run the test, verify it fails**

```bash
npm test -- test/unit/socket.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Write the wrapper**

Path: `src/overleaf/socket.ts`

```typescript
import io from 'socket.io-client'
import { NetworkError } from '../errors.js'

export interface OverleafSocketOptions {
  url: string
  projectId: string
  sessionCookie: string
  extraHeaders: Record<string, string>
}

/**
 * Minimal interface the OT engine depends on. Lets us swap a FakeSocket
 * (test/unit/fake-socket.ts) for the real OverleafSocket in unit tests.
 */
export interface SocketLike {
  emit(event: string, ...args: unknown[]): void
  emitWithAck(event: string, ...args: unknown[]): Promise<unknown[]>
  on(event: string, handler: (...args: unknown[]) => void): void
  off(event: string, handler: (...args: unknown[]) => void): void
  disconnect(): void
}

/**
 * Wraps github:overleaf/socket.io-client#0.9.17-overleaf-5.
 *
 * Connects to <url>?projectId=<id>&t=<timestamp> with auth headers threaded
 * via extraHeaders (cookie + origin + user-supplied — same headers the REST
 * layer threads in v0.1). Promisifies emit-with-ack so callers `await
 * sock.emitWithAck('joinDoc', docId, opts)`.
 *
 * Construction immediately opens the socket. Use disconnect() on shutdown.
 */
export class OverleafSocket implements SocketLike {
  private readonly raw: ReturnType<typeof io.connect>

  constructor(
    private readonly opts: OverleafSocketOptions,
    connectFn: typeof io.connect = io.connect,
  ) {
    const url = `${opts.url}?projectId=${encodeURIComponent(opts.projectId)}&t=${Date.now()}`
    const origin = new URL(opts.url).origin
    this.raw = connectFn(url, {
      'force new connection': true,
      reconnect: false, // we manage reconnection in OtEngine
      transports: ['websocket', 'xhr-polling'],
      extraHeaders: {
        Cookie: opts.sessionCookie,
        Origin: origin,
        ...opts.extraHeaders,
      },
    })
  }

  emit(event: string, ...args: unknown[]): void {
    this.raw.emit(event, ...args)
  }

  /**
   * Emit an event and await its ack. The v0.9 ack signature is
   * `(err, ...data) => void`; we resolve with `data` (an array) and reject
   * with `err` if non-null.
   */
  emitWithAck(event: string, ...args: unknown[]): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const ack = (err: unknown, ...data: unknown[]): void => {
        if (err) {
          reject(err instanceof Error ? err : new NetworkError(String((err as { message?: string })?.message ?? err)))
        } else {
          resolve(data)
        }
      }
      this.raw.emit(event, ...args, ack)
    })
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    this.raw.on(event, handler)
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    this.raw.off(event, handler)
  }

  disconnect(): void {
    this.raw.disconnect()
  }
}
```

- [ ] **Step 5: Run the test, verify it passes**

```bash
npm test -- test/unit/socket.test.ts
```

Expected: PASS — 5 tests.

- [ ] **Step 6: Write the FakeSocket test util**

Path: `test/unit/fake-socket.ts`

```typescript
import type { SocketLike } from '../../src/overleaf/socket.js'

/**
 * In-memory SocketLike for unit tests. Captures every emit + emitWithAck,
 * lets tests register ack responders per event, and lets tests synthesize
 * incoming events to exercise event-handler paths.
 *
 * Usage:
 *   const sock = new FakeSocket()
 *   sock.respondToEmit('joinProject', () => [null, joinProjectResponse])
 *   const engine = new OtEngine({ socket: sock, projectId: 'p1' })
 *   await engine.connect()
 *   sock.simulate('reciveNewDoc', 'parentId', { _id: 'd2', name: 'new.tex' })
 */
export class FakeSocket implements SocketLike {
  /** Every emit + emitWithAck call captured in order. */
  emits: Array<{ event: string; args: unknown[]; hadAck: boolean }> = []
  /** Per-event ack responder. The function receives the emit args (sans ack)
   *  and returns the ack tuple `[err, ...data]`. */
  private ackResponders = new Map<string, (...args: unknown[]) => unknown[]>()
  /** Default ack responder — receives event name + args, returns `[err, ...data]`. */
  private defaultAck?: (event: string, ...args: unknown[]) => unknown[]
  /** Registered listeners. */
  private handlers = new Map<string, Set<(...args: unknown[]) => void>>()
  disconnected = false

  emit(event: string, ...args: unknown[]): void {
    this.emits.push({ event, args, hadAck: false })
  }

  emitWithAck(event: string, ...args: unknown[]): Promise<unknown[]> {
    this.emits.push({ event, args, hadAck: true })
    const responder = this.ackResponders.get(event) ?? this.defaultAck
    if (!responder) {
      // Default: succeed with no data. Tests should usually register a responder.
      return Promise.resolve([])
    }
    const result = responder === this.defaultAck
      ? this.defaultAck!(event, ...args)
      : responder(...args)
    const [err, ...data] = result
    if (err) return Promise.reject(err)
    return Promise.resolve(data)
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    let set = this.handlers.get(event)
    if (!set) this.handlers.set(event, set = new Set())
    set.add(handler)
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    this.handlers.get(event)?.delete(handler)
  }

  disconnect(): void {
    this.disconnected = true
    this.simulate('disconnect')
  }

  // ---- test-only helpers ----

  /** Register an ack responder for a specific event. */
  respondToEmit(event: string, responder: (...args: unknown[]) => unknown[]): void {
    this.ackResponders.set(event, responder)
  }

  /** Register a default ack responder used when no per-event one matches. */
  setDefaultAck(responder: (event: string, ...args: unknown[]) => unknown[]): void {
    this.defaultAck = responder
  }

  /** Synthesize an incoming event from the server. */
  simulate(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.forEach((h) => h(...args))
  }

  /** All emits whose event name matches. */
  emitsOf(event: string): Array<{ event: string; args: unknown[]; hadAck: boolean }> {
    return this.emits.filter((e) => e.event === event)
  }
}
```

This file is imported by Tasks 6–11 tests. It's not itself a test (`vitest.config.ts` only picks up `*.test.ts`), so it won't be auto-run.

- [ ] **Step 7: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; full suite 57/57 (52 + 5 new socket tests).

- [ ] **Step 8: Commit**

```bash
git add src/overleaf/socket.ts src/overleaf/socket.d.ts test/unit/socket.test.ts test/unit/fake-socket.ts
git commit -m "feat(overleaf): add Socket.IO wrapper + SocketLike + FakeSocket test util"
```

---

## Task 6: OtEngine — connect + joinProject

Open the connection, wait for the v2 server-driven `joinProjectResponse`, populate the in-memory tree state and capture `publicId` (used to filter our own `otUpdateApplied` echoes in Task 8). This task establishes the engine skeleton; subsequent tasks bolt on joinDoc, write path, etc.

**Files:**
- Create: `src/overleaf/ot.ts`
- Create: `test/unit/ot.handshake.test.ts`

- [ ] **Step 1: Write the failing test**

Path: `test/unit/ot.handshake.test.ts`

```typescript
import { describe, it, expect } from 'vitest'
import { OtEngine } from '../../src/overleaf/ot.js'
import { FakeSocket } from './fake-socket.js'
import type { JoinProjectResponse } from '../../src/overleaf/ot.types.js'

const minimalJoinResponse = (): JoinProjectResponse => ({
  project: {
    _id: 'p1',
    name: 'Test Project',
    rootDoc_id: 'd-main',
    rootFolder: [
      {
        _id: 'root',
        name: 'rootFolder',
        docs: [{ _id: 'd-main', name: 'main.tex' }],
        fileRefs: [{ _id: 'f-img', name: 'img.png' }],
        folders: [
          {
            _id: 'sub',
            name: 'chapters',
            docs: [{ _id: 'd-intro', name: 'intro.tex' }],
            fileRefs: [],
            folders: [],
          },
        ],
      },
    ],
  },
  permissionsLevel: 'owner',
  protocolVersion: 2,
  publicId: 'pubId-AGENT',
})

describe('OtEngine.connect', () => {
  it('emits joinProject and resolves once joinProjectResponse arrives', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })

    // Server-driven handshake: connection-accepted → joinProjectResponse arrives.
    const connectPromise = engine.connect()
    sock.simulate('connectionAccepted', null, 'pubId-AGENT')
    sock.simulate('joinProjectResponse', minimalJoinResponse())

    await connectPromise

    expect(engine.publicId).toBe('pubId-AGENT')
    expect(engine.isConnected).toBe(true)
  })

  it('exposes a flat path → entity index after handshake', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const connectPromise = engine.connect()
    sock.simulate('connectionAccepted', null, 'pubId-AGENT')
    sock.simulate('joinProjectResponse', minimalJoinResponse())
    await connectPromise

    expect(engine.pathToDocId('main.tex')).toBe('d-main')
    expect(engine.pathToDocId('chapters/intro.tex')).toBe('d-intro')
    expect(engine.pathToFileId('img.png')).toBe('f-img')
    expect(engine.pathToDocId('missing.tex')).toBeNull()
    expect(engine.pathToFileId('missing.png')).toBeNull()
  })

  it('exposes the same TreeNode shape as v0.1 (files + folders)', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const connectPromise = engine.connect()
    sock.simulate('connectionAccepted', null, 'pubId-AGENT')
    sock.simulate('joinProjectResponse', minimalJoinResponse())
    await connectPromise

    const tree = engine.getTree()
    expect(tree.files.sort()).toEqual(['img.png', 'main.tex'])
    expect(Object.keys(tree.folders)).toEqual(['chapters'])
    expect(tree.folders.chapters!.files).toEqual(['intro.tex'])
  })

  it('connect() rejects on connectionRejected', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const connectPromise = engine.connect()
    sock.simulate('connectionRejected', { message: 'cookie expired' })
    await expect(connectPromise).rejects.toThrow(/cookie expired/)
  })

  it('disconnect() flips isConnected and unregisters listeners', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const cp = engine.connect()
    sock.simulate('connectionAccepted', null, 'pubId-AGENT')
    sock.simulate('joinProjectResponse', minimalJoinResponse())
    await cp
    engine.disconnect()
    expect(engine.isConnected).toBe(false)
    expect(sock.disconnected).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- test/unit/ot.handshake.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the engine skeleton**

Path: `src/overleaf/ot.ts`

```typescript
import type { SocketLike } from './socket.js'
import type {
  ConnectionAcceptedPayload,
  DocEntity,
  FileRefEntity,
  FolderEntity,
  JoinProjectResponse,
  ProjectEntity,
} from './ot.types.js'
import { OverleafError } from '../errors.js'

/** Mirrors v0.1's TreeNode shape so MCP tool outputs stay stable. */
export interface TreeNode {
  files: string[]
  folders: Record<string, TreeNode>
}

interface PathEntry {
  kind: 'doc' | 'file' | 'folder'
  id: string
  parentFolderId: string | null
}

export interface OtEngineOptions {
  socket: SocketLike
  projectId: string
}

/**
 * Per-project OT engine. Owns one Socket.IO connection (via SocketLike),
 * the canonical tree state, the per-doc baseline cache, and the publicId
 * used to filter our own otUpdateApplied broadcasts.
 *
 * Lifecycle: construct with a SocketLike (already opened), then `await
 * connect()` which emits joinProject and waits for joinProjectResponse +
 * connectionAccepted. After that the engine is ready for joinDoc / writeDoc.
 */
export class OtEngine {
  readonly projectId: string
  private readonly socket: SocketLike
  private _publicId: string | null = null
  private _isConnected = false
  private project: ProjectEntity | null = null
  /** Flat index: path → entry. Built/updated in updatePathIndex(). */
  private pathIndex = new Map<string, PathEntry>()

  /** Listener handles we install — cleaned up on disconnect(). */
  private installedHandlers: Array<{ event: string; handler: (...args: unknown[]) => void }> = []

  constructor(opts: OtEngineOptions) {
    this.socket = opts.socket
    this.projectId = opts.projectId
  }

  get publicId(): string | null { return this._publicId }
  get isConnected(): boolean { return this._isConnected }

  /**
   * Wait for the server-driven handshake to complete. Resolves when
   * BOTH connectionAccepted (carries publicId) AND joinProjectResponse
   * (carries the tree) have arrived. Rejects on connectionRejected.
   */
  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let gotPublicId = false
      let gotProject = false
      const finishIfReady = () => {
        if (gotPublicId && gotProject) {
          this._isConnected = true
          resolve()
        }
      }

      const onConnAccepted = (_: unknown, publicId: string): void => {
        this._publicId = publicId
        gotPublicId = true
        finishIfReady()
      }
      const onJoinResponse = (res: JoinProjectResponse): void => {
        this.project = res.project
        // joinProjectResponse can carry publicId too — treat as authoritative.
        if (res.publicId) {
          this._publicId = res.publicId
          gotPublicId = true
        }
        this.rebuildPathIndex()
        gotProject = true
        finishIfReady()
      }
      const onConnRejected = (err: { message?: string } | string): void => {
        const msg = typeof err === 'string' ? err : err?.message ?? 'connection rejected'
        reject(new OverleafError('OVERLEAF_AUTH_FAILED', `OT connectionRejected: ${msg}`))
      }

      this.installListener('connectionAccepted', onConnAccepted as (...args: unknown[]) => void)
      this.installListener('joinProjectResponse', onJoinResponse as (...args: unknown[]) => void)
      this.installListener('connectionRejected', onConnRejected as (...args: unknown[]) => void)

      // v2 mode is server-driven (the URL's projectId query causes CE to push
      // joinProjectResponse autonomously), but Workshop emits defensively in
      // case the server is in v1 mode or otherwise needs the explicit prod.
      // Belt-and-suspenders — if joinProjectResponse already arrived above,
      // the emit is harmless.
      // (Note: Task 11 will search-and-replace this.socket → this.currentSocket.
      //  Until then this references this.socket, which the constructor sets.)
      this.socket.emit('joinProject', { project_id: this.projectId })
    })
  }

  /** Path → docId, or null. */
  pathToDocId(path: string): string | null {
    const entry = this.pathIndex.get(path)
    return entry?.kind === 'doc' ? entry.id : null
  }

  /** Path → fileId (binary), or null. */
  pathToFileId(path: string): string | null {
    const entry = this.pathIndex.get(path)
    return entry?.kind === 'file' ? entry.id : null
  }

  /** Folder/file tree in the same shape as v0.1's ProjectTree.asTree(). */
  getTree(): TreeNode {
    const root: TreeNode = { files: [], folders: {} }
    if (!this.project) return root
    this.populateTreeNode(root, this.project.rootFolder[0]!)
    return root
  }

  /** Disconnect socket, flush handlers. */
  disconnect(): void {
    for (const { event, handler } of this.installedHandlers) {
      this.socket.off(event, handler)
    }
    this.installedHandlers = []
    this._isConnected = false
    this.socket.disconnect()
  }

  // ---- internals (also called by later tasks) ----

  protected installListener(event: string, handler: (...args: unknown[]) => void): void {
    this.socket.on(event, handler)
    this.installedHandlers.push({ event, handler })
  }

  protected getProject(): ProjectEntity | null { return this.project }

  /** Rebuild path → entity index from scratch. Call after joinProjectResponse. */
  protected rebuildPathIndex(): void {
    this.pathIndex.clear()
    if (!this.project) return
    this.indexFolder(this.project.rootFolder[0]!, '', null)
  }

  private indexFolder(folder: FolderEntity, prefix: string, parentId: string | null): void {
    const folderPath = prefix === '' ? '' : prefix.replace(/\/$/, '')
    if (folderPath !== '') {
      this.pathIndex.set(folderPath, { kind: 'folder', id: folder._id, parentFolderId: parentId })
    }
    for (const doc of folder.docs) {
      this.pathIndex.set(prefix + doc.name, { kind: 'doc', id: doc._id, parentFolderId: folder._id })
    }
    for (const file of folder.fileRefs) {
      this.pathIndex.set(prefix + file.name, { kind: 'file', id: file._id, parentFolderId: folder._id })
    }
    for (const sub of folder.folders) {
      this.indexFolder(sub, prefix + sub.name + '/', folder._id)
    }
  }

  private populateTreeNode(node: TreeNode, folder: FolderEntity): void {
    for (const doc of folder.docs) node.files.push(doc.name)
    for (const file of folder.fileRefs) node.files.push(file.name)
    for (const sub of folder.folders) {
      const child: TreeNode = { files: [], folders: {} }
      node.folders[sub.name] = child
      this.populateTreeNode(child, sub)
    }
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/ot.handshake.test.ts
```

Expected: PASS — 5 tests.

- [ ] **Step 5: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; full suite 62/62.

- [ ] **Step 6: Commit**

```bash
git add src/overleaf/ot.ts test/unit/ot.handshake.test.ts
git commit -m "feat(overleaf/ot): connect + joinProject + tree state"
```

---

## Task 7: OtEngine — joinDoc + baseline cache + latin1 decode

Lazy `joinDoc(docId, { encodeRanges: true })` per touched doc. Server returns `[lines, version, pendingUpdates, ranges?]` where lines are latin1-packed UTF-8. We decode them and cache `{text, version, docId}` as the baseline for subsequent writes.

**Files:**
- Modify: `src/overleaf/ot.ts`
- Create: `test/unit/ot.joindoc.test.ts`

- [ ] **Step 1: Write the failing test**

Path: `test/unit/ot.joindoc.test.ts`

```typescript
import { describe, it, expect } from 'vitest'
import { OtEngine } from '../../src/overleaf/ot.js'
import { FakeSocket } from './fake-socket.js'
import type { JoinProjectResponse } from '../../src/overleaf/ot.types.js'

function utfToLatin1Lines(text: string): string[] {
  // Mirror what Overleaf does: bytes treated as latin1 chars, split on \n.
  const bytes = Buffer.from(text, 'utf-8')
  const latin1 = bytes.toString('latin1')
  return latin1.split('\n')
}

const tinyJoin = (): JoinProjectResponse => ({
  project: {
    _id: 'p1',
    name: 'Test',
    rootDoc_id: 'd1',
    rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [{ _id: 'd1', name: 'main.tex' }], fileRefs: [], folders: [] }],
  },
  permissionsLevel: 'owner',
  protocolVersion: 2,
  publicId: 'pub',
})

describe('OtEngine.joinDoc', () => {
  it('emits joinDoc with encodeRanges and caches the baseline', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const cp = engine.connect()
    sock.simulate('connectionAccepted', null, 'pub')
    sock.simulate('joinProjectResponse', tinyJoin())
    await cp

    const lines = utfToLatin1Lines('\\section{α}\nHello.\n')
    sock.respondToEmit('joinDoc', () => [null, lines, 7, []])

    const baseline = await engine.joinDoc('d1')

    expect(baseline.docId).toBe('d1')
    expect(baseline.version).toBe(7)
    expect(baseline.text).toBe('\\section{α}\nHello.\n')
    expect(sock.emitsOf('joinDoc')[0]!.args).toEqual(['d1', { encodeRanges: true }])
  })

  it('caches; second joinDoc returns the same baseline without re-emitting', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const cp = engine.connect()
    sock.simulate('connectionAccepted', null, 'pub')
    sock.simulate('joinProjectResponse', tinyJoin())
    await cp

    sock.respondToEmit('joinDoc', () => [null, ['hi'], 1, []])
    const a = await engine.joinDoc('d1')
    const b = await engine.joinDoc('d1')
    expect(a).toBe(b)
    expect(sock.emitsOf('joinDoc')).toHaveLength(1)
  })

  it('coalesces concurrent joinDoc calls for the same docId', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const cp = engine.connect()
    sock.simulate('connectionAccepted', null, 'pub')
    sock.simulate('joinProjectResponse', tinyJoin())
    await cp

    sock.respondToEmit('joinDoc', () => [null, ['x'], 0, []])
    const [a, b] = await Promise.all([engine.joinDoc('d1'), engine.joinDoc('d1')])
    expect(a).toBe(b)
    expect(sock.emitsOf('joinDoc')).toHaveLength(1)
  })

  it('decodes UTF-8 lines from the server\'s latin1 packing correctly', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const cp = engine.connect()
    sock.simulate('connectionAccepted', null, 'pub')
    sock.simulate('joinProjectResponse', tinyJoin())
    await cp

    const original = 'αβγ\n中文\n'
    sock.respondToEmit('joinDoc', () => [null, utfToLatin1Lines(original), 0, []])
    const baseline = await engine.joinDoc('d1')
    expect(baseline.text).toBe(original)
  })

  it('readDoc returns cached text after joinDoc', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const cp = engine.connect()
    sock.simulate('connectionAccepted', null, 'pub')
    sock.simulate('joinProjectResponse', tinyJoin())
    await cp

    sock.respondToEmit('joinDoc', () => [null, ['hello'], 4, []])
    await engine.joinDoc('d1')
    expect(engine.readDoc('d1')).toBe('hello')
    expect(engine.readDoc('does-not-exist')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Expected: FAIL — `engine.joinDoc is not a function`.

- [ ] **Step 3: Extend OtEngine with joinDoc**

In `src/overleaf/ot.ts`, add the export at the top of the file (after `TreeNode`):

```typescript
export interface DocBaseline {
  docId: string
  text: string
  version: number
}
```

Add these private fields inside `OtEngine`:

```typescript
  private baselines = new Map<string, DocBaseline>()
  private inflightJoinDoc = new Map<string, Promise<DocBaseline>>()
```

Add these methods to `OtEngine`:

```typescript
  /**
   * Join a doc and cache its baseline. Idempotent within a session — a
   * second call returns the cached baseline without re-emitting joinDoc.
   * Concurrent calls for the same docId are coalesced.
   */
  async joinDoc(docId: string): Promise<DocBaseline> {
    if (!this._isConnected) {
      throw new OverleafError('OVERLEAF_GENERIC', 'OtEngine not connected')
    }
    const cached = this.baselines.get(docId)
    if (cached) return cached
    const inflight = this.inflightJoinDoc.get(docId)
    if (inflight) return inflight

    const promise = this.socket
      .emitWithAck('joinDoc', docId, { encodeRanges: true })
      .then((data) => {
        const [lines, version] = data as [string[], number, ...unknown[]]
        const text = decodeLatin1Lines(lines)
        const baseline: DocBaseline = { docId, text, version }
        this.baselines.set(docId, baseline)
        this.inflightJoinDoc.delete(docId)
        return baseline
      })
      .catch((err: unknown) => {
        this.inflightJoinDoc.delete(docId)
        throw err
      })
    this.inflightJoinDoc.set(docId, promise)
    return promise
  }

  /** Return the cached baseline text for a doc, or null if not joined yet. */
  readDoc(docId: string): string | null {
    return this.baselines.get(docId)?.text ?? null
  }

  /** For internal use by Tasks 8/9 — read or fetch the baseline. */
  protected getBaseline(docId: string): DocBaseline | undefined {
    return this.baselines.get(docId)
  }

  /** For internal use by Task 9's resync path. */
  protected clearBaseline(docId: string): void {
    this.baselines.delete(docId)
  }
```

Add the helper at the bottom of the file (or top, before the class):

```typescript
/**
 * Overleaf packs UTF-8 doc bytes through latin1 over the Socket.IO transport.
 * Each line comes back as a latin1 string whose char codes are the original
 * UTF-8 byte values; reconstruct UTF-8 by treating the chars as latin1 bytes.
 *
 * Workshop reference: src/api/socketio.ts joinDoc handler.
 */
function decodeLatin1Lines(lines: string[]): string {
  return lines.map((line) => Buffer.from(line, 'latin1').toString('utf-8')).join('\n')
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/ot.joindoc.test.ts
```

Expected: PASS — 5 tests.

- [ ] **Step 5: Run full suite + typecheck**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; 67/67.

- [ ] **Step 6: Commit**

```bash
git add src/overleaf/ot.ts test/unit/ot.joindoc.test.ts
git commit -m "feat(overleaf/ot): joinDoc with baseline cache and latin1 UTF-8 decode"
```

---

## Task 8: OtEngine — write path

Compute ops via `computeOps` (Task 3), emit `applyOtUpdate { doc, op, v }` with ack, await ack and the matching `otUpdateApplied` echo (matched by `meta.source === publicId`), then bump baseline `{text, version+1}`.

**Files:**
- Modify: `src/overleaf/ot.ts`
- Create: `test/unit/ot.write.test.ts`

- [ ] **Step 1: Write the failing test**

Path: `test/unit/ot.write.test.ts`

```typescript
import { describe, it, expect } from 'vitest'
import { OtEngine } from '../../src/overleaf/ot.js'
import { FakeSocket } from './fake-socket.js'
import type { JoinProjectResponse, UpdateSchema } from '../../src/overleaf/ot.types.js'

const tinyJoin = (): JoinProjectResponse => ({
  project: {
    _id: 'p1',
    name: 'Test',
    rootDoc_id: 'd1',
    rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [{ _id: 'd1', name: 'main.tex' }], fileRefs: [], folders: [] }],
  },
  permissionsLevel: 'owner',
  protocolVersion: 2,
  publicId: 'pub-AGENT',
})

async function readyEngine() {
  const sock = new FakeSocket()
  const engine = new OtEngine({ socket: sock, projectId: 'p1' })
  const cp = engine.connect()
  sock.simulate('connectionAccepted', null, 'pub-AGENT')
  sock.simulate('joinProjectResponse', tinyJoin())
  await cp
  sock.respondToEmit('joinDoc', () => [null, ['hello'], 4, []])
  await engine.joinDoc('d1')
  return { sock, engine }
}

describe('OtEngine.writeDoc', () => {
  it('no-ops when newContent equals baseline', async () => {
    const { sock, engine } = await readyEngine()
    await engine.writeDoc('d1', 'hello')
    expect(sock.emitsOf('applyOtUpdate')).toHaveLength(0)
    expect(engine.readDoc('d1')).toBe('hello')
  })

  it('emits applyOtUpdate with computed ops, awaits ack, advances baseline on echo', async () => {
    const { sock, engine } = await readyEngine()

    sock.respondToEmit('applyOtUpdate', (_docId, _update) => {
      // Simulate server immediately echoing the update back tagged with our publicId.
      queueMicrotask(() => {
        const echo: UpdateSchema = {
          doc: 'd1',
          op: [{ p: 5, i: ' world' }],
          v: 4, // server version BEFORE this update; baseline bumps to 5
          meta: { source: 'pub-AGENT', ts: Date.now(), user_id: 'u1' },
        }
        sock.simulate('otUpdateApplied', echo)
      })
      return [null] // ack ok
    })

    await engine.writeDoc('d1', 'hello world')

    const emit = sock.emitsOf('applyOtUpdate')[0]!
    expect(emit.args[0]).toBe('d1')
    const update = emit.args[1] as UpdateSchema
    expect(update.doc).toBe('d1')
    expect(update.op).toEqual([{ p: 5, i: ' world' }])
    expect(update.v).toBe(4)
    expect(engine.readDoc('d1')).toBe('hello world')
    // version advanced
    const baseline = (engine as unknown as { baselines: Map<string, { version: number }> }).baselines.get('d1')!
    expect(baseline.version).toBe(5)
  })

  it('ignores otUpdateApplied broadcasts from other clients', async () => {
    const { sock, engine } = await readyEngine()
    // Start a write but do not ack/echo for our publicId
    sock.respondToEmit('applyOtUpdate', () => {
      queueMicrotask(() => {
        // First simulate a foreign client's update — should NOT advance our baseline.
        sock.simulate('otUpdateApplied', {
          doc: 'd1',
          op: [{ p: 0, i: '!' }],
          v: 4,
          meta: { source: 'pub-OTHER', ts: 0, user_id: 'u2' },
        })
        // Then our own echo arrives.
        sock.simulate('otUpdateApplied', {
          doc: 'd1',
          op: [{ p: 5, i: ' world' }],
          v: 4,
          meta: { source: 'pub-AGENT', ts: 0, user_id: 'u1' },
        })
      })
      return [null]
    })
    await engine.writeDoc('d1', 'hello world')
    expect(engine.readDoc('d1')).toBe('hello world')
  })

  it('joinDoc lazily on writeDoc when no baseline exists', async () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    const cp = engine.connect()
    sock.simulate('connectionAccepted', null, 'pub-AGENT')
    sock.simulate('joinProjectResponse', tinyJoin())
    await cp

    sock.respondToEmit('joinDoc', () => [null, ['hello'], 4, []])
    sock.respondToEmit('applyOtUpdate', () => {
      queueMicrotask(() => sock.simulate('otUpdateApplied', {
        doc: 'd1',
        op: [{ p: 5, i: '!' }],
        v: 4,
        meta: { source: 'pub-AGENT', ts: 0, user_id: 'u1' },
      }))
      return [null]
    })

    await engine.writeDoc('d1', 'hello!')
    expect(sock.emitsOf('joinDoc')).toHaveLength(1)
    expect(engine.readDoc('d1')).toBe('hello!')
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Expected: FAIL — `engine.writeDoc is not a function`.

- [ ] **Step 3: Add the write path to OtEngine**

At the top of `src/overleaf/ot.ts`, add the import:

```typescript
import { computeOps, type OtOp } from './diff.js'
```

Inside `OtEngine`, add this constant near other private fields:

```typescript
  /** Pending writes awaiting their otUpdateApplied echo. */
  private pendingEchoes = new Map<string, Array<() => void>>()
  private otUpdateAppliedHandlerInstalled = false
```

Add the public methods:

```typescript
  /**
   * Replace the doc's text with newContent via OT. Computes ops, emits
   * applyOtUpdate, awaits ack + the matching otUpdateApplied echo, then
   * bumps the baseline.
   *
   * If no baseline is cached, joinDoc is called first (lazy join).
   */
  async writeDoc(docId: string, newContent: string): Promise<void> {
    let baseline = this.getBaseline(docId)
    if (!baseline) {
      baseline = await this.joinDoc(docId)
    }
    if (baseline.text === newContent) return // no-op
    const ops = computeOps(baseline.text, newContent)
    if (ops.length === 0) return
    await this.applyOps(docId, ops)
  }

  /**
   * Lower-level: emit raw OT ops at the current baseline version. The MCP
   * `apply_patch` tool routes here.
   */
  async applyOps(docId: string, ops: OtOp[]): Promise<void> {
    let baseline = this.getBaseline(docId)
    if (!baseline) baseline = await this.joinDoc(docId)
    this.ensureOtUpdateAppliedListener()

    const update = {
      doc: docId,
      op: ops,
      v: baseline.version,
    }

    // Wait for both the ack AND the otUpdateApplied echo for our publicId.
    const echoPromise = new Promise<void>((resolve) => {
      let arr = this.pendingEchoes.get(docId)
      if (!arr) this.pendingEchoes.set(docId, arr = [])
      arr.push(resolve)
    })

    await this.socket.emitWithAck('applyOtUpdate', docId, update)
    await echoPromise

    // Compute the new text from the ops we just sent (avoids depending on
    // the echo carrying it back).
    const stillBaseline = this.getBaseline(docId)
    if (stillBaseline) {
      stillBaseline.text = applyOpsLocal(stillBaseline.text, ops)
      stillBaseline.version = baseline.version + 1
    }
  }

  // ---- internals ----

  /** Install the otUpdateApplied listener once. Filters by meta.source === publicId. */
  private ensureOtUpdateAppliedListener(): void {
    if (this.otUpdateAppliedHandlerInstalled) return
    this.otUpdateAppliedHandlerInstalled = true
    this.installListener('otUpdateApplied', (raw: unknown) => {
      const update = raw as { doc?: string; meta?: { source?: string } }
      if (!update.doc) return
      // Only echoes from our own client mark a write as complete.
      if (update.meta?.source !== this._publicId) return
      const arr = this.pendingEchoes.get(update.doc)
      if (!arr || arr.length === 0) return
      const resolver = arr.shift()!
      resolver()
    })
  }
```

Add this private helper at the bottom of the file:

```typescript
/**
 * Apply ops to text locally to derive the post-update baseline. Mirrors what
 * the server will do; we use this (instead of waiting for the server to
 * echo back the resulting text) because Overleaf's otUpdateApplied
 * broadcasts only carry the op + version, not the resulting text.
 */
function applyOpsLocal(text: string, ops: OtOp[]): string {
  let out = text
  for (const op of ops) {
    if (op.i !== undefined) {
      out = out.slice(0, op.p) + op.i + out.slice(op.p)
    } else if (op.d !== undefined) {
      const slice = out.slice(op.p, op.p + op.d.length)
      if (slice !== op.d) {
        // Shouldn't happen — computeOps always emits exact-byte deletes —
        // but if it does we leave the doc unchanged rather than corrupt it.
        // The server-side ack would also reject in this case.
        return text
      }
      out = out.slice(0, op.p) + out.slice(op.p + op.d.length)
    }
  }
  return out
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/ot.write.test.ts
```

Expected: PASS — 4 tests.

- [ ] **Step 5: Run full suite + typecheck**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; 71/71.

- [ ] **Step 6: Commit**

```bash
git add src/overleaf/ot.ts test/unit/ot.write.test.ts
git commit -m "feat(overleaf/ot): write path via applyOtUpdate + otUpdateApplied filter"
```

---

## Task 9: OtEngine — version-conflict resync

When `applyOtUpdate`'s ack carries a version-mismatch error, the cached baseline is stale (some other client beat us). Per spec: re-`joinDoc` to resync, retry once. On second failure, throw `OtVersionConflictError`.

**Files:**
- Modify: `src/overleaf/ot.ts`
- Create: `test/unit/ot.resync.test.ts`

- [ ] **Step 1: Write the failing test**

Path: `test/unit/ot.resync.test.ts`

```typescript
import { describe, it, expect } from 'vitest'
import { OtEngine } from '../../src/overleaf/ot.js'
import { OtVersionConflictError } from '../../src/errors.js'
import { FakeSocket } from './fake-socket.js'
import type { JoinProjectResponse } from '../../src/overleaf/ot.types.js'

const tinyJoin = (): JoinProjectResponse => ({
  project: {
    _id: 'p1',
    name: 'Test',
    rootDoc_id: 'd1',
    rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [{ _id: 'd1', name: 'main.tex' }], fileRefs: [], folders: [] }],
  },
  permissionsLevel: 'owner',
  protocolVersion: 2,
  publicId: 'pub-AGENT',
})

async function ready() {
  const sock = new FakeSocket()
  const engine = new OtEngine({ socket: sock, projectId: 'p1' })
  const cp = engine.connect()
  sock.simulate('connectionAccepted', null, 'pub-AGENT')
  sock.simulate('joinProjectResponse', tinyJoin())
  await cp
  return { sock, engine }
}

describe('OtEngine resync on version conflict', () => {
  it('re-joinDocs and retries once on version mismatch ack', async () => {
    const { sock, engine } = await ready()
    let joinDocCalls = 0
    sock.respondToEmit('joinDoc', () => {
      joinDocCalls += 1
      // First join: version 4, text 'hello'. Second join (post-conflict):
      // version 6, text 'hello!' (someone else added an exclamation point).
      if (joinDocCalls === 1) return [null, ['hello'], 4, []]
      return [null, ['hello!'], 6, []]
    })
    await engine.joinDoc('d1')

    let applyCalls = 0
    sock.respondToEmit('applyOtUpdate', () => {
      applyCalls += 1
      if (applyCalls === 1) {
        // Simulate version-mismatch error
        return [{ message: 'version mismatch', code: 'OT_VERSION_MISMATCH' }]
      }
      // Second attempt — succeed and echo
      queueMicrotask(() => sock.simulate('otUpdateApplied', {
        doc: 'd1',
        op: [{ p: 6, i: ' world' }],
        v: 6,
        meta: { source: 'pub-AGENT', ts: 0, user_id: 'u1' },
      }))
      return [null]
    })

    await engine.writeDoc('d1', 'hello! world')
    expect(joinDocCalls).toBe(2)
    expect(applyCalls).toBe(2)
    expect(engine.readDoc('d1')).toBe('hello! world')
  })

  it('throws OtVersionConflictError when the second attempt also fails', async () => {
    const { sock, engine } = await ready()
    sock.respondToEmit('joinDoc', () => [null, ['hello'], 4, []])
    await engine.joinDoc('d1')

    sock.respondToEmit('applyOtUpdate', () => [{ message: 'still conflicting' }])

    await expect(engine.writeDoc('d1', 'hello world')).rejects.toBeInstanceOf(OtVersionConflictError)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Expected: FAIL — first test times out (no resync), second test rejects with the wrong error type.

- [ ] **Step 3: Wrap applyOps with resync logic**

In `src/overleaf/ot.ts`, replace the `applyOps` method body:

```typescript
  async applyOps(docId: string, ops: OtOp[]): Promise<void> {
    return this.applyOpsWithResync(docId, ops, /* attemptsLeft */ 1)
  }

  private async applyOpsWithResync(docId: string, ops: OtOp[], attemptsLeft: number): Promise<void> {
    let baseline = this.getBaseline(docId)
    if (!baseline) baseline = await this.joinDoc(docId)
    this.ensureOtUpdateAppliedListener()

    const update = { doc: docId, op: ops, v: baseline.version }

    const echoPromise = new Promise<void>((resolve) => {
      let arr = this.pendingEchoes.get(docId)
      if (!arr) this.pendingEchoes.set(docId, arr = [])
      arr.push(resolve)
    })

    try {
      await this.socket.emitWithAck('applyOtUpdate', docId, update)
    } catch (err) {
      // Cancel the pending echo waiter (the server won't echo on error).
      this.cancelPendingEcho(docId)
      if (isVersionMismatch(err) && attemptsLeft > 0) {
        // Resync: drop baseline, re-joinDoc, recompute ops, retry.
        this.clearBaseline(docId)
        const fresh = await this.joinDoc(docId)
        // Recompute ops against the new text. The original ops were authored
        // against an older baseline, so we re-derive what the agent intended:
        // apply old ops to the OLD baseline text to get the desired final
        // text, then diff THAT against the new baseline.
        const oldText = applyOpsLocal(baseline.text, ops)
        const recomputedOps = computeOpsLocal(fresh.text, oldText)
        if (recomputedOps.length === 0) return
        return this.applyOpsWithResync(docId, recomputedOps, attemptsLeft - 1)
      }
      if (isVersionMismatch(err)) {
        throw new OtVersionConflictError(
          `Doc ${docId} kept conflicting after resync`,
          { docId, baselineVersion: baseline.version },
        )
      }
      throw err instanceof Error ? err : new OverleafError('OVERLEAF_GENERIC', String(err))
    }

    await echoPromise

    const stillBaseline = this.getBaseline(docId)
    if (stillBaseline) {
      stillBaseline.text = applyOpsLocal(stillBaseline.text, ops)
      stillBaseline.version = baseline.version + 1
    }
  }

  private cancelPendingEcho(docId: string): void {
    const arr = this.pendingEchoes.get(docId)
    if (!arr || arr.length === 0) return
    arr.shift() // resolve nothing — the awaiting promise will be GC'd by the throw path
  }
```

Add the imports/helpers at the top + bottom of the file:

```typescript
import { computeOps as computeOpsLocal } from './diff.js'  // already imported as computeOps in Task 8 — just re-alias if needed
import { OtVersionConflictError } from '../errors.js'
```

(If you already imported `computeOps` from Task 8, just reference it as `computeOps`. The alias here is for clarity in the resync recompute step — feel free to use the same name.)

Add a small helper at the bottom of the file:

```typescript
function isVersionMismatch(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown; name?: unknown }
  if (typeof e.code === 'string' && /version|OutOfSync/i.test(e.code)) return true
  if (typeof e.message === 'string' && /version|out.of.sync/i.test(e.message)) return true
  return false
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/ot.resync.test.ts
```

Expected: PASS — 2 tests.

- [ ] **Step 5: Run full suite + typecheck**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; 73/73.

- [ ] **Step 6: Commit**

```bash
git add src/overleaf/ot.ts test/unit/ot.resync.test.ts
git commit -m "feat(overleaf/ot): version-conflict resync (re-joinDoc + retry once)"
```

---

## Task 10: OtEngine — tree event handlers

Subscribe to `reciveNewDoc`, `reciveNewFile`, `reciveNewFolder`, `reciveEntityRename`, `reciveEntityMove`, `removeEntity`. Update the in-memory tree state and rebuild the path index so `read_doc` / `read_file` / `get_project_tree` see live changes from other clients.

**Misspelled event names are canonical upstream — do not "fix" them.**

**Files:**
- Modify: `src/overleaf/ot.ts`
- Create: `test/unit/ot.tree-events.test.ts`

- [ ] **Step 1: Write the failing test**

Path: `test/unit/ot.tree-events.test.ts`

```typescript
import { describe, it, expect } from 'vitest'
import { OtEngine } from '../../src/overleaf/ot.js'
import { FakeSocket } from './fake-socket.js'
import type { JoinProjectResponse } from '../../src/overleaf/ot.types.js'

const join = (): JoinProjectResponse => ({
  project: {
    _id: 'p1',
    name: 'Test',
    rootDoc_id: 'd1',
    rootFolder: [
      {
        _id: 'root',
        name: 'rootFolder',
        docs: [{ _id: 'd1', name: 'main.tex' }],
        fileRefs: [{ _id: 'f1', name: 'figure.png' }],
        folders: [
          { _id: 'subA', name: 'subA', docs: [], fileRefs: [], folders: [] },
        ],
      },
    ],
  },
  permissionsLevel: 'owner',
  protocolVersion: 2,
  publicId: 'pub',
})

async function ready() {
  const sock = new FakeSocket()
  const engine = new OtEngine({ socket: sock, projectId: 'p1' })
  const cp = engine.connect()
  sock.simulate('connectionAccepted', null, 'pub')
  sock.simulate('joinProjectResponse', join())
  await cp
  return { sock, engine }
}

describe('OtEngine tree events', () => {
  it('reciveNewDoc adds a new doc under the parent folder', async () => {
    const { sock, engine } = await ready()
    sock.simulate('reciveNewDoc', 'root', { _id: 'd2', name: 'extra.tex' })
    expect(engine.pathToDocId('extra.tex')).toBe('d2')
    expect(engine.getTree().files.sort()).toEqual(['extra.tex', 'figure.png', 'main.tex'])
  })

  it('reciveNewFile adds a new fileRef', async () => {
    const { sock, engine } = await ready()
    sock.simulate('reciveNewFile', 'root', { _id: 'f2', name: 'logo.svg' })
    expect(engine.pathToFileId('logo.svg')).toBe('f2')
  })

  it('reciveNewFolder adds an empty folder', async () => {
    const { sock, engine } = await ready()
    sock.simulate('reciveNewFolder', 'root', { _id: 'subB', name: 'subB', docs: [], fileRefs: [], folders: [] })
    expect(Object.keys(engine.getTree().folders).sort()).toEqual(['subA', 'subB'])
  })

  it('reciveEntityRename renames a doc and re-indexes the path', async () => {
    const { sock, engine } = await ready()
    sock.simulate('reciveEntityRename', 'd1', 'main-renamed.tex')
    expect(engine.pathToDocId('main.tex')).toBeNull()
    expect(engine.pathToDocId('main-renamed.tex')).toBe('d1')
  })

  it('reciveEntityMove moves a doc to a new parent folder', async () => {
    const { sock, engine } = await ready()
    sock.simulate('reciveEntityMove', 'd1', 'subA')
    expect(engine.pathToDocId('main.tex')).toBeNull()
    expect(engine.pathToDocId('subA/main.tex')).toBe('d1')
  })

  it('removeEntity drops the doc from the index and tree', async () => {
    const { sock, engine } = await ready()
    sock.simulate('removeEntity', 'd1')
    expect(engine.pathToDocId('main.tex')).toBeNull()
    expect(engine.getTree().files).toEqual(['figure.png'])
  })

  it('removeEntity also clears the cached baseline', async () => {
    const { sock, engine } = await ready()
    sock.respondToEmit('joinDoc', () => [null, ['hello'], 0, []])
    await engine.joinDoc('d1')
    expect(engine.readDoc('d1')).toBe('hello')

    sock.simulate('removeEntity', 'd1')
    expect(engine.readDoc('d1')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Expected: FAIL — events have no handlers; assertions on `pathToDocId` etc. fail.

- [ ] **Step 3: Wire tree event handlers into connect()**

In `src/overleaf/ot.ts`, extend the `connect()` method to install the tree event listeners just before resolving:

```typescript
  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let gotPublicId = false
      let gotProject = false
      const finishIfReady = () => {
        if (gotPublicId && gotProject) {
          this.installTreeEventHandlers()
          this._isConnected = true
          resolve()
        }
      }
      // ... existing onConnAccepted / onJoinResponse / onConnRejected setup ...
    })
  }
```

(Keep the rest of `connect()` body the same; just call `this.installTreeEventHandlers()` inside `finishIfReady` before setting `_isConnected = true`.)

Add the handler-install method to `OtEngine`:

```typescript
  private installTreeEventHandlers(): void {
    this.installListener('reciveNewDoc', (parentFolderId: unknown, doc: unknown) =>
      this.applyNewEntity(parentFolderId as string, doc as DocEntity, 'doc'),
    )
    this.installListener('reciveNewFile', (parentFolderId: unknown, file: unknown) =>
      this.applyNewEntity(parentFolderId as string, file as FileRefEntity, 'file'),
    )
    this.installListener('reciveNewFolder', (parentFolderId: unknown, folder: unknown) =>
      this.applyNewEntity(parentFolderId as string, folder as FolderEntity, 'folder'),
    )
    this.installListener('reciveEntityRename', (entityId: unknown, newName: unknown) =>
      this.applyRename(entityId as string, newName as string),
    )
    this.installListener('reciveEntityMove', (entityId: unknown, newParentId: unknown) =>
      this.applyMove(entityId as string, newParentId as string),
    )
    this.installListener('removeEntity', (entityId: unknown) =>
      this.applyRemove(entityId as string),
    )
  }

  private applyNewEntity(
    parentFolderId: string,
    entity: DocEntity | FileRefEntity | FolderEntity,
    kind: 'doc' | 'file' | 'folder',
  ): void {
    const project = this.getProject()
    if (!project) return
    const parent = findFolder(project.rootFolder[0]!, parentFolderId)
    if (!parent) return
    if (kind === 'doc') parent.docs.push(entity as DocEntity)
    else if (kind === 'file') parent.fileRefs.push(entity as FileRefEntity)
    else parent.folders.push(entity as FolderEntity)
    this.rebuildPathIndex()
  }

  private applyRename(entityId: string, newName: string): void {
    const project = this.getProject()
    if (!project) return
    const found = findEntity(project.rootFolder[0]!, entityId)
    if (!found) return
    found.entity.name = newName
    this.rebuildPathIndex()
  }

  private applyMove(entityId: string, newParentId: string): void {
    const project = this.getProject()
    if (!project) return
    const target = findEntity(project.rootFolder[0]!, entityId)
    const newParent = findFolder(project.rootFolder[0]!, newParentId)
    if (!target || !newParent) return
    // Remove from old parent
    const arr = this.containerArray(target.parent, target.kind)
    const idx = arr.findIndex((e) => e._id === entityId)
    if (idx >= 0) arr.splice(idx, 1)
    // Add to new parent
    const newArr = this.containerArray(newParent, target.kind)
    newArr.push(target.entity as never)
    this.rebuildPathIndex()
  }

  private applyRemove(entityId: string): void {
    const project = this.getProject()
    if (!project) return
    const found = findEntity(project.rootFolder[0]!, entityId)
    if (!found) return
    const arr = this.containerArray(found.parent, found.kind)
    const idx = arr.findIndex((e) => e._id === entityId)
    if (idx >= 0) arr.splice(idx, 1)
    this.rebuildPathIndex()
    // Drop any cached baseline for this doc
    this.clearBaseline(entityId)
  }

  private containerArray(folder: FolderEntity, kind: 'doc' | 'file' | 'folder'): Array<{ _id: string; name: string }> {
    if (kind === 'doc') return folder.docs
    if (kind === 'file') return folder.fileRefs
    return folder.folders as unknown as Array<{ _id: string; name: string }>
  }
```

Add these helpers at the bottom of `src/overleaf/ot.ts` (after `decodeLatin1Lines` and `applyOpsLocal`):

```typescript
type EntityKind = 'doc' | 'file' | 'folder'
interface FoundEntity {
  entity: DocEntity | FileRefEntity | FolderEntity
  parent: FolderEntity
  kind: EntityKind
}

function findEntity(folder: FolderEntity, id: string): FoundEntity | null {
  for (const d of folder.docs) if (d._id === id) return { entity: d, parent: folder, kind: 'doc' }
  for (const f of folder.fileRefs) if (f._id === id) return { entity: f, parent: folder, kind: 'file' }
  for (const sub of folder.folders) {
    if (sub._id === id) return { entity: sub, parent: folder, kind: 'folder' }
    const inner = findEntity(sub, id)
    if (inner) return inner
  }
  return null
}

function findFolder(folder: FolderEntity, id: string): FolderEntity | null {
  if (folder._id === id) return folder
  for (const sub of folder.folders) {
    const inner = findFolder(sub, id)
    if (inner) return inner
  }
  return null
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/ot.tree-events.test.ts
```

Expected: PASS — 7 tests.

- [ ] **Step 5: Run full suite + typecheck**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; 80/80.

- [ ] **Step 6: Commit**

```bash
git add src/overleaf/ot.ts test/unit/ot.tree-events.test.ts
git commit -m "feat(overleaf/ot): tree event handlers (recive* + removeEntity)"
```

---

## Task 11: OtEngine — reconnect / forceDisconnect

Spec § "Connection lifecycle":
> 5. Persist the connection for the MCP server's lifetime. On `forceDisconnect` or network drop, reconnect with exponential backoff. On `reconnectGracefully`, follow the v1↔v2 handshake fallback Workshop already implements.

For v0.2 we implement the simpler half: reconnect-with-backoff on `forceDisconnect` and on raw `disconnect`. The v1↔v2 fallback (Workshop's `ConnectionScheme = 'Alt' | 'v1' | 'v2'`) is deferred — we always use the v2 scheme since CE 5.x supports it.

The reconnect rebuilds the OverleafSocket (new socket.io connection) and re-runs `connect()`. Cached baselines and tree state are dropped — clients should be ready to re-fetch.

**Files:**
- Modify: `src/overleaf/ot.ts`
- Create: `test/unit/ot.reconnect.test.ts`

- [ ] **Step 1: Write the failing test**

Path: `test/unit/ot.reconnect.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest'
import { OtEngine } from '../../src/overleaf/ot.js'
import { FakeSocket } from './fake-socket.js'
import type { JoinProjectResponse } from '../../src/overleaf/ot.types.js'

const join = (): JoinProjectResponse => ({
  project: {
    _id: 'p1', name: 'Test', rootDoc_id: 'd1',
    rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [{ _id: 'd1', name: 'main.tex' }], fileRefs: [], folders: [] }],
  },
  permissionsLevel: 'owner', protocolVersion: 2, publicId: 'pub',
})

describe('OtEngine reconnect', () => {
  it('on forceDisconnect, calls socketFactory and re-runs connect()', async () => {
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
      reconnectInitialDelayMs: 1,
    })
    const cp = engine.connect()
    sockets[0]!.simulate('connectionAccepted', null, 'pub')
    sockets[0]!.simulate('joinProjectResponse', join())
    await cp

    // forceDisconnect from server
    sockets[0]!.simulate('forceDisconnect', 'maintenance')

    // Engine should call factory again and emit a fresh joinProjectResponse handshake
    await new Promise((r) => setTimeout(r, 30))
    expect(factory).toHaveBeenCalledTimes(2)
    sockets[1]!.simulate('connectionAccepted', null, 'pub')
    sockets[1]!.simulate('joinProjectResponse', join())
    await new Promise((r) => setTimeout(r, 5))
    expect(engine.isConnected).toBe(true)
  })

  it('drops baselines on reconnect (clients must re-joinDoc)', async () => {
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
      reconnectInitialDelayMs: 1,
    })
    const cp = engine.connect()
    sockets[0]!.simulate('connectionAccepted', null, 'pub')
    sockets[0]!.simulate('joinProjectResponse', join())
    await cp
    sockets[0]!.respondToEmit('joinDoc', () => [null, ['hello'], 0, []])
    await engine.joinDoc('d1')
    expect(engine.readDoc('d1')).toBe('hello')

    sockets[0]!.simulate('forceDisconnect', 'kick')
    await new Promise((r) => setTimeout(r, 30))
    sockets[1]!.simulate('connectionAccepted', null, 'pub')
    sockets[1]!.simulate('joinProjectResponse', join())
    await new Promise((r) => setTimeout(r, 5))

    expect(engine.readDoc('d1')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Expected: FAIL — `socketFactory` and `reconnectInitialDelayMs` aren't accepted by the constructor; the engine doesn't react to forceDisconnect.

- [ ] **Step 3: Add socket-factory + reconnect logic**

Update `OtEngineOptions` in `src/overleaf/ot.ts`:

```typescript
export interface OtEngineOptions {
  socket: SocketLike
  projectId: string
  /** Called on reconnect to obtain a fresh socket. If omitted, reconnect is disabled. */
  socketFactory?: () => SocketLike
  /** Initial backoff delay in ms (default 500). Doubles each attempt up to 30s. */
  reconnectInitialDelayMs?: number
  /** Max attempts before giving up (default 10). */
  reconnectMaxAttempts?: number
}
```

Add private fields:

```typescript
  private currentSocket: SocketLike
  private readonly socketFactory: (() => SocketLike) | null
  private readonly reconnectInitialDelayMs: number
  private readonly reconnectMaxAttempts: number
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
```

Adjust the constructor to capture them and use `this.currentSocket` everywhere instead of the readonly `socket`:

```typescript
  constructor(opts: OtEngineOptions) {
    this.currentSocket = opts.socket
    this.projectId = opts.projectId
    this.socketFactory = opts.socketFactory ?? null
    this.reconnectInitialDelayMs = opts.reconnectInitialDelayMs ?? 500
    this.reconnectMaxAttempts = opts.reconnectMaxAttempts ?? 10
  }
```

(Search-and-replace `this.socket` → `this.currentSocket` in the rest of the file.)

Inside `connect()`, also install a `forceDisconnect` listener:

```typescript
      const onForceDisconnect = (..._args: unknown[]): void => {
        this.scheduleReconnect()
      }
      this.installListener('forceDisconnect', onForceDisconnect)
```

(Place this alongside the other handler installations in `connect()`.)

Add reconnect methods:

```typescript
  private scheduleReconnect(): void {
    if (!this.socketFactory) return
    if (this.reconnectTimer) return // already scheduled
    if (this.reconnectAttempt >= this.reconnectMaxAttempts) {
      this._isConnected = false
      return
    }

    // Drop old state
    this._isConnected = false
    this.baselines.clear()
    this.inflightJoinDoc.clear()
    this.pendingEchoes.clear()
    for (const { event, handler } of this.installedHandlers) {
      this.currentSocket.off(event, handler)
    }
    this.installedHandlers = []
    try { this.currentSocket.disconnect() } catch { /* old socket may already be torn down */ }

    const delay = Math.min(
      this.reconnectInitialDelayMs * 2 ** this.reconnectAttempt,
      30_000,
    )
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.currentSocket = this.socketFactory!()
      this.otUpdateAppliedHandlerInstalled = false
      void this.connect().then(
        () => { this.reconnectAttempt = 0 },
        () => this.scheduleReconnect(),
      )
    }, delay)
  }
```

Update `disconnect()` to also clear the reconnect timer:

```typescript
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    for (const { event, handler } of this.installedHandlers) {
      this.currentSocket.off(event, handler)
    }
    this.installedHandlers = []
    this._isConnected = false
    this.currentSocket.disconnect()
  }
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/ot.reconnect.test.ts
```

Expected: PASS — 2 tests.

- [ ] **Step 5: Run full suite + typecheck**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; 82/82.

- [ ] **Step 6: Commit**

```bash
git add src/overleaf/ot.ts test/unit/ot.reconnect.test.ts
git commit -m "feat(overleaf/ot): reconnect with exponential backoff on forceDisconnect"
```

---

## Task 12: OtEngineRegistry

One `OtEngine` per project, lifecycle managed by a registry. Lazy-creates on first `get(projectId)`, caches for the MCP server's lifetime, exposes `closeAll()` for shutdown.

**Files:**
- Modify: `src/overleaf/ot.ts` (add the registry class — cohesive with the engine)
- Create: `test/unit/ot.registry.test.ts`

- [ ] **Step 1: Write the failing test**

Path: `test/unit/ot.registry.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest'
import { OtEngineRegistry, type OtEngineFactory } from '../../src/overleaf/ot.js'
import { FakeSocket } from './fake-socket.js'
import type { JoinProjectResponse } from '../../src/overleaf/ot.types.js'

const join = (id: string): JoinProjectResponse => ({
  project: {
    _id: id, name: id, rootDoc_id: 'd', rootFolder: [{ _id: 'r', name: 'rootFolder', docs: [], fileRefs: [], folders: [] }],
  },
  permissionsLevel: 'owner', protocolVersion: 2, publicId: 'pub',
})

describe('OtEngineRegistry', () => {
  it('lazy-creates one engine per projectId, caches for subsequent gets', async () => {
    let createdSocks = 0
    const factory: OtEngineFactory = (projectId) => {
      createdSocks += 1
      const sock = new FakeSocket()
      // Auto-deliver handshake on construction
      queueMicrotask(() => {
        sock.simulate('connectionAccepted', null, 'pub')
        sock.simulate('joinProjectResponse', join(projectId))
      })
      return { socket: sock }
    }
    const reg = new OtEngineRegistry(factory)
    const a = await reg.get('p1')
    const b = await reg.get('p1')
    expect(a).toBe(b)
    expect(createdSocks).toBe(1)
  })

  it('separate projectIds get separate engines', async () => {
    const factory: OtEngineFactory = (projectId) => {
      const sock = new FakeSocket()
      queueMicrotask(() => {
        sock.simulate('connectionAccepted', null, 'pub')
        sock.simulate('joinProjectResponse', join(projectId))
      })
      return { socket: sock }
    }
    const reg = new OtEngineRegistry(factory)
    const a = await reg.get('p1')
    const b = await reg.get('p2')
    expect(a).not.toBe(b)
    expect(a.projectId).toBe('p1')
    expect(b.projectId).toBe('p2')
  })

  it('coalesces concurrent gets for the same projectId', async () => {
    let createdSocks = 0
    const factory: OtEngineFactory = (projectId) => {
      createdSocks += 1
      const sock = new FakeSocket()
      queueMicrotask(() => {
        sock.simulate('connectionAccepted', null, 'pub')
        sock.simulate('joinProjectResponse', join(projectId))
      })
      return { socket: sock }
    }
    const reg = new OtEngineRegistry(factory)
    const [a, b] = await Promise.all([reg.get('p1'), reg.get('p1')])
    expect(a).toBe(b)
    expect(createdSocks).toBe(1)
  })

  it('closeAll() disconnects every engine', async () => {
    const socks: FakeSocket[] = []
    const factory: OtEngineFactory = (projectId) => {
      const sock = new FakeSocket()
      socks.push(sock)
      queueMicrotask(() => {
        sock.simulate('connectionAccepted', null, 'pub')
        sock.simulate('joinProjectResponse', join(projectId))
      })
      return { socket: sock }
    }
    const reg = new OtEngineRegistry(factory)
    await reg.get('p1')
    await reg.get('p2')
    await reg.closeAll()
    expect(socks.every((s) => s.disconnected)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Expected: FAIL — `OtEngineRegistry` not exported.

- [ ] **Step 3: Add the registry**

Append to `src/overleaf/ot.ts`:

```typescript
/**
 * Function the registry calls to mint a new socket (and optionally a
 * socketFactory for reconnect) for a given projectId. Returns the inputs
 * `OtEngine` needs at construction time minus the projectId.
 */
export type OtEngineFactory = (projectId: string) => {
  socket: SocketLike
  socketFactory?: () => SocketLike
  reconnectInitialDelayMs?: number
  reconnectMaxAttempts?: number
}

export class OtEngineRegistry {
  private engines = new Map<string, OtEngine>()
  private inflight = new Map<string, Promise<OtEngine>>()

  constructor(private readonly factory: OtEngineFactory) {}

  async get(projectId: string): Promise<OtEngine> {
    const cached = this.engines.get(projectId)
    if (cached) return cached
    const inflight = this.inflight.get(projectId)
    if (inflight) return inflight

    const promise = (async () => {
      const inputs = this.factory(projectId)
      const engine = new OtEngine({ projectId, ...inputs })
      try {
        await engine.connect()
        this.engines.set(projectId, engine)
        return engine
      } finally {
        this.inflight.delete(projectId)
      }
    })()
    this.inflight.set(projectId, promise)
    return promise
  }

  /** Disconnect and drop every engine. */
  async closeAll(): Promise<void> {
    for (const engine of this.engines.values()) engine.disconnect()
    this.engines.clear()
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/ot.registry.test.ts
```

Expected: PASS — 4 tests.

- [ ] **Step 5: Run full suite + typecheck**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; 86/86.

- [ ] **Step 6: Commit**

```bash
git add src/overleaf/ot.ts test/unit/ot.registry.test.ts
git commit -m "feat(overleaf/ot): per-project OtEngineRegistry"
```

---

## Task 13: Wire OtEngineRegistry into ServerContext

`ServerContext.cache` (`ProjectCache`) gets replaced by `ServerContext.ot` (`OtEngineRegistry`). The factory inside `buildContext` constructs an `OverleafSocket` per project using the configured URL, cookie, and extra headers.

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `test/unit/mcp-tools.test.ts` (update the `buildContext` use to match the new shape — but defer the read_doc / get_project_tree migrations to Tasks 14–15)

To keep this task small, we keep `ServerContext.cache` alongside `.ot` for now. Tasks 14–15 will switch the read tools over and Task 19 will remove `.cache`.

- [ ] **Step 1: Update ServerContext type and buildContext**

In `src/mcp/server.ts`, add the imports:

```typescript
import { OverleafSocket } from '../overleaf/socket.js'
import { OtEngineRegistry, type OtEngineFactory } from '../overleaf/ot.js'
```

Extend `ServerContext`:

```typescript
export interface ServerContext {
  http: OverleafHttp
  rest: OverleafRest
  cache: ProjectCache  // v0.1 — retire in Task 19
  ot: OtEngineRegistry // v0.2
}
```

Inside `buildContext`, after the `cache` is built, add the OT registry:

```typescript
  const otFactory: OtEngineFactory = (projectId) => {
    const makeSocket = () => new OverleafSocket({
      url: opts.url,
      projectId,
      sessionCookie: opts.sessionCookie,
      extraHeaders: opts.extraHeaders,
    })
    return {
      socket: makeSocket(),
      socketFactory: makeSocket,
    }
  }
  const ot = new OtEngineRegistry(otFactory)

  return { http, rest, cache, ot }
```

- [ ] **Step 2: Verify mcp-tools.test.ts still passes**

The existing tests use `buildContext({...})` and don't assert on the `.ot` field, so they should still pass.

```bash
npm test -- test/unit/mcp-tools.test.ts
```

Expected: PASS — 7 tests still green.

- [ ] **Step 3: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; 86/86.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/server.ts
git commit -m "feat(mcp): add OtEngineRegistry to ServerContext (alongside v0.1 cache)"
```

---

## Task 14: Migrate `read_doc` to OT-backed

`handleReadDoc` now does: `await ctx.ot.get(projectId)` → `engine.pathToDocId(path)` → if null, throw NotFound → `await engine.joinDoc(docId)` → return `{ content: baseline.text }`.

**Files:**
- Modify: `src/mcp/tools/docs.ts`
- Modify: `test/unit/mcp-tools.test.ts` (rewrite the `read_doc tool` describe to use the OT mocking pattern)

- [ ] **Step 1: Update the read_doc test**

In `test/unit/mcp-tools.test.ts`, replace the existing `describe('read_doc tool', ...)` block with an OT-mocked version. Add a small fake at the top of the file (alongside other test helpers):

```typescript
import { OtEngine } from '../../src/overleaf/ot.js'
import { FakeSocket } from './fake-socket.js'
import type { JoinProjectResponse } from '../../src/overleaf/ot.types.js'

function buildOtTestCtx() {
  const sock = new FakeSocket()
  const factory = vi.fn(() => sock)
  const ctx = buildContext({
    url: 'https://o.example',
    sessionCookie: 'overleaf_session2=abc',
    extraHeaders: {},
    debug: false,
    csrfToken: 'csrf',
  })
  // Override the OT factory to inject our FakeSocket
  ;(ctx as unknown as { ot: { get: (p: string) => Promise<OtEngine> } }).ot = {
    async get(projectId: string) {
      const engine = new OtEngine({ socket: sock, projectId })
      const cp = engine.connect()
      sock.simulate('connectionAccepted', null, 'pub-AGENT')
      sock.simulate('joinProjectResponse', minimalJoinResponse(projectId))
      await cp
      return engine
    },
  }
  return { ctx, sock }
}

function minimalJoinResponse(projectId: string): JoinProjectResponse {
  return {
    project: {
      _id: projectId, name: projectId, rootDoc_id: 'd-main',
      rootFolder: [{
        _id: 'root', name: 'rootFolder',
        docs: [{ _id: 'd-main', name: 'main.tex' }],
        fileRefs: [{ _id: 'f-img', name: 'figures.png' }],
        folders: [],
      }],
    },
    permissionsLevel: 'owner', protocolVersion: 2, publicId: 'pub-AGENT',
  }
}
```

(Add `import { vi } from 'vitest'` to the existing imports if it isn't already there.)

Replace the existing `describe('read_doc tool', ...)`:

```typescript
describe('read_doc tool (OT-backed)', () => {
  it('returns text content via joinDoc', async () => {
    const { ctx, sock } = buildOtTestCtx()
    sock.respondToEmit('joinDoc', () => [null, ['\\documentclass{article}\n', 'Hello.'], 7, []])
    const out = await handleReadDoc(ctx, { projectId: 'p2', path: 'main.tex' })
    expect(out.content).toContain('\\documentclass')
  })

  it('throws NotFoundError when path is not in tree', async () => {
    const { ctx } = buildOtTestCtx()
    await expect(handleReadDoc(ctx, { projectId: 'p2', path: 'missing.tex' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- test/unit/mcp-tools.test.ts
```

Expected: FAIL — `handleReadDoc` still uses `ctx.cache.get(projectId).readDoc(path)`, not the OT engine.

- [ ] **Step 3: Migrate handleReadDoc**

In `src/mcp/tools/docs.ts`, replace the body of `handleReadDoc`:

```typescript
export async function handleReadDoc(
  ctx: ServerContext,
  input: { projectId: string; path: string },
): Promise<{ content: string }> {
  const engine = await ctx.ot.get(input.projectId)
  const docId = engine.pathToDocId(input.path)
  if (docId === null) {
    throw new NotFoundError(`No doc at ${input.path} in project ${input.projectId}`)
  }
  const baseline = await engine.joinDoc(docId)
  return { content: baseline.text }
}
```

(The `handleReadFile` migration lands in Task 16.)

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/mcp-tools.test.ts
```

Expected: PASS — `read_doc tool (OT-backed)` describe is green; remaining tests (`read_file`, `compile`, etc.) still green.

- [ ] **Step 5: Run full suite + typecheck**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/docs.ts test/unit/mcp-tools.test.ts
git commit -m "feat(mcp): read_doc reads from live OT baseline"
```

---

## Task 15: Migrate `get_project_tree` to OT-backed

`handleGetProjectTree` now does: `await ctx.ot.get(projectId)` → `return { tree: engine.getTree() }`.

**Files:**
- Modify: `src/mcp/tools/projects.ts`
- Modify: `test/unit/mcp-tools.test.ts` (rewrite the `get_project_tree tool` describe)

- [ ] **Step 1: Update the get_project_tree test**

Replace the existing `describe('get_project_tree tool', ...)` in `test/unit/mcp-tools.test.ts`:

```typescript
describe('get_project_tree tool (OT-backed)', () => {
  it('returns the live tree from OT state', async () => {
    const { ctx } = buildOtTestCtx()
    const out = await handleGetProjectTree(ctx, { projectId: 'p1' })
    expect(out.tree.files.sort()).toEqual(['figures.png', 'main.tex'])
    expect(Object.keys(out.tree.folders)).toEqual([])
  })

  it('reflects mid-session tree mutations from other clients', async () => {
    const { ctx, sock } = buildOtTestCtx()
    // First get caches the engine
    const engine = await ctx.ot.get('p1')
    sock.simulate('reciveNewDoc', 'root', { _id: 'd2', name: 'extra.tex' })
    const out = await handleGetProjectTree(ctx, { projectId: 'p1' })
    expect(out.tree.files.sort()).toEqual(['extra.tex', 'figures.png', 'main.tex'])
    void engine
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- test/unit/mcp-tools.test.ts
```

Expected: FAIL — `handleGetProjectTree` still calls `ctx.cache.get(...)` and returns the zip-based tree.

- [ ] **Step 3: Migrate handleGetProjectTree**

In `src/mcp/tools/projects.ts`, replace `handleGetProjectTree`:

```typescript
import type { ServerContext } from '../server.js'
import type { TreeNode } from '../../overleaf/ot.js'

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
  const engine = await ctx.ot.get(input.projectId)
  return { tree: engine.getTree() }
}
```

(The old `TreeNode` was imported from `../../overleaf/tree.js`. Re-point the import at `../../overleaf/ot.js`. The shape is identical.)

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/mcp-tools.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full suite + typecheck**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/projects.ts test/unit/mcp-tools.test.ts
git commit -m "feat(mcp): get_project_tree reads from live OT state"
```

---

## Task 16: Migrate `read_file` to direct REST + add `write_doc`

Two related changes that share the same MCP tool file:

1. **`read_file`** previously read binary bytes from the zip cache. Now: `engine.pathToFileId(path)` → if null, throw NotFound → `await rest.downloadFile(projectId, fileId)` → return base64.

2. **`write_doc`** is brand-new. Adds `handleWriteDoc(ctx, { projectId, path, content })` → `engine.pathToDocId(path)` → if null, throw NotFound → `await engine.writeDoc(docId, content)` → return `{ ok: true }`.

**Files:**
- Modify: `src/mcp/tools/docs.ts` (migrate `handleReadFile`, add `handleWriteDoc`)
- Modify: `src/mcp/tools/index.ts` (register `write_doc`)
- Modify: `test/unit/mcp-tools.test.ts` (rewrite `read_file` describe; add `write_doc` describe)

- [ ] **Step 1: Update the read_file test + add write_doc test**

Replace the existing `describe('read_file tool', ...)` in `test/unit/mcp-tools.test.ts`:

```typescript
describe('read_file tool (REST-backed via OT tree)', () => {
  it('looks up fileId via OT tree and fetches via REST', async () => {
    const { ctx } = buildOtTestCtx()
    server.use(
      http.get('https://o.example/project/p1/file/f-img', () =>
        HttpResponse.arrayBuffer(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer), // PNG magic
      ),
    )
    const out = await handleReadFile(ctx, { projectId: 'p1', path: 'figures.png' })
    const decoded = Buffer.from(out.contentBase64, 'base64')
    expect(decoded[0]).toBe(0x89)
    expect(decoded[1]).toBe(0x50)
  })

  it('throws NotFoundError when path is not a binary in the tree', async () => {
    const { ctx } = buildOtTestCtx()
    await expect(
      handleReadFile(ctx, { projectId: 'p1', path: 'main.tex' }), // tex is a doc, not a file
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('write_doc tool (OT)', () => {
  it('emits applyOtUpdate and bumps baseline on successful echo', async () => {
    const { ctx, sock } = buildOtTestCtx()
    sock.respondToEmit('joinDoc', () => [null, ['hello'], 0, []])
    sock.respondToEmit('applyOtUpdate', () => {
      queueMicrotask(() => sock.simulate('otUpdateApplied', {
        doc: 'd-main',
        op: [{ p: 5, i: ' world' }],
        v: 0,
        meta: { source: 'pub-AGENT', ts: 0, user_id: 'u' },
      }))
      return [null]
    })

    const out = await handleWriteDoc(ctx, {
      projectId: 'p1',
      path: 'main.tex',
      content: 'hello world',
    })
    expect(out.ok).toBe(true)
    expect(sock.emitsOf('applyOtUpdate')).toHaveLength(1)
  })

  it('throws NotFoundError when path is not a doc', async () => {
    const { ctx } = buildOtTestCtx()
    await expect(
      handleWriteDoc(ctx, { projectId: 'p1', path: 'figures.png', content: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
```

Add the `handleWriteDoc` import alongside the others at the top of the test file:

```typescript
import { handleReadDoc, handleReadFile, handleWriteDoc } from '../../src/mcp/tools/docs.js'
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- test/unit/mcp-tools.test.ts
```

Expected: FAIL — `handleWriteDoc` not exported; `handleReadFile` still uses the zip cache.

- [ ] **Step 3: Migrate handleReadFile + add handleWriteDoc**

In `src/mcp/tools/docs.ts`, replace the file content:

```typescript
import type { ServerContext } from '../server.js'
import { NotFoundError } from '../../errors.js'

export async function handleReadDoc(
  ctx: ServerContext,
  input: { projectId: string; path: string },
): Promise<{ content: string }> {
  const engine = await ctx.ot.get(input.projectId)
  const docId = engine.pathToDocId(input.path)
  if (docId === null) {
    throw new NotFoundError(`No doc at ${input.path} in project ${input.projectId}`)
  }
  const baseline = await engine.joinDoc(docId)
  return { content: baseline.text }
}

export async function handleReadFile(
  ctx: ServerContext,
  input: { projectId: string; path: string },
): Promise<{ contentBase64: string }> {
  const engine = await ctx.ot.get(input.projectId)
  const fileId = engine.pathToFileId(input.path)
  if (fileId === null) {
    throw new NotFoundError(`No binary file at ${input.path} in project ${input.projectId}`)
  }
  const buf = await ctx.rest.downloadFile(input.projectId, fileId)
  return { contentBase64: buf.toString('base64') }
}

export async function handleWriteDoc(
  ctx: ServerContext,
  input: { projectId: string; path: string; content: string },
): Promise<{ ok: true }> {
  const engine = await ctx.ot.get(input.projectId)
  const docId = engine.pathToDocId(input.path)
  if (docId === null) {
    throw new NotFoundError(`No doc at ${input.path} in project ${input.projectId}`)
  }
  await engine.writeDoc(docId, input.content)
  return { ok: true }
}
```

Register `write_doc` in `src/mcp/tools/index.ts`. Add to the `TOOL_DEFINITIONS` array (after `read_file` so the read group stays together):

```typescript
  {
    name: 'write_doc',
    description: 'Replace a text doc by path within a project. Edits flow as live OT ops; no "file changed externally" toast.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['projectId', 'path', 'content'],
    },
  },
```

Add the import + dispatch case:

```typescript
import { handleReadDoc, handleReadFile, handleWriteDoc } from './docs.js'
```

In the `switch (name)` block, after the `read_file` case:

```typescript
        case 'write_doc':
          return wrap(
            await handleWriteDoc(
              ctx,
              args as { projectId: string; path: string; content: string },
            ),
          )
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/mcp-tools.test.ts
```

Expected: PASS — read_file, write_doc tests green.

- [ ] **Step 5: Run full suite + typecheck**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; suite green.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/docs.ts src/mcp/tools/index.ts test/unit/mcp-tools.test.ts
git commit -m "feat(mcp): write_doc via OT + read_file via direct REST (no zip cache)"
```

---

## Task 17: Add `apply_patch` MCP tool (raw OT ops)

Advanced tool — emits raw `[{p, i?, d?}]` ops at the current baseline version. Useful when the agent has an existing diff (e.g., a `git diff` it produced) it wants to apply verbatim instead of recomputing.

**Files:**
- Modify: `src/mcp/tools/docs.ts` (add `handleApplyPatch`)
- Modify: `src/mcp/tools/index.ts` (register `apply_patch`)
- Modify: `test/unit/mcp-tools.test.ts` (add `apply_patch` describe)

- [ ] **Step 1: Add the failing test**

Append to `test/unit/mcp-tools.test.ts`:

```typescript
describe('apply_patch tool (raw OT ops)', () => {
  it('emits applyOtUpdate with the user-provided ops', async () => {
    const { ctx, sock } = buildOtTestCtx()
    sock.respondToEmit('joinDoc', () => [null, ['hello'], 0, []])
    sock.respondToEmit('applyOtUpdate', () => {
      queueMicrotask(() => sock.simulate('otUpdateApplied', {
        doc: 'd-main',
        op: [{ p: 0, i: 'X' }],
        v: 0,
        meta: { source: 'pub-AGENT', ts: 0, user_id: 'u' },
      }))
      return [null]
    })

    const out = await handleApplyPatch(ctx, {
      projectId: 'p1',
      path: 'main.tex',
      ops: [{ p: 0, i: 'X' }],
    })
    expect(out.ok).toBe(true)
    const update = sock.emitsOf('applyOtUpdate')[0]!.args[1] as { op: unknown }
    expect(update.op).toEqual([{ p: 0, i: 'X' }])
  })

  it('rejects ops with invalid shape', async () => {
    const { ctx } = buildOtTestCtx()
    await expect(
      handleApplyPatch(ctx, {
        projectId: 'p1',
        path: 'main.tex',
        // missing both i and d:
        ops: [{ p: 0 }] as unknown as Array<{ p: number; i?: string; d?: string }>,
      }),
    ).rejects.toMatchObject({ code: 'OVERLEAF_GENERIC' })
  })
})
```

Add the import at the top:

```typescript
import { handleApplyPatch } from '../../src/mcp/tools/docs.js'
```

- [ ] **Step 2: Run the test, verify it fails**

Expected: FAIL — `handleApplyPatch` not exported.

- [ ] **Step 3: Add handleApplyPatch**

In `src/mcp/tools/docs.ts`, append:

```typescript
import { OverleafError } from '../../errors.js'
import type { OtOp } from '../../overleaf/diff.js'

export async function handleApplyPatch(
  ctx: ServerContext,
  input: { projectId: string; path: string; ops: OtOp[] },
): Promise<{ ok: true }> {
  // Validate op shape — each op must have exactly one of i or d.
  for (const op of input.ops) {
    if (typeof op.p !== 'number' || op.p < 0) {
      throw new OverleafError('OVERLEAF_GENERIC', 'Each op must have a numeric p ≥ 0')
    }
    const hasInsert = typeof op.i === 'string'
    const hasDelete = typeof op.d === 'string'
    if (hasInsert === hasDelete) {
      throw new OverleafError('OVERLEAF_GENERIC', 'Each op must have exactly one of i or d')
    }
  }

  const engine = await ctx.ot.get(input.projectId)
  const docId = engine.pathToDocId(input.path)
  if (docId === null) {
    throw new NotFoundError(`No doc at ${input.path} in project ${input.projectId}`)
  }
  await engine.applyOps(docId, input.ops)
  return { ok: true }
}
```

(Note: `engine.applyOps` is `protected` in Task 8/9. Promote it to `public` — change `protected` to `public` on the `applyOps` method in `src/overleaf/ot.ts`. The resync wrapper `applyOpsWithResync` stays private.)

Register `apply_patch` in `src/mcp/tools/index.ts`. Add to `TOOL_DEFINITIONS`:

```typescript
  {
    name: 'apply_patch',
    description: 'Advanced: emit raw OT ops [{p,i?,d?}] against a doc at its current version. Each op must have exactly one of `i` (insert) or `d` (delete). For most use cases prefer write_doc.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
        ops: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              p: { type: 'integer', minimum: 0 },
              i: { type: 'string' },
              d: { type: 'string' },
            },
            required: ['p'],
          },
        },
      },
      required: ['projectId', 'path', 'ops'],
    },
  },
```

Add the import + dispatch case in the same file:

```typescript
import { handleReadDoc, handleReadFile, handleWriteDoc, handleApplyPatch } from './docs.js'
```

```typescript
        case 'apply_patch':
          return wrap(
            await handleApplyPatch(
              ctx,
              args as { projectId: string; path: string; ops: Array<{ p: number; i?: string; d?: string }> },
            ),
          )
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/mcp-tools.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full suite + typecheck**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/docs.ts src/mcp/tools/index.ts src/overleaf/ot.ts test/unit/mcp-tools.test.ts
git commit -m "feat(mcp): apply_patch tool for raw OT ops"
```

---

## Task 18: Add `clientTracking` suppression assurance test

Spec § "Cursor presence":
> The server **never** emits `clientTracking.updatePosition`. The agent appears as a connected user (presence dot in the share panel) but with no visible cursor jumping around the editor.

We never call this internally, but a regression test pins the contract. Touch nothing in production code — just add an assertion that NO test path through OtEngine ever calls `socket.emit('clientTracking.updatePosition', ...)`.

**Files:**
- Modify: `test/unit/ot.write.test.ts`

- [ ] **Step 1: Append the assertion**

After the existing tests in `test/unit/ot.write.test.ts`, append:

```typescript
describe('OtEngine never emits clientTracking', () => {
  it('writeDoc + joinDoc + tree-event handling never emit clientTracking.updatePosition', async () => {
    const { sock, engine } = await readyEngine()
    sock.respondToEmit('applyOtUpdate', () => {
      queueMicrotask(() => sock.simulate('otUpdateApplied', {
        doc: 'd1',
        op: [{ p: 5, i: '!' }],
        v: 4,
        meta: { source: 'pub-AGENT', ts: 0, user_id: 'u' },
      }))
      return [null]
    })
    await engine.writeDoc('d1', 'hello!')
    sock.simulate('reciveNewDoc', 'root', { _id: 'd2', name: 'extra.tex' })

    expect(sock.emitsOf('clientTracking.updatePosition')).toHaveLength(0)
    expect(sock.emitsOf('clientTracking.getConnectedUsers')).toHaveLength(0)
  })
})
```

(`readyEngine` is defined at the top of `ot.write.test.ts` from Task 8.)

- [ ] **Step 2: Run the test**

```bash
npm test -- test/unit/ot.write.test.ts
```

Expected: PASS — 5 tests in this file.

- [ ] **Step 3: Run full suite + typecheck**

```bash
npm run typecheck && npm test
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add test/unit/ot.write.test.ts
git commit -m "test(overleaf/ot): pin no-cursor-presence contract"
```

---

## Task 19: Retire v0.1 zip-cache code

The OT engine now backs `read_doc`, `read_file`, `get_project_tree`. The zip-based path is dead code. Delete:

- `src/overleaf/zip.ts`
- `src/overleaf/tree.ts`
- `src/overleaf/cache.ts`
- `scripts/make-fixture-zip.mjs`
- `test/unit/cache.test.ts`
- `test/unit/rest.zip.test.ts`
- `test/unit/tree.test.ts`
- `test/fixtures/project.zip`

And:
- Remove `archiver` and `unzipper` deps (and `@types/unzipper`).
- Remove `make-fixtures` script.
- Remove `downloadProjectZip` from `src/overleaf/rest.ts` (no longer used) — and its test in `test/unit/rest.projects.test.ts`.
- Remove `ServerContext.cache` field from `src/mcp/server.ts`.
- Update `src/mcp/tools/compile.ts` — `compileAndCache` calls `ctx.cache.invalidate(projectId)`. After v0.2 this is unnecessary (OT keeps things live). Drop the cache invalidation.

**Files:** see above.

- [ ] **Step 1: Delete v0.1 zip/cache modules**

```bash
git rm src/overleaf/zip.ts src/overleaf/tree.ts src/overleaf/cache.ts scripts/make-fixture-zip.mjs
git rm test/unit/cache.test.ts test/unit/rest.zip.test.ts test/unit/tree.test.ts
git rm test/fixtures/project.zip
```

- [ ] **Step 2: Drop downloadProjectZip from rest.ts**

In `src/overleaf/rest.ts`, delete the `downloadProjectZip(projectId)` method (around lines 57–67 of the file). Run `grep -n downloadProjectZip src/` to confirm no remaining usages.

- [ ] **Step 3: Drop the zip download test**

In `test/unit/rest.projects.test.ts`, delete the bottom block:

```typescript
// (delete this whole describe + the import-readFileSync alias above it)
import { readFileSync as _read } from 'node:fs'
const projectZip = _read(join(FIXTURES, 'project.zip'))

describe('OverleafRest.downloadProjectZip', () => { ... })
```

That brings the file back to 3 tests covering only `listProjects`.

- [ ] **Step 4: Drop ServerContext.cache + update compile invalidation**

In `src/mcp/server.ts`:
- Remove `import { ProjectCache } from '../overleaf/cache.js'` and the `parseProjectZip` / `ProjectTree` imports.
- Remove the `cache` field from `ServerContext` and from `buildContext`'s return.
- Remove the entire cache construction block.

In `src/mcp/tools/compile.ts`, drop the line `ctx.cache.invalidate(projectId)` from `compileAndCache` (the helper now only translates the REST response shape — keep the function name for now; rename in a future refactor).

- [ ] **Step 5: Drop deps**

```bash
npm uninstall archiver unzipper @types/unzipper
```

In `package.json` `scripts`, delete `"make-fixtures": "node scripts/make-fixture-zip.mjs"`.

- [ ] **Step 6: Run typecheck + suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; full suite green (test count drops to ~80, depending on how many cache/zip/tree tests existed).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore(v0.2): retire v0.1 zip-cache machinery"
```

---

## Task 20: Live integration test against CE

Extend `test/integration/ce-fixture.test.ts` with an OT-write E2E. Same gating (`RUN_INTEGRATION=1`, `TEST_OVERLEAF_*` env vars).

**Files:**
- Modify: `test/integration/ce-fixture.test.ts`

- [ ] **Step 1: Add the OT write test alongside the existing one**

Replace the file with:

```typescript
import { describe, it, expect } from 'vitest'
import { OverleafHttp } from '../../src/overleaf/http.js'
import { OverleafRest } from '../../src/overleaf/rest.js'
import { OverleafSocket } from '../../src/overleaf/socket.js'
import { OtEngine } from '../../src/overleaf/ot.js'
import { passportLogin } from '../../src/overleaf/auth.js'

const URL = process.env.TEST_OVERLEAF_URL ?? 'http://localhost:8080'
const EMAIL = process.env.TEST_OVERLEAF_EMAIL ?? 'user@test.local'
const PASSWORD = process.env.TEST_OVERLEAF_PASSWORD ?? 'password'

const skip = process.env.RUN_INTEGRATION !== '1'

describe.skipIf(skip)('overleaf-mcp against live CE', () => {
  it('lists, downloads zip(?), compiles via REST', async () => {
    const id = await passportLogin({ url: URL, email: EMAIL, password: PASSWORD, extraHeaders: {} })
    const http = new OverleafHttp({ url: URL, sessionCookie: id.sessionCookie, csrfToken: id.csrfToken, extraHeaders: {} })
    const rest = new OverleafRest(http)
    const projects = await rest.listProjects()
    expect(projects.length).toBeGreaterThan(0)
    const projectId = projects[0]!.id
    const compileRes = await rest.compile(projectId)
    expect(['success', 'failure']).toContain(compileRes.status)
  }, 60_000)

  it('OT: read main.tex baseline, write back with a marker comment, verify roundtrip', async () => {
    const id = await passportLogin({ url: URL, email: EMAIL, password: PASSWORD, extraHeaders: {} })
    const http = new OverleafHttp({ url: URL, sessionCookie: id.sessionCookie, csrfToken: id.csrfToken, extraHeaders: {} })
    const rest = new OverleafRest(http)
    const projects = await rest.listProjects()
    expect(projects.length).toBeGreaterThan(0)
    const projectId = projects[0]!.id

    const sock = new OverleafSocket({
      url: URL,
      projectId,
      sessionCookie: id.sessionCookie,
      extraHeaders: {},
    })
    const engine = new OtEngine({ socket: sock, projectId })
    await engine.connect()

    const docId = engine.pathToDocId('main.tex')
    expect(docId, 'project must contain main.tex at root').not.toBeNull()
    const before = (await engine.joinDoc(docId!)).text

    const marker = `% overleaf-mcp v0.2 OT smoke @ ${new Date().toISOString()}\n`
    const after = before.startsWith('% overleaf-mcp')
      ? before.replace(/^% overleaf-mcp.*\n/, marker)
      : marker + before

    await engine.writeDoc(docId!, after)

    // Force a fresh joinDoc on a new connection to verify the server stored it.
    const sock2 = new OverleafSocket({ url: URL, projectId, sessionCookie: id.sessionCookie, extraHeaders: {} })
    const engine2 = new OtEngine({ socket: sock2, projectId })
    await engine2.connect()
    const reread = (await engine2.joinDoc(docId!)).text

    expect(reread).toBe(after)
    engine.disconnect()
    engine2.disconnect()
  }, 60_000)
})
```

- [ ] **Step 2: Verify the gate still skips by default**

```bash
npx vitest run --config vitest.integration.config.ts
```

Expected: 1 skipped file, 0 tests run, no network.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 4: (Optional, manual) Run against the live CE**

```bash
# Credentials live in .env.integration (gitignored). See .env.integration.example.
set -a; source .env.integration; set +a
RUN_INTEGRATION=1 npm run test:integration
```

Expected: both tests PASS. The OT test mutates `main.tex` in the user's `Test Project` — make sure that's OK before running.

- [ ] **Step 5: Commit**

```bash
git add test/integration/ce-fixture.test.ts
git commit -m "test(integration): add OT write roundtrip against live CE"
```

---

## Task 21: README + spec status update

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-04-25-overleaf-mcp-design.md` (status update only — do not change design)

- [ ] **Step 1: Update README's intro and Tools table**

In `README.md`, change the v0.1 intro line:

Before:
```markdown
This is **v0.1: read-only**. Future versions will add writes via Overleaf's native realtime OT pipeline (no "file changed externally" toast).
```

After:
```markdown
**v0.2 (current):** read + write via Overleaf's native realtime OT pipeline. The agent's edits appear in the editor as live operations from a connected collaborator — no "file changed externally" toast.
```

Replace the `## Tools (v0.1)` table heading with `## Tools (v0.2)` and add the new write tools:

```markdown
| Tool | Purpose |
|---|---|
| `list_projects` | List accessible projects |
| `get_project_tree(projectId)` | Folder + file tree (live, OT-backed) |
| `read_doc(projectId, path)` | Text doc content (live, OT-backed) |
| `read_file(projectId, path)` | Binary file (base64; REST by fileId) |
| `write_doc(projectId, path, content)` | Replace a text doc; flows as OT ops, no toast |
| `apply_patch(projectId, path, ops[])` | Advanced: emit raw `[{p,i?,d?}]` OT ops |
| `compile(projectId, draft?, stopOnFirstError?)` | Trigger compile, return URLs |
| `read_compile_log(projectId)` | Compile and return log text |
| `download_pdf(projectId)` | Compile and return PDF bytes (base64) |
```

- [ ] **Step 2: Update CLAUDE.md status**

In `CLAUDE.md`, change the Status section:

```markdown
## Status

- v0.1 (read-only via REST + project-zip cache) — superseded by v0.2
- v0.2 (OT-live reads + writes via ported Overleaf-Workshop Socket.IO client) — shipped
- v0.3 (REST tree mutations: create/move/rename/delete) — not yet started
- Implementation lives at the repo root (`src/`, `test/`, `scripts/`, `package.json`, …)
```

- [ ] **Step 3: Update spec status**

In `docs/superpowers/specs/2026-04-25-overleaf-mcp-design.md`, update the v0.2 phase line:

```markdown
### v0.2 — OT writes and live reads (~2 weeks) — shipped
```

(Don't change the design content — just the status marker.)

- [ ] **Step 4: Run typecheck + full suite**

```bash
npm run typecheck && npm test
```

Expected: still green. Documentation changes don't affect tests.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md docs/superpowers/specs/2026-04-25-overleaf-mcp-design.md
git commit -m "docs(v0.2): document OT writes + live reads, mark v0.2 shipped"
```

---

## Final smoke pass

- [ ] **Step 1: Build**

```bash
npm run build
```

Expected: `dist/` populated. `dist/overleaf/ot.js`, `dist/overleaf/socket.js`, `dist/overleaf/diff.js` present.

- [ ] **Step 2: MCP smoke test**

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' | node dist/cli.js | head -c 4000
```

Expected: 9 tools advertised — the v0.1 7 plus `write_doc` and `apply_patch`.

- [ ] **Step 3: Run live integration**

```bash
# Credentials live in .env.integration (gitignored). See .env.integration.example.
set -a; source .env.integration; set +a
RUN_INTEGRATION=1 npm run test:integration
```

Expected: both integration tests pass — including the OT write roundtrip.

- [ ] **Step 4: Restart Claude Code and ask the agent to edit**

The MCP server is already wired into `.mcp.json`. After a restart Claude Code picks up the new tools. Try:

> "Add a `% TODO: outline` comment at the top of main.tex in the Test Project"

Expected: the comment appears in the Overleaf editor live, no toast.

---

## Spec coverage check

Each requirement in spec § "v0.2 — OT writes and live reads" maps to a task:

| Spec requirement | Task |
|---|---|
| Port `socketio.ts` from Overleaf-Workshop | Tasks 5–12 |
| Implement `write_doc` via OT | Task 16 |
| Implement `apply_patch` via OT | Task 17 |
| Replace zip-cache reads with OT-backed reads (`joinProjectResponse` for tree, `joinDoc` for content) | Tasks 14, 15, 19 |
| Tree event listeners maintain cache coherence | Task 10 |
| Acceptance: agent edits and the change appears in the editor live, no toast | Task 20, final smoke step 4 |

Spec § "Authentication" extra-headers pass-through to the Socket.IO handshake — Task 5 (`OverleafSocket` threads cookie + Origin + extraHeaders into the v0.9 `extraHeaders` option).

Spec § "Connection lifecycle" — Tasks 6 (handshake), 7 (joinDoc lazy), 10 (tree events), 11 (reconnect).

Spec § "Write path" — Tasks 8 (apply + echo), 9 (resync once).

Spec § "Cursor presence" — Task 18 (regression test pinning the no-emit contract).

Spec § "Tree mutations" — Task 10 receives the events; the v0.3 plan (separate) will add the emit side.

Spec § "Error taxonomy" `OT_VERSION_CONFLICT` — Task 2.

No spec gaps remain in v0.2 scope.
