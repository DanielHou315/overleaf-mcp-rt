# overleaf-mcp v0.3 Tree Mutations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `overleaf-mcp` v0.3 — adds the six REST tree-mutation tools (`create_doc`, `create_folder`, `upload_file`, `rename`, `move`, `delete_entity`) so agents have full CRUD on a project's structure. All mutations go through Overleaf's REST endpoints; the realtime service automatically broadcasts `recive*`/`removeEntity` events to update other clients (and our own `OtEngine`'s in-memory tree state).

**Architecture:** Three layers, each tested in isolation:
1. **Engine (`src/overleaf/ot.ts`)** — gains a `pathToEntity(path) → {kind, id}` accessor (the `pathIndex` already stores `kind`; just expose it) and a `waitForPath(path, timeoutMs?)` promise that polls the path index until the realtime broadcast catches up. No new socket plumbing needed — the `recive*`/`removeEntity` listeners installed in v0.2 do the heavy lifting.
2. **REST adapter (`src/overleaf/rest.ts`)** — gains six new methods: `createDoc`, `createFolder`, `uploadFile`, `renameEntity`, `moveEntity`, `deleteEntity`. Each takes the resolved entity ID (path → ID resolution happens upstream). All POSTs/DELETEs flow through the existing `OverleafHttp` client which threads cookie + CSRF + extra headers.
3. **MCP tool layer (`src/mcp/tools/tree.ts` + `src/mcp/tools/index.ts`)** — six new handlers, each resolving a `path` to a `{kind, id}` via `OtEngine.pathToEntity`, calling REST, then `await waitForPath(...)` for new paths so callers see a coherent tree on the next read. Tool definitions added to `TOOL_DEFINITIONS`; switch cases added to `registerAllTools`.

The realtime broadcasts that `OtEngine` already listens for (Tasks 6 + 10 of v0.2) keep the in-memory tree coherent with no additional event plumbing — that was the v0.2 dividend that v0.3 cashes in.

**Tech Stack:**
- Carry-over from v0.2: Node.js ≥ 20, TypeScript 5 (strict, NodeNext ESM), `socket.io-client` (Workshop's fork via patch-package), `vitest` + `msw`, `@modelcontextprotocol/sdk`.
- New runtime dep: **none.** `multipart/form-data` for `upload_file` is constructed via the Web `FormData` global (Node 20+ has native support).
- Reference port source: Overleaf-Workshop `src/api/base.ts` (already cloned at `~/Code/Overleaf-Workshop`, gitignored), specifically `addDoc`, `addFolder`, `uploadFile`, `renameEntity`, `moveEntity`, `deleteEntity` (lines ~525–600).

**Spec reference:** `docs/superpowers/specs/2026-04-25-overleaf-mcp-design.md` — § "MCP tool surface > Write" (lines 117–122) defines the tool signatures; § "v0.3 — Tree mutations (~3 days)" (lines 273–275) is the phase target; § "Tree mutations" (lines 165–167) confirms the architectural choice (REST, not OT).

---

## Endpoint reference (from Workshop)

| Op | Method | Path | Body | Response |
|---|---|---|---|---|
| Create doc | POST | `/project/:id/doc` | `{name, parent_folder_id}` | `{_id}` |
| Create folder | POST | `/project/:id/folder` | `{name, parent_folder_id}` | folder entity |
| Upload file | POST | `/project/:id/upload?folder_id=:folderId` | multipart: `targetFolderId`, `name`, `type` (MIME), `qqfile` (bytes) | `{success, entity_id, entity_type}` |
| Rename | POST | `/project/:id/{doc,file,folder}/:eid/rename` | `{name}` | (empty 200) |
| Move | POST | `/project/:id/{doc,file,folder}/:eid/move` | `{folder_id}` | (empty 200) |
| Delete | DELETE | `/project/:id/{doc,file,folder}/:eid` | — | (empty 204/200) |

All POST/DELETE require `X-Csrf-Token` (already threaded by `OverleafHttp` for non-GET).

`upload_file` may return `entity_type: 'doc'` if the server auto-promotes (Overleaf does this for filenames in `textExtensions` — `.tex`, `.bib`, etc.). The tool surface should pass that through.

---

## Path resolution

The MCP tools take `parentPath`/`path` strings; we map them to entity IDs via `OtEngine`'s `pathIndex`.

- `parentPath: ""` → root folder. Resolved to `project.rootFolder[0]._id` (the engine's root folder ID — it's already in `getProject()?.rootFolder[0]._id`, just needs an accessor).
- `parentPath: "subdir"` → folder ID looked up via `pathToFolderId('subdir')`.
- `path: "main.tex"` → `pathToEntity('main.tex')` returns `{kind: 'doc', id: 'd-...'}`.
- `path: "figures.png"` → `{kind: 'file', id: 'f-...'}`.
- `path: "subdir"` → `{kind: 'folder', id: 'sub-...'}`.

If a path doesn't resolve, throw `NotFoundError` (already exists in `errors.ts`).

After a successful REST mutation, the realtime broadcast usually arrives within ~50–500ms. We add a `waitForPath` poll helper so tools can resolve the new path before returning. Default timeout 2000 ms; if exceeded we still return `{ok: true, id}` — the tree will reconcile shortly. The integration test exercises the wait path against a live CE.

---

## File Structure

After v0.3 the only modules added/grown are:

```
src/
├── overleaf/
│   ├── ot.ts                       (Tasks 1, 2: add pathToEntity, pathToFolderId, rootFolderId, waitForPath)
│   └── rest.ts                     (Tasks 3-8: 6 new methods)
├── mcp/
│   ├── server.ts                   (unchanged)
│   └── tools/
│       ├── index.ts                (Task 13: register 6 new tools)
│       └── tree.ts                 (Task 9-12: NEW — 6 handlers)
test/
├── unit/
│   ├── ot.path-lookup.test.ts      (Task 1: NEW)
│   ├── ot.wait-for-path.test.ts    (Task 2: NEW)
│   ├── rest.tree.test.ts           (Tasks 3-8: NEW — REST mutation tests)
│   └── mcp-tree.test.ts            (Tasks 9-12: NEW — MCP tool tests)
└── integration/
    └── ce-fixture.test.ts          (Task 14: extend with v0.3 roundtrip)

docs/superpowers/
├── plans/
│   └── 2026-04-26-overleaf-mcp-v0.3-tree-mutations.md   (this file)
└── specs/
    └── 2026-04-25-overleaf-mcp-design.md                (Task 15: mark v0.3 shipped)

README.md                            (Task 15: tools table)
CLAUDE.md                            (Task 15: status)
package.json                         (Task 15: 0.2.0 → 0.3.0)
src/cli.ts                           (Task 15: HELP "v0.2" → "v0.3")
src/mcp/server.ts                    (Task 15: server version literal)
```

Each new test file is small and focused — no monster `mcp-tools.test.ts` growth.

---

## Task 1: OtEngine — `rootFolderId`, `pathToEntity`, `pathToFolderId`

**Files:**
- Modify: `src/overleaf/ot.ts`
- Create: `test/unit/ot.path-lookup.test.ts`

The engine's `pathIndex` already stores `{kind, id, parentFolderId}` per path. We only need to expose it.

- [ ] **Step 1: Write the failing test**

Path: `test/unit/ot.path-lookup.test.ts`

```typescript
import { describe, it, expect } from 'vitest'
import { OtEngine } from '../../src/overleaf/ot.js'
import { FakeSocket } from './fake-socket.js'
import type { JoinProjectResponse } from '../../src/overleaf/ot.types.js'

const join = (): JoinProjectResponse => ({
  project: {
    _id: 'p1',
    name: 'Test Project',
    rootDoc_id: 'd-main',
    rootFolder: [
      {
        _id: 'root',
        name: 'rootFolder',
        docs: [{ _id: 'd-main', name: 'main.tex' }],
        fileRefs: [{ _id: 'f-img', name: 'fig.png' }],
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
  publicId: 'pub',
})

async function ready() {
  const sock = new FakeSocket()
  const engine = new OtEngine({ socket: sock, projectId: 'p1' })
  const cp = engine.connect()
  sock.simulate('connectionAccepted', null, 'pub')
  sock.simulate('joinProjectResponse', join())
  await cp
  return engine
}

describe('OtEngine path lookup', () => {
  it('rootFolderId returns the root folder id from joinProjectResponse', async () => {
    const engine = await ready()
    expect(engine.rootFolderId).toBe('root')
  })

  it('rootFolderId is null before connect', () => {
    const sock = new FakeSocket()
    const engine = new OtEngine({ socket: sock, projectId: 'p1' })
    expect(engine.rootFolderId).toBeNull()
  })

  it('pathToEntity returns kind+id for docs, files, and nested docs', async () => {
    const engine = await ready()
    expect(engine.pathToEntity('main.tex')).toEqual({ kind: 'doc', id: 'd-main' })
    expect(engine.pathToEntity('fig.png')).toEqual({ kind: 'file', id: 'f-img' })
    expect(engine.pathToEntity('chapters/intro.tex')).toEqual({ kind: 'doc', id: 'd-intro' })
  })

  it('pathToEntity returns kind=folder for folders', async () => {
    const engine = await ready()
    expect(engine.pathToEntity('chapters')).toEqual({ kind: 'folder', id: 'sub' })
  })

  it('pathToEntity returns null for missing paths', async () => {
    const engine = await ready()
    expect(engine.pathToEntity('does-not-exist.tex')).toBeNull()
  })

  it('pathToFolderId returns id for a folder path; null for a non-folder path', async () => {
    const engine = await ready()
    expect(engine.pathToFolderId('chapters')).toBe('sub')
    expect(engine.pathToFolderId('main.tex')).toBeNull()
    expect(engine.pathToFolderId('does-not-exist')).toBeNull()
  })

  it('pathToFolderId("") returns the root folder id', async () => {
    const engine = await ready()
    expect(engine.pathToFolderId('')).toBe('root')
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- test/unit/ot.path-lookup.test.ts
```

Expected: FAIL — `pathToEntity`, `pathToFolderId`, `rootFolderId` not defined.

- [ ] **Step 3: Add the accessors to `OtEngine`**

In `src/overleaf/ot.ts`, locate the existing `pathToFileId` method (around line 150) and add these accessors immediately after it:

```typescript
  /** Path → root folder id, or null before connect. */
  get rootFolderId(): string | null {
    const project = this.getProject()
    return project?.rootFolder[0]?._id ?? null
  }

  /** Path → { kind, id }. Empty string returns null (use rootFolderId for the root). */
  pathToEntity(path: string): { kind: 'doc' | 'file' | 'folder'; id: string } | null {
    const entry = this.pathIndex.get(path)
    if (!entry) return null
    return { kind: entry.kind, id: entry.id }
  }

  /** Path → folder id. Empty string resolves to the root folder id. */
  pathToFolderId(path: string): string | null {
    if (path === '') return this.rootFolderId
    const entry = this.pathIndex.get(path)
    return entry?.kind === 'folder' ? entry.id : null
  }
```

(`getProject()` and `pathIndex` are already `protected`/`private` members of `OtEngine` set up in v0.2 — the new accessors just expose them.)

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/ot.path-lookup.test.ts
```

Expected: PASS — 7 tests.

- [ ] **Step 5: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; suite up by 7 (was 96 → 103).

- [ ] **Step 6: Commit**

```bash
git add src/overleaf/ot.ts test/unit/ot.path-lookup.test.ts
git commit -m "feat(overleaf/ot): expose pathToEntity, pathToFolderId, rootFolderId"
```

---

## Task 2: OtEngine — `waitForPath`

After a REST mutation we know the new entity ID immediately, but the `pathIndex` won't reflect the new path until the realtime `recive*` broadcast arrives. `waitForPath(path, timeoutMs?)` is a small promise-based poller that resolves once the path appears (or the timeout expires).

**Files:**
- Modify: `src/overleaf/ot.ts`
- Create: `test/unit/ot.wait-for-path.test.ts`

- [ ] **Step 1: Write the failing test**

Path: `test/unit/ot.wait-for-path.test.ts`

```typescript
import { describe, it, expect } from 'vitest'
import { OtEngine } from '../../src/overleaf/ot.js'
import { FakeSocket } from './fake-socket.js'
import type { JoinProjectResponse } from '../../src/overleaf/ot.types.js'

const join = (): JoinProjectResponse => ({
  project: {
    _id: 'p1',
    name: 'Test',
    rootDoc_id: 'd-main',
    rootFolder: [{
      _id: 'root',
      name: 'rootFolder',
      docs: [{ _id: 'd-main', name: 'main.tex' }],
      fileRefs: [],
      folders: [],
    }],
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

describe('OtEngine.waitForPath', () => {
  it('resolves immediately when the path already exists', async () => {
    const { engine } = await ready()
    const t0 = Date.now()
    const entity = await engine.waitForPath('main.tex')
    const elapsed = Date.now() - t0
    expect(entity).toEqual({ kind: 'doc', id: 'd-main' })
    expect(elapsed).toBeLessThan(50)
  })

  it('resolves after the recive event arrives', async () => {
    const { sock, engine } = await ready()
    // Path doesn't exist yet — start waiting
    const waitPromise = engine.waitForPath('extra.tex', 1000)
    // Simulate a mutation broadcast that adds the doc
    setTimeout(() => {
      sock.simulate('reciveNewDoc', 'root', { _id: 'd-extra', name: 'extra.tex' })
    }, 30)
    const entity = await waitPromise
    expect(entity).toEqual({ kind: 'doc', id: 'd-extra' })
  })

  it('rejects with a timeout error when the path never arrives', async () => {
    const { engine } = await ready()
    await expect(engine.waitForPath('never.tex', 50)).rejects.toThrow(/timed out/i)
  })

  it('resolves to a folder kind when the broadcast is reciveNewFolder', async () => {
    const { sock, engine } = await ready()
    const waitPromise = engine.waitForPath('newdir', 500)
    setTimeout(() => {
      sock.simulate('reciveNewFolder', 'root', {
        _id: 'newdir-id', name: 'newdir', docs: [], fileRefs: [], folders: [],
      })
    }, 20)
    expect(await waitPromise).toEqual({ kind: 'folder', id: 'newdir-id' })
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- test/unit/ot.wait-for-path.test.ts
```

Expected: FAIL — `waitForPath` not defined.

- [ ] **Step 3: Add `waitForPath` to `OtEngine`**

In `src/overleaf/ot.ts`, add this method just after `pathToFolderId` (so the path-lookup methods stay grouped):

```typescript
  /**
   * Resolve once `path` appears in the path index, or reject after timeoutMs.
   *
   * Tree mutations go through REST and return the new entity id immediately,
   * but our pathIndex is updated by the recive*/removeEntity broadcast that
   * arrives shortly after. Callers that want to operate on the new path
   * (e.g. write_doc to a freshly-created doc) await this before proceeding.
   *
   * Resolves immediately if the path is already in the index. Otherwise polls
   * every 25ms until the path appears or the timeout fires. Default timeout
   * is 2000ms — long enough for any realistic broadcast latency, short enough
   * to surface a real coherence problem rather than hanging.
   */
  async waitForPath(
    path: string,
    timeoutMs = 2000,
  ): Promise<{ kind: 'doc' | 'file' | 'folder'; id: string }> {
    const POLL_INTERVAL_MS = 25
    const deadline = Date.now() + timeoutMs
    while (true) {
      const entity = this.pathToEntity(path)
      if (entity) return entity
      if (Date.now() >= deadline) {
        throw new OverleafError(
          'OVERLEAF_GENERIC',
          `waitForPath timed out after ${timeoutMs}ms for ${path}`,
          { path, timeoutMs },
        )
      }
      await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS))
    }
  }
```

`OverleafError` is already imported at the top of `ot.ts` from v0.2 — no new import.

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/ot.wait-for-path.test.ts
```

Expected: PASS — 4 tests.

- [ ] **Step 5: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; suite at 107 (103 + 4).

- [ ] **Step 6: Commit**

```bash
git add src/overleaf/ot.ts test/unit/ot.wait-for-path.test.ts
git commit -m "feat(overleaf/ot): add waitForPath for post-mutation tree reconciliation"
```

---

## Task 3: REST `createDoc`

`POST /project/:id/doc` with `{name, parent_folder_id}` returns `{_id}`. The new doc is empty — callers that want content can subsequently `write_doc` (which goes through OT).

**Files:**
- Modify: `src/overleaf/rest.ts`
- Create: `test/unit/rest.tree.test.ts`

- [ ] **Step 1: Write the failing test**

Path: `test/unit/rest.tree.test.ts`

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

describe('OverleafRest.createDoc', () => {
  it('POSTs name + parent_folder_id and returns the new id', async () => {
    server.use(
      http.post('https://o.example/project/p1/doc', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        expect(body).toEqual({ name: 'notes.tex', parent_folder_id: 'root' })
        expect(request.headers.get('x-csrf-token')).toBe('csrf')
        return HttpResponse.json({ _id: 'd-new' })
      }),
    )
    const out = await makeRest().createDoc('p1', 'root', 'notes.tex')
    expect(out).toEqual({ id: 'd-new' })
  })

  it('throws OverleafError on non-OK response', async () => {
    server.use(
      http.post('https://o.example/project/p1/doc', () =>
        HttpResponse.text('forbidden', { status: 403 }),
      ),
    )
    await expect(makeRest().createDoc('p1', 'root', 'x.tex')).rejects.toThrow(/403/)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- test/unit/rest.tree.test.ts
```

Expected: FAIL — `createDoc` not defined.

- [ ] **Step 3: Add `createDoc` to `OverleafRest`**

In `src/overleaf/rest.ts`, append this method to the `OverleafRest` class (after the existing `downloadFile` method):

```typescript
  /**
   * Create an empty text doc under `parentFolderId` with `name`.
   * Returns the new doc's id. The caller can subsequently `write_doc`
   * via OT to populate it.
   *
   * Workshop reference: src/api/base.ts addDoc.
   */
  async createDoc(
    projectId: string,
    parentFolderId: string,
    name: string,
  ): Promise<{ id: string }> {
    const res = await this.http.postJson(`/project/${encodeURIComponent(projectId)}/doc`, {
      name,
      parent_folder_id: parentFolderId,
    })
    if (!res.ok) {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        `createDoc returned ${res.status} for ${name}`,
      )
    }
    const json = (await res.json()) as { _id?: string }
    if (!json._id) {
      throw new OverleafError('OVERLEAF_GENERIC', 'createDoc response missing _id')
    }
    return { id: json._id }
  }
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/rest.tree.test.ts
```

Expected: PASS — 2 tests.

- [ ] **Step 5: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; suite at 109 (107 + 2).

- [ ] **Step 6: Commit**

```bash
git add src/overleaf/rest.ts test/unit/rest.tree.test.ts
git commit -m "feat(rest): createDoc"
```

---

## Task 4: REST `createFolder`

`POST /project/:id/folder` with `{name, parent_folder_id}` returns the folder entity (we only need its `_id`).

**Files:**
- Modify: `src/overleaf/rest.ts`
- Modify: `test/unit/rest.tree.test.ts` (append)

- [ ] **Step 1: Append the failing test**

Append to `test/unit/rest.tree.test.ts`:

```typescript
describe('OverleafRest.createFolder', () => {
  it('POSTs name + parent_folder_id and returns the new id', async () => {
    server.use(
      http.post('https://o.example/project/p1/folder', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        expect(body).toEqual({ name: 'chapters', parent_folder_id: 'root' })
        return HttpResponse.json({ _id: 'fold-new', name: 'chapters', docs: [], fileRefs: [], folders: [] })
      }),
    )
    const out = await makeRest().createFolder('p1', 'root', 'chapters')
    expect(out).toEqual({ id: 'fold-new' })
  })

  it('throws on non-OK response', async () => {
    server.use(
      http.post('https://o.example/project/p1/folder', () =>
        HttpResponse.text('bad', { status: 400 }),
      ),
    )
    await expect(makeRest().createFolder('p1', 'root', 'x')).rejects.toThrow(/400/)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- test/unit/rest.tree.test.ts
```

Expected: FAIL — `createFolder` not defined.

- [ ] **Step 3: Add `createFolder` to `OverleafRest`**

Append to `OverleafRest` (after `createDoc`):

```typescript
  /** Create an empty folder under `parentFolderId`. Workshop ref: addFolder. */
  async createFolder(
    projectId: string,
    parentFolderId: string,
    name: string,
  ): Promise<{ id: string }> {
    const res = await this.http.postJson(`/project/${encodeURIComponent(projectId)}/folder`, {
      name,
      parent_folder_id: parentFolderId,
    })
    if (!res.ok) {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        `createFolder returned ${res.status} for ${name}`,
      )
    }
    const json = (await res.json()) as { _id?: string }
    if (!json._id) {
      throw new OverleafError('OVERLEAF_GENERIC', 'createFolder response missing _id')
    }
    return { id: json._id }
  }
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/rest.tree.test.ts
```

Expected: PASS — 4 tests in this file (2 createDoc + 2 createFolder).

- [ ] **Step 5: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; suite at 111.

- [ ] **Step 6: Commit**

```bash
git add src/overleaf/rest.ts test/unit/rest.tree.test.ts
git commit -m "feat(rest): createFolder"
```

---

## Task 5: REST `uploadFile`

`POST /project/:id/upload?folder_id=:folderId` with multipart form data: fields `targetFolderId`, `name`, `type` (MIME), `qqfile` (bytes). Returns `{success, entity_id, entity_type}`. The server may return `entity_type: 'doc'` if it auto-promoted the file (Overleaf does this for `.tex`/`.bib`/etc).

**Files:**
- Modify: `src/overleaf/rest.ts`
- Modify: `test/unit/rest.tree.test.ts` (append)

- [ ] **Step 1: Append the failing test**

Append to `test/unit/rest.tree.test.ts`:

```typescript
describe('OverleafRest.uploadFile', () => {
  it('posts multipart with targetFolderId/name/type/qqfile and returns id+kind', async () => {
    let receivedForm: FormData | null = null
    server.use(
      http.post('https://o.example/project/p1/upload', async ({ request }) => {
        const url = new URL(request.url)
        expect(url.searchParams.get('folder_id')).toBe('root')
        receivedForm = await request.formData()
        return HttpResponse.json({ success: true, entity_id: 'f-up', entity_type: 'file' })
      }),
    )
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const out = await makeRest().uploadFile('p1', 'root', 'logo.png', bytes, 'image/png')
    expect(out).toEqual({ id: 'f-up', kind: 'file' })
    expect(receivedForm!.get('targetFolderId')).toBe('root')
    expect(receivedForm!.get('name')).toBe('logo.png')
    expect(receivedForm!.get('type')).toBe('image/png')
    const upload = receivedForm!.get('qqfile')
    expect(upload).toBeInstanceOf(File)
  })

  it('passes through entity_type: doc when server auto-promotes', async () => {
    server.use(
      http.post('https://o.example/project/p1/upload', () =>
        HttpResponse.json({ success: true, entity_id: 'd-promo', entity_type: 'doc' }),
      ),
    )
    const out = await makeRest().uploadFile('p1', 'root', 'main.tex', new Uint8Array([1]), 'text/plain')
    expect(out).toEqual({ id: 'd-promo', kind: 'doc' })
  })

  it('throws on non-OK response', async () => {
    server.use(
      http.post('https://o.example/project/p1/upload', () =>
        HttpResponse.text('quota', { status: 413 }),
      ),
    )
    await expect(
      makeRest().uploadFile('p1', 'root', 'big.bin', new Uint8Array([1]), 'application/octet-stream'),
    ).rejects.toThrow(/413/)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- test/unit/rest.tree.test.ts
```

Expected: FAIL — `uploadFile` not defined.

- [ ] **Step 3: Add `uploadFile` to `OverleafRest`**

Append to `OverleafRest`:

```typescript
  /**
   * Upload a binary file under `parentFolderId`. The server may auto-promote
   * the upload to a doc if the filename matches the configured textExtensions
   * — in that case we surface `kind: 'doc'`.
   *
   * Workshop reference: src/api/base.ts uploadFile (uses multipart form-data).
   */
  async uploadFile(
    projectId: string,
    parentFolderId: string,
    name: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<{ id: string; kind: 'doc' | 'file' }> {
    const form = new FormData()
    form.append('targetFolderId', parentFolderId)
    form.append('name', name)
    form.append('type', mimeType)
    form.append(
      'qqfile',
      new File([bytes], name, { type: mimeType }),
      name,
    )
    const path =
      `/project/${encodeURIComponent(projectId)}/upload` +
      `?folder_id=${encodeURIComponent(parentFolderId)}`
    const res = await this.http.postForm(path, form)
    if (!res.ok) {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        `uploadFile returned ${res.status} for ${name}`,
      )
    }
    const json = (await res.json()) as { entity_id?: string; entity_type?: string }
    if (!json.entity_id || !json.entity_type) {
      throw new OverleafError('OVERLEAF_GENERIC', 'uploadFile response missing entity_id/entity_type')
    }
    if (json.entity_type !== 'doc' && json.entity_type !== 'file') {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        `uploadFile got unexpected entity_type ${json.entity_type}`,
      )
    }
    return { id: json.entity_id, kind: json.entity_type }
  }
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/rest.tree.test.ts
```

Expected: PASS — 7 tests in file.

- [ ] **Step 5: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; suite at 114.

- [ ] **Step 6: Commit**

```bash
git add src/overleaf/rest.ts test/unit/rest.tree.test.ts
git commit -m "feat(rest): uploadFile via multipart"
```

---

## Task 6: REST `renameEntity`

`POST /project/:id/{kind}/:eid/rename` with `{name}`. Three URL paths covered (one per kind). Empty 200 response.

**Files:**
- Modify: `src/overleaf/rest.ts`
- Modify: `test/unit/rest.tree.test.ts` (append)

- [ ] **Step 1: Append the failing test**

Append to `test/unit/rest.tree.test.ts`:

```typescript
describe('OverleafRest.renameEntity', () => {
  it.each([
    ['doc', 'd-x'],
    ['file', 'f-x'],
    ['folder', 'fold-x'],
  ] as const)('POSTs to /project/p1/%s/:id/rename', async (kind, id) => {
    let bodyJson: unknown = null
    server.use(
      http.post(`https://o.example/project/p1/${kind}/${id}/rename`, async ({ request }) => {
        bodyJson = await request.json()
        return new HttpResponse(null, { status: 200 })
      }),
    )
    await makeRest().renameEntity('p1', kind, id, 'new-name')
    expect(bodyJson).toEqual({ name: 'new-name' })
  })

  it('throws on non-OK', async () => {
    server.use(
      http.post('https://o.example/project/p1/doc/d-x/rename', () =>
        HttpResponse.text('bad', { status: 400 }),
      ),
    )
    await expect(makeRest().renameEntity('p1', 'doc', 'd-x', 'y')).rejects.toThrow(/400/)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- test/unit/rest.tree.test.ts
```

Expected: FAIL — `renameEntity` not defined.

- [ ] **Step 3: Add `renameEntity` to `OverleafRest`**

Append to `OverleafRest`:

```typescript
  /** Rename an entity. Workshop ref: renameEntity. */
  async renameEntity(
    projectId: string,
    kind: 'doc' | 'file' | 'folder',
    entityId: string,
    newName: string,
  ): Promise<void> {
    const res = await this.http.postJson(
      `/project/${encodeURIComponent(projectId)}/${kind}/${encodeURIComponent(entityId)}/rename`,
      { name: newName },
    )
    if (!res.ok) {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        `renameEntity ${kind} ${entityId} returned ${res.status}`,
      )
    }
  }
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/rest.tree.test.ts
```

Expected: PASS — 11 tests in file (7 + 4 new from rename: 3 parameterized + 1 error).

- [ ] **Step 5: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; suite at 118.

- [ ] **Step 6: Commit**

```bash
git add src/overleaf/rest.ts test/unit/rest.tree.test.ts
git commit -m "feat(rest): renameEntity"
```

---

## Task 7: REST `moveEntity`

`POST /project/:id/{kind}/:eid/move` with `{folder_id: <new parent>}`.

**Files:**
- Modify: `src/overleaf/rest.ts`
- Modify: `test/unit/rest.tree.test.ts` (append)

- [ ] **Step 1: Append the failing test**

Append to `test/unit/rest.tree.test.ts`:

```typescript
describe('OverleafRest.moveEntity', () => {
  it.each([
    ['doc', 'd-x'],
    ['file', 'f-x'],
    ['folder', 'fold-x'],
  ] as const)('POSTs folder_id to /project/p1/%s/:id/move', async (kind, id) => {
    let bodyJson: unknown = null
    server.use(
      http.post(`https://o.example/project/p1/${kind}/${id}/move`, async ({ request }) => {
        bodyJson = await request.json()
        return new HttpResponse(null, { status: 200 })
      }),
    )
    await makeRest().moveEntity('p1', kind, id, 'new-parent')
    expect(bodyJson).toEqual({ folder_id: 'new-parent' })
  })

  it('throws on non-OK', async () => {
    server.use(
      http.post('https://o.example/project/p1/doc/d-x/move', () =>
        HttpResponse.text('forbidden', { status: 403 }),
      ),
    )
    await expect(makeRest().moveEntity('p1', 'doc', 'd-x', 'np')).rejects.toThrow(/403/)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- test/unit/rest.tree.test.ts
```

Expected: FAIL — `moveEntity` not defined.

- [ ] **Step 3: Add `moveEntity` to `OverleafRest`**

Append to `OverleafRest`:

```typescript
  /** Move an entity to a new parent folder. Workshop ref: moveEntity. */
  async moveEntity(
    projectId: string,
    kind: 'doc' | 'file' | 'folder',
    entityId: string,
    newParentFolderId: string,
  ): Promise<void> {
    const res = await this.http.postJson(
      `/project/${encodeURIComponent(projectId)}/${kind}/${encodeURIComponent(entityId)}/move`,
      { folder_id: newParentFolderId },
    )
    if (!res.ok) {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        `moveEntity ${kind} ${entityId} returned ${res.status}`,
      )
    }
  }
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/rest.tree.test.ts
```

Expected: PASS — 15 tests in file.

- [ ] **Step 5: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; suite at 122.

- [ ] **Step 6: Commit**

```bash
git add src/overleaf/rest.ts test/unit/rest.tree.test.ts
git commit -m "feat(rest): moveEntity"
```

---

## Task 8: REST `deleteEntity`

`DELETE /project/:id/{kind}/:eid`. Empty 200/204 response.

**Files:**
- Modify: `src/overleaf/rest.ts`
- Modify: `test/unit/rest.tree.test.ts` (append)

- [ ] **Step 1: Append the failing test**

Append to `test/unit/rest.tree.test.ts`:

```typescript
describe('OverleafRest.deleteEntity', () => {
  it.each([
    ['doc', 'd-x'],
    ['file', 'f-x'],
    ['folder', 'fold-x'],
  ] as const)('DELETEs /project/p1/%s/:id', async (kind, id) => {
    let called = false
    server.use(
      http.delete(`https://o.example/project/p1/${kind}/${id}`, () => {
        called = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    await makeRest().deleteEntity('p1', kind, id)
    expect(called).toBe(true)
  })

  it('throws on non-OK', async () => {
    server.use(
      http.delete('https://o.example/project/p1/doc/d-x', () =>
        HttpResponse.text('not found', { status: 404 }),
      ),
    )
    await expect(makeRest().deleteEntity('p1', 'doc', 'd-x')).rejects.toThrow(/404/)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- test/unit/rest.tree.test.ts
```

Expected: FAIL — `deleteEntity` not defined.

- [ ] **Step 3: Add `deleteEntity` to `OverleafRest`**

Append to `OverleafRest`:

```typescript
  /** Delete an entity. Workshop ref: deleteEntity. */
  async deleteEntity(
    projectId: string,
    kind: 'doc' | 'file' | 'folder',
    entityId: string,
  ): Promise<void> {
    const res = await this.http.delete(
      `/project/${encodeURIComponent(projectId)}/${kind}/${encodeURIComponent(entityId)}`,
    )
    if (!res.ok) {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        `deleteEntity ${kind} ${entityId} returned ${res.status}`,
      )
    }
  }
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/rest.tree.test.ts
```

Expected: PASS — 19 tests in file.

- [ ] **Step 5: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; suite at 126.

- [ ] **Step 6: Commit**

```bash
git add src/overleaf/rest.ts test/unit/rest.tree.test.ts
git commit -m "feat(rest): deleteEntity"
```

---

## Task 9: MCP tool `create_folder`

The simplest tool — creates a folder under `parentPath` with `name`. Resolves `parentPath` via `pathToFolderId`, calls `createFolder`, optionally awaits the realtime broadcast for the new path.

**Files:**
- Create: `src/mcp/tools/tree.ts`
- Create: `test/unit/mcp-tree.test.ts`

- [ ] **Step 1: Write the failing test**

Path: `test/unit/mcp-tree.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { handleCreateFolder } from '../../src/mcp/tools/tree.js'
import { OtEngine } from '../../src/overleaf/ot.js'
import { FakeSocket } from './fake-socket.js'
import { buildContext } from '../../src/mcp/server.js'
import type { JoinProjectResponse } from '../../src/overleaf/ot.types.js'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function joinResp(): JoinProjectResponse {
  return {
    project: {
      _id: 'p1', name: 'p1', rootDoc_id: 'd-main',
      rootFolder: [{
        _id: 'root', name: 'rootFolder',
        docs: [{ _id: 'd-main', name: 'main.tex' }],
        fileRefs: [],
        folders: [{ _id: 'sub', name: 'subdir', docs: [], fileRefs: [], folders: [] }],
      }],
    },
    permissionsLevel: 'owner', protocolVersion: 2, publicId: 'pub-AGENT',
  }
}

function buildTreeTestCtx() {
  const sock = new FakeSocket()
  const ctx = buildContext({
    url: 'https://o.example',
    sessionCookie: 'overleaf_session2=abc',
    extraHeaders: {},
    debug: false,
    csrfToken: 'csrf',
  })
  const engineCache = new Map<string, OtEngine>()
  ;(ctx as unknown as { ot: { get: (p: string) => Promise<OtEngine> } }).ot = {
    async get(projectId: string) {
      const cached = engineCache.get(projectId)
      if (cached) return cached
      const engine = new OtEngine({ socket: sock, projectId })
      const cp = engine.connect()
      sock.simulate('connectionAccepted', null, 'pub-AGENT')
      sock.simulate('joinProjectResponse', joinResp())
      await cp
      engineCache.set(projectId, engine)
      return engine
    },
  }
  return { ctx, sock }
}

describe('create_folder tool', () => {
  it('resolves parentPath, calls REST, awaits broadcast and returns id', async () => {
    const { ctx, sock } = buildTreeTestCtx()
    server.use(
      http.post('https://o.example/project/p1/folder', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        expect(body).toEqual({ name: 'newdir', parent_folder_id: 'root' })
        // Schedule the broadcast that the engine listens for.
        setTimeout(() => {
          sock.simulate('reciveNewFolder', 'root', {
            _id: 'fold-new', name: 'newdir', docs: [], fileRefs: [], folders: [],
          })
        }, 5)
        return HttpResponse.json({ _id: 'fold-new', name: 'newdir', docs: [], fileRefs: [], folders: [] })
      }),
    )
    const out = await handleCreateFolder(ctx, { projectId: 'p1', parentPath: '', name: 'newdir' })
    expect(out).toEqual({ ok: true, id: 'fold-new', kind: 'folder' })
    // Tree state has been updated by the broadcast.
    const engine = await ctx.ot.get('p1')
    expect(engine.pathToFolderId('newdir')).toBe('fold-new')
  })

  it('uses pathToFolderId for non-root parent', async () => {
    const { ctx, sock } = buildTreeTestCtx()
    server.use(
      http.post('https://o.example/project/p1/folder', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        expect(body).toEqual({ name: 'inner', parent_folder_id: 'sub' })
        setTimeout(() => {
          sock.simulate('reciveNewFolder', 'sub', {
            _id: 'fold-inner', name: 'inner', docs: [], fileRefs: [], folders: [],
          })
        }, 5)
        return HttpResponse.json({ _id: 'fold-inner', name: 'inner', docs: [], fileRefs: [], folders: [] })
      }),
    )
    const out = await handleCreateFolder(ctx, { projectId: 'p1', parentPath: 'subdir', name: 'inner' })
    expect(out.id).toBe('fold-inner')
  })

  it('throws NotFoundError when parentPath does not resolve to a folder', async () => {
    const { ctx } = buildTreeTestCtx()
    await expect(
      handleCreateFolder(ctx, { projectId: 'p1', parentPath: 'main.tex', name: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- test/unit/mcp-tree.test.ts
```

Expected: FAIL — `handleCreateFolder` not defined.

- [ ] **Step 3: Create `src/mcp/tools/tree.ts` with `handleCreateFolder`**

Path: `src/mcp/tools/tree.ts`

```typescript
import type { ServerContext } from '../server.js'
import { NotFoundError } from '../../errors.js'

export interface MutationResult {
  ok: true
  id: string
  kind: 'doc' | 'file' | 'folder'
}

/**
 * Resolve a parent path to its folder id (or root) on the engine, throwing
 * NotFoundError if the path is missing or doesn't refer to a folder.
 *
 * Empty string ⇒ root.
 */
async function resolveParentFolderId(
  ctx: ServerContext,
  projectId: string,
  parentPath: string,
): Promise<string> {
  const engine = await ctx.ot.get(projectId)
  const folderId = engine.pathToFolderId(parentPath)
  if (folderId === null) {
    throw new NotFoundError(
      `parentPath ${parentPath || '(root)'} is not a folder in project ${projectId}`,
      { projectId, parentPath },
    )
  }
  return folderId
}

export async function handleCreateFolder(
  ctx: ServerContext,
  input: { projectId: string; parentPath: string; name: string },
): Promise<MutationResult> {
  const parentFolderId = await resolveParentFolderId(ctx, input.projectId, input.parentPath)
  const { id } = await ctx.rest.createFolder(input.projectId, parentFolderId, input.name)
  // Wait for the realtime broadcast so subsequent reads see a coherent tree.
  const engine = await ctx.ot.get(input.projectId)
  const newPath = input.parentPath === '' ? input.name : `${input.parentPath}/${input.name}`
  await engine.waitForPath(newPath).catch(() => {
    // Timeout is non-fatal — REST already succeeded; the next get_project_tree
    // call will see the new folder once the broadcast catches up.
  })
  return { ok: true, id, kind: 'folder' }
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/mcp-tree.test.ts
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; suite at 129.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/tree.ts test/unit/mcp-tree.test.ts
git commit -m "feat(mcp): create_folder tool"
```

---

## Task 10: MCP tool `create_doc`

Same shape as create_folder, plus an optional `content` that, if present, is written via OT after the broadcast catches up.

**Files:**
- Modify: `src/mcp/tools/tree.ts`
- Modify: `test/unit/mcp-tree.test.ts` (append)

- [ ] **Step 1: Append the failing test**

Append to `test/unit/mcp-tree.test.ts`:

```typescript
describe('create_doc tool', () => {
  it('creates an empty doc when content is omitted', async () => {
    const { ctx, sock } = buildTreeTestCtx()
    server.use(
      http.post('https://o.example/project/p1/doc', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        expect(body).toEqual({ name: 'notes.tex', parent_folder_id: 'root' })
        setTimeout(() => {
          sock.simulate('reciveNewDoc', 'root', { _id: 'd-new', name: 'notes.tex' })
        }, 5)
        return HttpResponse.json({ _id: 'd-new' })
      }),
    )
    const out = await handleCreateDoc(ctx, { projectId: 'p1', parentPath: '', name: 'notes.tex' })
    expect(out).toEqual({ ok: true, id: 'd-new', kind: 'doc' })
    const engine = await ctx.ot.get('p1')
    expect(engine.pathToDocId('notes.tex')).toBe('d-new')
  })

  it('writes content via OT after creation when content is provided', async () => {
    const { ctx, sock } = buildTreeTestCtx()
    let appliedOps: unknown = null
    server.use(
      http.post('https://o.example/project/p1/doc', () => {
        setTimeout(() => {
          sock.simulate('reciveNewDoc', 'root', { _id: 'd-new', name: 'notes.tex' })
        }, 5)
        return HttpResponse.json({ _id: 'd-new' })
      }),
    )
    sock.respondToEmit('joinDoc', () => [null, [''], 0, []])
    sock.respondToEmit('applyOtUpdate', (_docId, update) => {
      appliedOps = (update as { op: unknown }).op
      queueMicrotask(() => sock.simulate('otUpdateApplied', {
        doc: 'd-new',
        op: (update as { op: unknown }).op,
        v: 0,
      }))
      return [null]
    })
    const out = await handleCreateDoc(ctx, {
      projectId: 'p1',
      parentPath: '',
      name: 'notes.tex',
      content: 'Hello v0.3',
    })
    expect(out).toEqual({ ok: true, id: 'd-new', kind: 'doc' })
    expect(appliedOps).toEqual([{ p: 0, i: 'Hello v0.3' }])
  })
})
```

Add the import at the top of the file (alongside `handleCreateFolder`):

```typescript
import { handleCreateDoc, handleCreateFolder } from '../../src/mcp/tools/tree.js'
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- test/unit/mcp-tree.test.ts
```

Expected: FAIL — `handleCreateDoc` not defined.

- [ ] **Step 3: Add `handleCreateDoc` to `src/mcp/tools/tree.ts`**

Append to `src/mcp/tools/tree.ts`:

```typescript
export async function handleCreateDoc(
  ctx: ServerContext,
  input: { projectId: string; parentPath: string; name: string; content?: string },
): Promise<MutationResult> {
  const parentFolderId = await resolveParentFolderId(ctx, input.projectId, input.parentPath)
  const { id } = await ctx.rest.createDoc(input.projectId, parentFolderId, input.name)
  const engine = await ctx.ot.get(input.projectId)
  const newPath = input.parentPath === '' ? input.name : `${input.parentPath}/${input.name}`
  await engine.waitForPath(newPath).catch(() => {
    // Broadcast hasn't caught up; OT-write below will fail loudly if needed.
  })
  if (input.content !== undefined && input.content !== '') {
    await engine.writeDoc(id, input.content)
  }
  return { ok: true, id, kind: 'doc' }
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/mcp-tree.test.ts
```

Expected: PASS — 5 tests.

- [ ] **Step 5: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; suite at 131.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/tree.ts test/unit/mcp-tree.test.ts
git commit -m "feat(mcp): create_doc tool with optional initial content"
```

---

## Task 11: MCP tool `upload_file`

Decodes base64 content, calls `uploadFile`. Surfaces the kind (`'doc'` if Overleaf auto-promoted) so callers know whether the path is now an editable doc or a binary fileRef.

**Files:**
- Modify: `src/mcp/tools/tree.ts`
- Modify: `test/unit/mcp-tree.test.ts` (append)

- [ ] **Step 1: Append the failing test**

Append to `test/unit/mcp-tree.test.ts`:

```typescript
describe('upload_file tool', () => {
  it('decodes base64 and uploads with the given mimeType', async () => {
    const { ctx, sock } = buildTreeTestCtx()
    let receivedForm: FormData | null = null
    server.use(
      http.post('https://o.example/project/p1/upload', async ({ request }) => {
        receivedForm = await request.formData()
        setTimeout(() => {
          sock.simulate('reciveNewFile', 'root', { _id: 'f-up', name: 'logo.png' })
        }, 5)
        return HttpResponse.json({ success: true, entity_id: 'f-up', entity_type: 'file' })
      }),
    )
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
    const out = await handleUploadFile(ctx, {
      projectId: 'p1',
      parentPath: '',
      name: 'logo.png',
      contentBase64: png,
      mimeType: 'image/png',
    })
    expect(out).toEqual({ ok: true, id: 'f-up', kind: 'file' })
    expect(receivedForm!.get('type')).toBe('image/png')
  })

  it('returns kind=doc when server auto-promotes a .tex upload', async () => {
    const { ctx, sock } = buildTreeTestCtx()
    server.use(
      http.post('https://o.example/project/p1/upload', () => {
        setTimeout(() => {
          sock.simulate('reciveNewDoc', 'root', { _id: 'd-promo', name: 'extra.tex' })
        }, 5)
        return HttpResponse.json({ success: true, entity_id: 'd-promo', entity_type: 'doc' })
      }),
    )
    const tex = Buffer.from('\\section{Extra}\n').toString('base64')
    const out = await handleUploadFile(ctx, {
      projectId: 'p1',
      parentPath: '',
      name: 'extra.tex',
      contentBase64: tex,
      mimeType: 'text/x-tex',
    })
    expect(out).toEqual({ ok: true, id: 'd-promo', kind: 'doc' })
  })
})
```

Update the import at the top of the file:

```typescript
import { handleCreateDoc, handleCreateFolder, handleUploadFile } from '../../src/mcp/tools/tree.js'
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- test/unit/mcp-tree.test.ts
```

Expected: FAIL — `handleUploadFile` not defined.

- [ ] **Step 3: Add `handleUploadFile` to `src/mcp/tools/tree.ts`**

Append to `src/mcp/tools/tree.ts`:

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
  const parentFolderId = await resolveParentFolderId(ctx, input.projectId, input.parentPath)
  const bytes = new Uint8Array(Buffer.from(input.contentBase64, 'base64'))
  const { id, kind } = await ctx.rest.uploadFile(
    input.projectId,
    parentFolderId,
    input.name,
    bytes,
    input.mimeType,
  )
  const engine = await ctx.ot.get(input.projectId)
  const newPath = input.parentPath === '' ? input.name : `${input.parentPath}/${input.name}`
  await engine.waitForPath(newPath).catch(() => {
    /* tree will catch up shortly */
  })
  return { ok: true, id, kind }
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- test/unit/mcp-tree.test.ts
```

Expected: PASS — 7 tests.

- [ ] **Step 5: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; suite at 133.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/tree.ts test/unit/mcp-tree.test.ts
git commit -m "feat(mcp): upload_file tool with base64 input"
```

---

## Task 12: MCP tools `rename`, `move`, `delete_entity`

All three resolve `path → {kind, id}` via `pathToEntity` and route to the corresponding REST method. They share enough logic that it's worth grouping into one task.

**Files:**
- Modify: `src/mcp/tools/tree.ts`
- Modify: `test/unit/mcp-tree.test.ts` (append)

- [ ] **Step 1: Append the failing tests**

Append to `test/unit/mcp-tree.test.ts`:

```typescript
describe('rename tool', () => {
  it('resolves path → kind+id and POSTs rename', async () => {
    const { ctx, sock } = buildTreeTestCtx()
    let bodyJson: unknown = null
    server.use(
      http.post('https://o.example/project/p1/doc/d-main/rename', async ({ request }) => {
        bodyJson = await request.json()
        setTimeout(() => {
          sock.simulate('reciveEntityRename', 'd-main', 'renamed.tex')
        }, 5)
        return new HttpResponse(null, { status: 200 })
      }),
    )
    const out = await handleRename(ctx, { projectId: 'p1', path: 'main.tex', newName: 'renamed.tex' })
    expect(out).toEqual({ ok: true, id: 'd-main', kind: 'doc' })
    expect(bodyJson).toEqual({ name: 'renamed.tex' })
    const engine = await ctx.ot.get('p1')
    expect(engine.pathToDocId('renamed.tex')).toBe('d-main')
  })

  it('throws NotFoundError when path does not resolve', async () => {
    const { ctx } = buildTreeTestCtx()
    await expect(
      handleRename(ctx, { projectId: 'p1', path: 'missing.tex', newName: 'x.tex' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('move tool', () => {
  it('resolves path → kind+id and POSTs move with new parent', async () => {
    const { ctx, sock } = buildTreeTestCtx()
    let bodyJson: unknown = null
    server.use(
      http.post('https://o.example/project/p1/doc/d-main/move', async ({ request }) => {
        bodyJson = await request.json()
        setTimeout(() => sock.simulate('reciveEntityMove', 'd-main', 'sub'), 5)
        return new HttpResponse(null, { status: 200 })
      }),
    )
    const out = await handleMove(ctx, { projectId: 'p1', path: 'main.tex', newParentPath: 'subdir' })
    expect(out).toEqual({ ok: true, id: 'd-main', kind: 'doc' })
    expect(bodyJson).toEqual({ folder_id: 'sub' })
  })

  it('throws when newParentPath is not a folder', async () => {
    const { ctx } = buildTreeTestCtx()
    await expect(
      handleMove(ctx, { projectId: 'p1', path: 'main.tex', newParentPath: 'nope' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('delete_entity tool', () => {
  it.each([
    ['main.tex', 'd-main', 'doc'],
    ['subdir', 'sub', 'folder'],
  ] as const)('DELETEs entity at %s', async (path, id, kind) => {
    const { ctx, sock } = buildTreeTestCtx()
    let called = false
    server.use(
      http.delete(`https://o.example/project/p1/${kind}/${id}`, () => {
        called = true
        setTimeout(() => sock.simulate('removeEntity', id), 5)
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const out = await handleDeleteEntity(ctx, { projectId: 'p1', path })
    expect(out).toEqual({ ok: true, id, kind })
    expect(called).toBe(true)
  })

  it('throws NotFoundError on missing path', async () => {
    const { ctx } = buildTreeTestCtx()
    await expect(
      handleDeleteEntity(ctx, { projectId: 'p1', path: 'nope' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
```

Update imports at the top:

```typescript
import {
  handleCreateDoc,
  handleCreateFolder,
  handleUploadFile,
  handleRename,
  handleMove,
  handleDeleteEntity,
} from '../../src/mcp/tools/tree.js'
```

- [ ] **Step 2: Run the tests, verify they fail**

```bash
npm test -- test/unit/mcp-tree.test.ts
```

Expected: FAIL — three handlers not defined.

- [ ] **Step 3: Add `handleRename`, `handleMove`, `handleDeleteEntity`**

Append to `src/mcp/tools/tree.ts`:

```typescript
async function resolvePathEntity(
  ctx: ServerContext,
  projectId: string,
  path: string,
): Promise<{ kind: 'doc' | 'file' | 'folder'; id: string }> {
  const engine = await ctx.ot.get(projectId)
  const entity = engine.pathToEntity(path)
  if (!entity) {
    throw new NotFoundError(`No entity at ${path} in project ${projectId}`, {
      projectId, path,
    })
  }
  return entity
}

export async function handleRename(
  ctx: ServerContext,
  input: { projectId: string; path: string; newName: string },
): Promise<MutationResult> {
  const { kind, id } = await resolvePathEntity(ctx, input.projectId, input.path)
  await ctx.rest.renameEntity(input.projectId, kind, id, input.newName)
  // Best-effort wait for the broadcast.
  const engine = await ctx.ot.get(input.projectId)
  const lastSlash = input.path.lastIndexOf('/')
  const newPath = lastSlash >= 0
    ? `${input.path.slice(0, lastSlash)}/${input.newName}`
    : input.newName
  await engine.waitForPath(newPath).catch(() => undefined)
  return { ok: true, id, kind }
}

export async function handleMove(
  ctx: ServerContext,
  input: { projectId: string; path: string; newParentPath: string },
): Promise<MutationResult> {
  const { kind, id } = await resolvePathEntity(ctx, input.projectId, input.path)
  const newParentFolderId = await resolveParentFolderId(
    ctx,
    input.projectId,
    input.newParentPath,
  )
  await ctx.rest.moveEntity(input.projectId, kind, id, newParentFolderId)
  const engine = await ctx.ot.get(input.projectId)
  const lastSlash = input.path.lastIndexOf('/')
  const name = lastSlash >= 0 ? input.path.slice(lastSlash + 1) : input.path
  const newPath = input.newParentPath === '' ? name : `${input.newParentPath}/${name}`
  await engine.waitForPath(newPath).catch(() => undefined)
  return { ok: true, id, kind }
}

export async function handleDeleteEntity(
  ctx: ServerContext,
  input: { projectId: string; path: string },
): Promise<MutationResult> {
  const { kind, id } = await resolvePathEntity(ctx, input.projectId, input.path)
  await ctx.rest.deleteEntity(input.projectId, kind, id)
  return { ok: true, id, kind }
}
```

- [ ] **Step 4: Run the tests, verify they pass**

```bash
npm test -- test/unit/mcp-tree.test.ts
```

Expected: PASS — 13 tests in mcp-tree.test.ts.

- [ ] **Step 5: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; suite at 139.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/tree.ts test/unit/mcp-tree.test.ts
git commit -m "feat(mcp): rename, move, delete_entity tools"
```

---

## Task 13: Register all six tools in `src/mcp/tools/index.ts`

Wire the new handlers into the MCP `TOOL_DEFINITIONS` array and the `switch (name)` dispatcher in `registerAllTools`.

**Files:**
- Modify: `src/mcp/tools/index.ts`
- Modify: `test/unit/mcp-tools.test.ts` (verify the full surface lists 15 tools)

- [ ] **Step 1: Add tool definitions**

In `src/mcp/tools/index.ts`, find the `TOOL_DEFINITIONS` array (it currently ends with `download_pdf`). Append these six entries (preserving the existing trailing `] as const`):

```typescript
  {
    name: 'create_doc',
    description: 'Create a new text doc under parentPath. Optional content is OT-written after creation. Use parentPath="" for the project root.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        parentPath: { type: 'string' },
        name: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['projectId', 'parentPath', 'name'],
    },
  },
  {
    name: 'create_folder',
    description: 'Create a new folder under parentPath. Use parentPath="" for the project root.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        parentPath: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['projectId', 'parentPath', 'name'],
    },
  },
  {
    name: 'upload_file',
    description: 'Upload a binary file (base64) under parentPath with the given mimeType. Overleaf may auto-promote text MIME types to docs; the response\'s kind reflects what the server stored.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        parentPath: { type: 'string' },
        name: { type: 'string' },
        contentBase64: { type: 'string' },
        mimeType: { type: 'string' },
      },
      required: ['projectId', 'parentPath', 'name', 'contentBase64', 'mimeType'],
    },
  },
  {
    name: 'rename',
    description: 'Rename a doc/file/folder at path to newName.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
        newName: { type: 'string' },
      },
      required: ['projectId', 'path', 'newName'],
    },
  },
  {
    name: 'move',
    description: 'Move a doc/file/folder at path under newParentPath. Use newParentPath="" for the project root.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
        newParentPath: { type: 'string' },
      },
      required: ['projectId', 'path', 'newParentPath'],
    },
  },
  {
    name: 'delete_entity',
    description: 'Delete the doc/file/folder at path.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['projectId', 'path'],
    },
  },
```

- [ ] **Step 2: Add the import**

Near the top of `src/mcp/tools/index.ts`, alongside the existing `import { handleReadDoc, ... } from './docs.js'`, add:

```typescript
import {
  handleCreateDoc,
  handleCreateFolder,
  handleUploadFile,
  handleRename,
  handleMove,
  handleDeleteEntity,
} from './tree.js'
```

- [ ] **Step 3: Add switch cases**

In `registerAllTools`'s `switch (name)` block, after the existing `case 'download_pdf'` (and before `default:`), add:

```typescript
        case 'create_doc':
          return wrap(
            await handleCreateDoc(
              ctx,
              args as { projectId: string; parentPath: string; name: string; content?: string },
            ),
          )
        case 'create_folder':
          return wrap(
            await handleCreateFolder(
              ctx,
              args as { projectId: string; parentPath: string; name: string },
            ),
          )
        case 'upload_file':
          return wrap(
            await handleUploadFile(
              ctx,
              args as {
                projectId: string
                parentPath: string
                name: string
                contentBase64: string
                mimeType: string
              },
            ),
          )
        case 'rename':
          return wrap(
            await handleRename(
              ctx,
              args as { projectId: string; path: string; newName: string },
            ),
          )
        case 'move':
          return wrap(
            await handleMove(
              ctx,
              args as { projectId: string; path: string; newParentPath: string },
            ),
          )
        case 'delete_entity':
          return wrap(
            await handleDeleteEntity(
              ctx,
              args as { projectId: string; path: string },
            ),
          )
```

- [ ] **Step 4: Run typecheck and full suite**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; suite remains at 139 (no new tests, only registration).

- [ ] **Step 5: Smoke-test the tool list via stdio**

```bash
npm run build
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' | node dist/cli.js | grep -oE '"name":"[a-z_]+"' | sort -u
```

Expected output: 15 unique tool names (the 9 v0.2 tools plus 6 new v0.3 tools):

```
"name":"apply_patch"
"name":"compile"
"name":"create_doc"
"name":"create_folder"
"name":"delete_entity"
"name":"download_pdf"
"name":"get_project_tree"
"name":"list_projects"
"name":"move"
"name":"read_compile_log"
"name":"read_doc"
"name":"read_file"
"name":"rename"
"name":"upload_file"
"name":"write_doc"
```

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/index.ts
git commit -m "feat(mcp): register the 6 v0.3 tree-mutation tools"
```

---

## Task 14: Live integration test — full CRUD roundtrip

Extend the gated integration test with an end-to-end v0.3 sequence: create folder → create doc with content → rename → move → delete folder. Verifies the realtime broadcast actually fires for each mutation.

**Files:**
- Modify: `test/integration/ce-fixture.test.ts`

- [ ] **Step 1: Append the new test**

Append to the end of the `describe.skipIf(skip)('overleaf-mcp against live CE', ...)` block in `test/integration/ce-fixture.test.ts`, just before the closing `})`:

```typescript
  it('v0.3 tree CRUD: create folder + create doc + rename + delete', async () => {
    const id = await passportLogin({ url: URL, email: EMAIL, password: PASSWORD, extraHeaders: {} })
    const http = new OverleafHttp({
      url: URL, sessionCookie: id.sessionCookie, csrfToken: id.csrfToken, extraHeaders: {},
    })
    const rest = new OverleafRest(http)
    const projects = await rest.listProjects()
    const projectId = projects[0]!.id

    const sock = new OverleafSocket({ url: URL, projectId, sessionCookie: id.sessionCookie, extraHeaders: {} })
    const engine = new OtEngine({ socket: sock, projectId })
    await engine.connect()

    const stamp = Date.now().toString(36)
    const folderName = `v03-it-${stamp}`
    const docName = 'roundtrip.tex'
    const renamedDocName = 'roundtrip-renamed.tex'

    try {
      // 1. Create folder
      const rootId = engine.rootFolderId!
      const { id: folderId } = await rest.createFolder(projectId, rootId, folderName)
      const folderEntity = await engine.waitForPath(folderName, 5000)
      expect(folderEntity).toEqual({ kind: 'folder', id: folderId })

      // 2. Create doc inside folder
      const { id: docId } = await rest.createDoc(projectId, folderId, docName)
      const docEntity = await engine.waitForPath(`${folderName}/${docName}`, 5000)
      expect(docEntity).toEqual({ kind: 'doc', id: docId })

      // 3. Write content via OT
      await engine.writeDoc(docId, '\\section{Roundtrip}\nv0.3 integration test\n')
      // Re-read on a fresh connection to verify persistence
      const sock2 = new OverleafSocket({ url: URL, projectId, sessionCookie: id.sessionCookie, extraHeaders: {} })
      const engine2 = new OtEngine({ socket: sock2, projectId })
      await engine2.connect()
      const reread = (await engine2.joinDoc(docId)).text
      expect(reread).toContain('\\section{Roundtrip}')
      engine2.disconnect()

      // 4. Rename
      await rest.renameEntity(projectId, 'doc', docId, renamedDocName)
      const renamedEntity = await engine.waitForPath(`${folderName}/${renamedDocName}`, 5000)
      expect(renamedEntity.id).toBe(docId)

      // 5. Delete the whole folder (cleans up inner doc too)
      await rest.deleteEntity(projectId, 'folder', folderId)
      // After delete, waitForPath should time out (entity no longer in tree)
      await new Promise((r) => setTimeout(r, 500))
      expect(engine.pathToEntity(folderName)).toBeNull()
    } finally {
      // Best-effort cleanup if the test failed mid-sequence
      try {
        const tree = engine.getTree()
        if (tree.folders[folderName]) {
          const entity = engine.pathToEntity(folderName)
          if (entity) await rest.deleteEntity(projectId, 'folder', entity.id)
        }
      } catch {
        /* ignore */
      }
      engine.disconnect()
    }
  }, 60_000)
```

- [ ] **Step 2: Verify the gate still skips by default**

```bash
npx vitest run --config vitest.integration.config.ts
```

Expected: 3 skipped tests (was 2; now 3 with the new one), no network calls.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 4: (Optional, manual) run against the live CE**

```bash
RUN_INTEGRATION=1 \
  TEST_OVERLEAF_URL=http://your-overleaf-host:port \
  TEST_OVERLEAF_EMAIL=you@example.com \
  TEST_OVERLEAF_PASSWORD=your-password \
  npm run test:integration
```

Expected: all 3 tests pass. Mutations leave no debris (the new folder is deleted at the end).

- [ ] **Step 5: Commit**

```bash
git add test/integration/ce-fixture.test.ts
git commit -m "test(integration): v0.3 tree CRUD roundtrip against live CE"
```

---

## Task 15: README + CLAUDE.md + spec status + version bump

**Files:**
- Modify: `README.md` (intro line + tools table)
- Modify: `CLAUDE.md` (status section)
- Modify: `docs/superpowers/specs/2026-04-25-overleaf-mcp-design.md` (status only)
- Modify: `package.json` (version 0.2.0 → 0.3.0)
- Modify: `src/cli.ts` (HELP text v0.2 → v0.3)
- Modify: `src/mcp/server.ts` (server `version` literal)

- [ ] **Step 1: Update README's intro**

In `README.md`, replace the line containing `**v0.2 (current):**` with:

```markdown
**v0.3 (current):** read + write + full tree CRUD via Overleaf's REST + native OT pipeline. Edits flow as live operations from a connected collaborator — no "file changed externally" toast.
```

- [ ] **Step 2: Update README's tools table**

Replace the v0.2 tools table heading with `## Tools (v0.3)` and append the six new rows at the bottom:

```markdown
| Tool | Purpose |
|---|---|
| `list_projects` | List accessible projects |
| `get_project_tree(projectId)` | Folder + file tree (live, OT-backed) |
| `read_doc(projectId, path)` | Text doc content (live, OT-backed) |
| `read_file(projectId, path)` | Binary file (image / PDF / text / base64 by MIME) |
| `write_doc(projectId, path, content)` | Replace a text doc; flows as OT ops, no toast |
| `apply_patch(projectId, path, ops[])` | Advanced: emit raw `[{p,i?,d?}]` OT ops |
| `compile(projectId, draft?, stopOnFirstError?)` | Trigger compile, return URLs |
| `read_compile_log(projectId)` | Compile and return log text |
| `download_pdf(projectId)` | Compile and return PDF bytes (resource) |
| `create_doc(projectId, parentPath, name, content?)` | Create a doc; optional initial content |
| `create_folder(projectId, parentPath, name)` | Create a folder |
| `upload_file(projectId, parentPath, name, contentBase64, mimeType)` | Upload a binary; server may auto-promote text types to docs |
| `rename(projectId, path, newName)` | Rename a doc/file/folder |
| `move(projectId, path, newParentPath)` | Move a doc/file/folder |
| `delete_entity(projectId, path)` | Delete a doc/file/folder |
```

- [ ] **Step 3: Update CLAUDE.md status**

In `CLAUDE.md`, replace the Status section with:

```markdown
## Status

- v0.1 (read-only via REST + project-zip cache) — superseded by v0.2
- v0.2 (OT-live reads + writes via ported Overleaf-Workshop Socket.IO client) — superseded by v0.3
- v0.3 (REST tree mutations: create_doc, create_folder, upload_file, rename, move, delete_entity) — shipped
- v0.4 (polish: error mapping, per-doc write serialization, cookie-expiry handling, diagnose subcommand) — not yet started
- Implementation lives at the repo root (`src/`, `test/`, `scripts/`, `package.json`, …)
```

- [ ] **Step 4: Update spec status**

In `docs/superpowers/specs/2026-04-25-overleaf-mcp-design.md`, change:

```markdown
### v0.3 — Tree mutations (~3 days)
```

to:

```markdown
### v0.3 — Tree mutations (~3 days) — shipped
```

(Don't change the design content — just the status marker.)

- [ ] **Step 5: Bump version**

In `package.json`, change `"version": "0.2.0"` to `"version": "0.3.0"`.

In `src/cli.ts`, find `MCP server for Overleaf Community Edition (v0.2)` in the HELP string and change to `(v0.3)`.

In `src/mcp/server.ts`, find `version: '0.2.0'` (in the `new Server(...)` constructor) and change to `'0.3.0'`.

- [ ] **Step 6: Run typecheck + full suite**

```bash
npm run typecheck && npm test
```

Expected: still 139/139 (docs changes don't affect tests).

- [ ] **Step 7: Build to confirm dist is current**

```bash
npm run build
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add README.md CLAUDE.md docs/superpowers/specs/2026-04-25-overleaf-mcp-design.md package.json src/cli.ts src/mcp/server.ts
git commit -m "docs(v0.3): document tree mutation tools, mark v0.3 shipped, bump to 0.3.0"
```

---

## Final smoke pass

After all 15 tasks are complete and merged, run these from the repo root:

- [ ] **Step 1: Build**

```bash
npm run build
```

- [ ] **Step 2: MCP tool-list verification**

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' | node dist/cli.js | grep -oE '"name":"[a-z_]+"' | wc -l
```

Expected: `15` unique tool names.

- [ ] **Step 3: Live `claude -p` smoke tests**

```bash
cd /home/daniel/Code/overleaf-ot-mcp
claude -p "Using the overleaf MCP server, list my projects" 2>&1 | tail -10
claude -p "In the Test Project (id 69ed68bac7588e2fd4ecd8c8), create a folder called 'v03-smoke' at the root" 2>&1 | tail -10
claude -p "In the Test Project, create a doc called 'v03-smoke/notes.tex' with content '\\section{Notes}\nv0.3 smoke test'" 2>&1 | tail -10
claude -p "In the Test Project, rename v03-smoke/notes.tex to v03-smoke/draft.tex" 2>&1 | tail -10
claude -p "In the Test Project, show me the file tree" 2>&1 | tail -20
claude -p "In the Test Project, delete the v03-smoke folder" 2>&1 | tail -10
claude -p "In the Test Project, show me the file tree" 2>&1 | tail -20
```

Each invocation runs ~30–60s. Look for `is_error: false`, `ok: true`, and matching content. The final tree should NOT contain `v03-smoke`.

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| `create_doc(projectId, parentPath, name, content?)` → POST /project/:id/doc | Tasks 3, 10, 13 |
| `create_folder(projectId, parentPath, name)` → POST /project/:id/folder | Tasks 4, 9, 13 |
| `upload_file(projectId, parentPath, name, contentB64)` → POST /project/:id/upload | Tasks 5, 11, 13 |
| `rename(projectId, path, newName)` | Tasks 6, 12, 13 |
| `move(projectId, path, newParent)` | Tasks 7, 12, 13 |
| `delete_entity(projectId, path)` → DELETE /project/:id/{doc,file,folder}/:id | Tasks 8, 12, 13 |
| Spec § "Tree mutations" — REST not OT, broadcasts via recive*/removeEntity to keep clients coherent | Architecturally validated by Task 14 (live CE roundtrip) |
| Acceptance: full CRUD on project structure, end-to-end against live CE | Task 14 + final smoke pass |

No spec gaps remain in v0.3 scope.

---

## Self-review notes

- **Type consistency:** `kind: 'doc' | 'file' | 'folder'` is used uniformly across `pathToEntity`, REST methods, and `MutationResult`.
- **Path resolution:** Empty string `""` consistently means "root folder" in `parentPath`/`newParentPath`. Non-empty must resolve to an existing folder, else `NotFoundError`.
- **Optimism:** Tools call `engine.waitForPath(...)` with `.catch(() => undefined)` after mutations — broadcast latency is non-fatal; the tree will reconcile shortly even if the wait times out.
- **content?: undefined vs ''**: `create_doc` treats both as "no content to write" — matches typical caller intent (creating an empty file).
- **`delete_entity` does NOT wait for the broadcast.** The caller already knows what they deleted; waiting for "absence" of a path is awkward. The next `get_project_tree` call will see the path gone.
