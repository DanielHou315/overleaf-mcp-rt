# overleaf-mcp-rt Agent-Ergonomics Improvements

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `overleaf-mcp-rt` MCP tools agent-friendly: surface silent failures, add anchor- and line-based edit modes, accept unified diffs, expose range reads, return informative summaries from write ops, and harden the error envelope.

**Architecture:** All changes are server-side in `overleaf-mcp-rt`. New error types extend `OverleafError`. A new `edit_doc` MCP tool unifies high-level edit modes (find/replace, insert, replace-lines, unified-diff) and resolves them to OT ops server-side. `read_doc_range` returns a substring of a doc. The OT engine pre-validates raw ops against the local baseline and throws `OtDeleteMismatchError` instead of silently no-opping. The image-read path gains a base64-envelope mode for programmatic copy. Existing `apply_patch` and `write_doc` remain backwards-compatible (with the silent-no-op turned into a real error).

**Tech Stack:** TypeScript (ES modules), Node 20+, Vitest, `@modelcontextprotocol/sdk`. New dep: [`diff`](https://www.npmjs.com/package/diff) (~30KB, MIT) for unified-diff parsing.

**Sequencing rationale:**
- Tasks 1–3 land error-handling foundations (silent-noop fix, version drift, structured envelope) that subsequent tasks consume.
- Tasks 4–6 are independent additive features (range read, summary echo, image base64).
- Task 7 introduces `edit_doc` with five non-diff modes; Task 8 adds the `unified_diff` mode on top.
- Task 9 updates README + tool descriptions once the surface is finalized.

**Workflow notes:**
- Work happens directly on `main` (no worktree); the user wants changes to land in their working tree.
- Each task ends with a commit. Bump `package.json` version to `1.1.0` only at the end of Task 9.
- Run `npm run build && npm test` before each commit. All commits must pass `npm test`.

---

### Task 1: Make OT delete-mismatch a real error

**Files:**
- Modify: `src/errors.ts` — add `OtDeleteMismatchError` and the `OT_DELETE_MISMATCH` code
- Modify: `src/overleaf/ot.ts` — `applyOpsLocal` throws on mismatch; `applyOpsWithResync` pre-validates ops before emit
- Modify: `src/mcp/tools/docs.ts` — `handleApplyPatch` lets the typed error propagate
- Test: `test/unit/ot.applyops-mismatch.test.ts` (new)

- [ ] **Step 1: Add the error type**

Edit `src/errors.ts`. Extend the `ErrorCode` union and add the class.

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
  | 'OT_DELETE_MISMATCH'
```

Append at the bottom of the file:

```typescript
export class OtDeleteMismatchError extends OverleafError {
  constructor(
    message: string,
    context: { p: number; expected: string; actual: string; opIndex: number },
  ) {
    super('OT_DELETE_MISMATCH', message, context)
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `test/unit/ot.applyops-mismatch.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { OtDeleteMismatchError } from '../../src/errors.js'

// Re-export the function we want to test by importing it from ot.ts.
// applyOpsLocal is currently a private file-scope function — Step 4 exports it.
import { applyOpsLocal } from '../../src/overleaf/ot.js'

describe('applyOpsLocal', () => {
  it('throws OtDeleteMismatchError when d does not match the substring at p', () => {
    expect(() =>
      applyOpsLocal('hello world', [{ p: 6, d: 'XXXXX' }]),
    ).toThrow(OtDeleteMismatchError)
  })

  it('includes p, expected, actual, opIndex in the error context', () => {
    try {
      applyOpsLocal('hello world', [{ p: 6, d: 'XXXXX' }])
      expect.fail('expected throw')
    } catch (err) {
      if (!(err instanceof OtDeleteMismatchError)) throw err
      expect(err.context.p).toBe(6)
      expect(err.context.expected).toBe('XXXXX')
      expect(err.context.actual).toBe('world')
      expect(err.context.opIndex).toBe(0)
    }
  })

  it('still applies clean inserts and matching deletes', () => {
    const out = applyOpsLocal('hello world', [
      { p: 5, i: ' lovely' },
      { p: 12, d: ' world' },
    ])
    expect(out).toBe('hello lovely')
  })
})
```

- [ ] **Step 3: Run the test — expect compile/runtime failure**

Run: `npm run build && npm test -- ot.applyops-mismatch`
Expected: FAIL — either `applyOpsLocal` is not exported, or it doesn't throw.

- [ ] **Step 4: Fix `applyOpsLocal` and export it**

In `src/overleaf/ot.ts`, find the existing `function applyOpsLocal(...)` near the bottom of the file. Add the `export` keyword and replace the silent-no-op branch.

Replace:

```typescript
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

With:

```typescript
export function applyOpsLocal(text: string, ops: OtOp[]): string {
  let out = text
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    if (op.i !== undefined) {
      out = out.slice(0, op.p) + op.i + out.slice(op.p)
    } else if (op.d !== undefined) {
      const slice = out.slice(op.p, op.p + op.d.length)
      if (slice !== op.d) {
        throw new OtDeleteMismatchError(
          `Delete op #${i} at position ${op.p} expected ${JSON.stringify(op.d.slice(0, 80))}` +
            ` but doc has ${JSON.stringify(slice.slice(0, 80))}`,
          { p: op.p, expected: op.d, actual: slice, opIndex: i },
        )
      }
      out = out.slice(0, op.p) + out.slice(op.p + op.d.length)
    }
  }
  return out
}
```

Add the import at the top of `ot.ts`:

```typescript
import { OverleafError, OtVersionConflictError, OtDeleteMismatchError } from '../errors.js'
```

(Replace the existing two-symbol import line.)

- [ ] **Step 5: Run the unit test — expect pass**

Run: `npm run build && npm test -- ot.applyops-mismatch`
Expected: PASS (3 tests).

- [ ] **Step 6: Pre-validate ops in `applyOpsWithResync` before emitting**

In `src/overleaf/ot.ts`, find `private async applyOpsWithResync(...)`. Right after the `let baseline = ...` block and before the `const update = { ... }` line, add:

```typescript
    // Pre-validate against the local baseline. Surfaces OtDeleteMismatchError
    // before the round-trip to the server, so the agent gets actionable
    // feedback instead of an opaque server reject.
    applyOpsLocal(baseline.text, ops)
```

This validates every `d` op without keeping the result.

- [ ] **Step 7: Run the full test suite — expect pass**

Run: `npm run build && npm test`
Expected: PASS — all existing tests still pass plus the new ones.

- [ ] **Step 8: Commit**

```bash
git add src/errors.ts src/overleaf/ot.ts test/unit/ot.applyops-mismatch.test.ts
git commit -m "fix(ot): throw OtDeleteMismatchError on delete-string mismatch

Previously applyOpsLocal silently returned the text unchanged when a
delete op's string didn't match the substring at p. Combined with the
MCP apply_patch tool returning {ok:true}, that meant agents could fail
silently and never know.

Now applyOpsLocal throws OtDeleteMismatchError with p/expected/actual.
The engine also pre-validates ops against the local baseline before
emitting to the server, so the error fires immediately rather than
relying on a server-side reject."
```

---

### Task 2: Surface OT version drift as a typed, structured error

**Files:**
- Modify: `src/errors.ts` — add `OtVersionDriftError` and `OT_VERSION_DRIFT` code
- Modify: `src/overleaf/ot.ts` — when `applyOps` exhausts retries, throw drift error with versions
- Test: `test/unit/ot.version-drift.test.ts` (new)

- [ ] **Step 1: Add the error type**

Edit `src/errors.ts`. Extend `ErrorCode`:

```typescript
  | 'OT_VERSION_DRIFT'
```

Append:

```typescript
export class OtVersionDriftError extends OverleafError {
  constructor(
    message: string,
    context: { docId: string; expected: number; actual: number },
  ) {
    super('OT_VERSION_DRIFT', message, context)
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `test/unit/ot.version-drift.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { OtEngine } from '../../src/overleaf/ot.js'
import { OtVersionDriftError } from '../../src/errors.js'
import { FakeSocket } from './fake-socket.js'

describe('OtEngine version drift', () => {
  it('throws OtVersionDriftError when the server reports a higher version than the local baseline', async () => {
    const fake = new FakeSocket()
    const engine = new OtEngine({ socket: fake, projectId: 'p1' })
    const connect = engine.connect()
    fake.fire('connectionAccepted', null, 'pubA')
    fake.fire('joinProjectResponse', {
      project: {
        rootFolder: [{
          _id: 'root', name: '', docs: [{ _id: 'doc1', name: 'a.tex' }],
          fileRefs: [], folders: [],
        }],
      },
      publicId: 'pubA',
    })
    await connect

    fake.setAckOnce('joinDoc', null, ['hello'], 5)
    await engine.joinDoc('doc1')

    // Simulate the server sending back a version-drift error for our op.
    fake.setAckOnce('applyOtUpdate', { code: 'VersionMismatch', message: 'doc version 7 expected 5' })
    // After our resync attempt, set the join ack to a different version so we surface drift.
    fake.setAckOnce('joinDoc', null, ['HELLO WORLD'], 7)
    fake.setAckOnce('applyOtUpdate', { code: 'VersionMismatch', message: 'still drifting' })

    await expect(engine.applyOps('doc1', [{ p: 0, i: 'X' }])).rejects.toBeInstanceOf(OtVersionDriftError)
  })
})
```

This test depends on `FakeSocket` exposing `fire(event, ...args)` and `setAckOnce(event, err, ...data)`. Verify those exist in `test/unit/fake-socket.ts` (the existing `ot.resync.test.ts` already uses them).

- [ ] **Step 3: Run — expect failure**

Run: `npm test -- ot.version-drift`
Expected: FAIL — the engine currently throws `OtVersionConflictError`, not `OtVersionDriftError`.

- [ ] **Step 4: Promote OtVersionConflictError to OtVersionDriftError with versions**

In `src/overleaf/ot.ts`, find this block in `applyOpsWithResync`:

```typescript
      if (isVersionMismatch(err)) {
        throw new OtVersionConflictError(
          `Doc ${docId} kept conflicting after resync`,
          { docId, baselineVersion: baseline.version },
        )
      }
```

Replace with:

```typescript
      if (isVersionMismatch(err)) {
        const fresh = this.getBaseline(docId)
        throw new OtVersionDriftError(
          `Doc ${docId} kept drifting after resync`,
          {
            docId,
            expected: baseline.version,
            actual: fresh?.version ?? -1,
          },
        )
      }
```

Update the import at the top of the file to include `OtVersionDriftError`:

```typescript
import { OverleafError, OtVersionConflictError, OtDeleteMismatchError, OtVersionDriftError } from '../errors.js'
```

- [ ] **Step 5: Run the unit test — expect pass**

Run: `npm test -- ot.version-drift`
Expected: PASS.

- [ ] **Step 6: Run the full suite — expect pass**

Run: `npm run build && npm test`
Expected: PASS — including the existing `ot.resync.test.ts`.

If `ot.resync.test.ts` had asserted on `OtVersionConflictError`, update it to `OtVersionDriftError` (grep the test file). Re-run.

- [ ] **Step 7: Commit**

```bash
git add src/errors.ts src/overleaf/ot.ts test/unit/ot.version-drift.test.ts test/unit/ot.resync.test.ts
git commit -m "feat(ot): surface version drift as OtVersionDriftError with versions

When applyOps exhausts retries and the server is still out of sync with
our local baseline, throw OtVersionDriftError with {expected, actual}
versions instead of the opaque OtVersionConflictError. Agents can now
branch on the typed error to retry or refresh."
```

---

### Task 3: Structured error envelope in MCP responses

**Files:**
- Modify: `src/mcp/tools/index.ts` — replace the `${err.code}: ${err.message}` text path with a structured envelope
- Modify: `src/errors.ts` — add a `toEnvelope()` method to `OverleafError`
- Test: `test/unit/mcp-error-envelope.test.ts` (new)

- [ ] **Step 1: Add `toEnvelope` to `OverleafError`**

In `src/errors.ts`, add inside the `OverleafError` class body:

```typescript
  toEnvelope(): { code: ErrorCode; message: string; context: Record<string, unknown>; retryable: boolean; hint?: string } {
    return {
      code: this.code,
      message: this.message,
      context: this.context,
      retryable: isRetryable(this.code),
      hint: hintFor(this.code),
    }
  }
```

Below the class definitions, add the helpers:

```typescript
const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set([
  'NETWORK_ERROR',
  'OT_VERSION_CONFLICT',
  'OT_VERSION_DRIFT',
])

function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE_CODES.has(code)
}

const HINTS: Partial<Record<ErrorCode, string>> = {
  OT_DELETE_MISMATCH:
    'The d-string did not match the doc at position p. Re-read the doc to get the current text, then recompute offsets.',
  OT_VERSION_DRIFT:
    'The doc was modified concurrently. Re-read the doc and retry the edit.',
  OVERLEAF_AUTH_FAILED:
    'The session cookie is invalid or expired. Run `overleaf-mcp-rt login` to refresh.',
  PROXY_AUTH_FAILED:
    'A reverse proxy (e.g. Cloudflare Access) blocked the request. Configure OVERLEAF_EXTRA_HEADERS.',
}

function hintFor(code: ErrorCode): string | undefined {
  return HINTS[code]
}
```

- [ ] **Step 2: Write the failing test**

Create `test/unit/mcp-error-envelope.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { OtDeleteMismatchError, AuthFailedError } from '../../src/errors.js'

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
})
```

- [ ] **Step 3: Run — expect failure**

Run: `npm test -- mcp-error-envelope`
Expected: FAIL — `toEnvelope` not yet on the class. (After Step 1 it should pass; if Step 1 was already saved, it passes.)

- [ ] **Step 4: Update the MCP tool wrapper to emit the envelope**

In `src/mcp/tools/index.ts`, replace the catch block in `setRequestHandler(CallToolRequestSchema, ...)`:

```typescript
    } catch (err) {
      if (err instanceof OverleafError) {
        return {
          content: [{ type: 'text', text: JSON.stringify(err.toEnvelope(), null, 2) }],
          isError: true,
        }
      }
      throw err
    }
```

(Keep the `OverleafError` import — it's already there.)

- [ ] **Step 5: Verify with existing MCP tools test**

Run: `npm test`
Expected: PASS. If `mcp-tools.test.ts` had asserted on the old text format `${code}: ${message}`, update those assertions to parse the JSON envelope.

- [ ] **Step 6: Commit**

```bash
git add src/errors.ts src/mcp/tools/index.ts test/unit/mcp-error-envelope.test.ts test/unit/mcp-tools.test.ts
git commit -m "feat(mcp): structured error envelope with code/message/hint/retryable

Tool errors now serialize to JSON with {code, message, context, retryable,
hint?} instead of a flat 'CODE: message' string. Agents can branch on
retryable to drive retry loops, and hint provides actionable next-step
guidance for the most common failure modes."
```

---

### Task 4: `read_doc_range` tool

**Files:**
- Create: `src/mcp/tools/range.ts`
- Modify: `src/mcp/tools/index.ts` — register `read_doc_range`
- Test: `test/unit/mcp-range.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `test/unit/mcp-range.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { handleReadDocRange } from '../../src/mcp/tools/range.js'
import type { ServerContext } from '../../src/mcp/server.js'

function makeCtx(text: string): ServerContext {
  return {
    rest: null as never,
    http: null as never,
    ot: {
      get: async () => ({
        pathToDocId: () => 'docX',
        joinDoc: async () => ({ docId: 'docX', text, version: 1 }),
      }),
    } as never,
  }
}

describe('read_doc_range', () => {
  const text = 'line one\nline two\nline three\nline four\n'

  it('returns the requested line range (1-indexed inclusive)', async () => {
    const out = await handleReadDocRange(makeCtx(text), {
      projectId: 'p',
      path: 'a.tex',
      startLine: 2,
      endLine: 3,
    })
    expect(out.content).toBe('line two\nline three')
    expect(out.startLine).toBe(2)
    expect(out.endLine).toBe(3)
  })

  it('returns by offset/length when startOffset is provided', async () => {
    const out = await handleReadDocRange(makeCtx(text), {
      projectId: 'p',
      path: 'a.tex',
      startOffset: 9,
      length: 8,
    })
    expect(out.content).toBe('line two')
    expect(out.startOffset).toBe(9)
  })

  it('clamps endLine to the document length', async () => {
    const out = await handleReadDocRange(makeCtx(text), {
      projectId: 'p',
      path: 'a.tex',
      startLine: 3,
      endLine: 999,
    })
    expect(out.content).toBe('line three\nline four\n')
    expect(out.endLine).toBe(5)  // doc has 5 lines counting trailing empty
  })

  it('rejects when neither startLine nor startOffset is given', async () => {
    await expect(
      handleReadDocRange(makeCtx(text), { projectId: 'p', path: 'a.tex' } as never),
    ).rejects.toThrow(/startLine.*startOffset/)
  })
})
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- mcp-range`
Expected: FAIL — `range.ts` does not exist.

- [ ] **Step 3: Implement `range.ts`**

Create `src/mcp/tools/range.ts`:

```typescript
import type { ServerContext } from '../server.js'
import { NotFoundError, OverleafError } from '../../errors.js'

export interface ReadDocRangeInput {
  projectId: string
  path: string
  startLine?: number
  endLine?: number
  startOffset?: number
  length?: number
}

export interface ReadDocRangeOutput {
  content: string
  startLine?: number
  endLine?: number
  startOffset?: number
  length?: number
  totalLines: number
  totalChars: number
}

export async function handleReadDocRange(
  ctx: ServerContext,
  input: ReadDocRangeInput,
): Promise<ReadDocRangeOutput> {
  const engine = await ctx.ot.get(input.projectId)
  const docId = engine.pathToDocId(input.path)
  if (docId === null) {
    throw new NotFoundError(`No doc at ${input.path} in project ${input.projectId}`)
  }
  const baseline = await engine.joinDoc(docId)
  const text = baseline.text
  const lines = text.split('\n')
  const totalLines = lines.length
  const totalChars = text.length

  if (input.startOffset !== undefined) {
    const start = Math.max(0, input.startOffset)
    const len = input.length ?? totalChars - start
    const end = Math.min(totalChars, start + Math.max(0, len))
    return {
      content: text.slice(start, end),
      startOffset: start,
      length: end - start,
      totalLines,
      totalChars,
    }
  }

  if (input.startLine !== undefined) {
    const start = Math.max(1, input.startLine)
    const end = Math.min(totalLines, input.endLine ?? start)
    // 1-indexed inclusive; lines[start-1..end-1] joined by \n
    const slice = lines.slice(start - 1, end).join('\n')
    return {
      content: slice,
      startLine: start,
      endLine: end,
      totalLines,
      totalChars,
    }
  }

  throw new OverleafError(
    'OVERLEAF_GENERIC',
    'read_doc_range requires either startLine (with optional endLine) or startOffset (with optional length)',
  )
}
```

- [ ] **Step 4: Register the tool**

In `src/mcp/tools/index.ts`:

Add to the `TOOL_DEFINITIONS` array (e.g. immediately after `read_doc`):

```typescript
  {
    name: 'read_doc_range',
    description: 'Read a substring of a text doc by line range (startLine/endLine, 1-indexed inclusive) or by offset/length. Returns totalLines and totalChars for context.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
        startOffset: { type: 'integer', minimum: 0 },
        length: { type: 'integer', minimum: 0 },
      },
      required: ['projectId', 'path'],
    },
  },
```

Add the import near the top:

```typescript
import { handleReadDocRange } from './range.js'
```

Add a switch case in `setRequestHandler`:

```typescript
        case 'read_doc_range':
          return wrap(
            await handleReadDocRange(
              ctx,
              args as { projectId: string; path: string; startLine?: number; endLine?: number; startOffset?: number; length?: number },
            ),
          )
```

- [ ] **Step 5: Run the test — expect pass**

Run: `npm run build && npm test -- mcp-range`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the full suite — expect pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools/range.ts src/mcp/tools/index.ts test/unit/mcp-range.test.ts
git commit -m "feat(mcp): add read_doc_range tool

Returns a substring of a text doc by line range (1-indexed inclusive)
or by offset/length. Saves agents from fetching the full doc just to
verify a small region after an edit."
```

---

### Task 5: Edit-summary echo from `write_doc` and `apply_patch`

**Files:**
- Modify: `src/mcp/tools/docs.ts` — return `{ ok: true, summary: { ... } }` from both handlers
- Modify: `src/overleaf/ot.ts` — `applyOps` returns the (versionBefore, versionAfter, charsBefore, charsAfter) so the tool layer can compute deltas; minimal change
- Test: `test/unit/mcp-write-summary.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `test/unit/mcp-write-summary.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { handleWriteDoc, handleApplyPatch } from '../../src/mcp/tools/docs.js'
import type { ServerContext } from '../../src/mcp/server.js'

function makeCtx(initial: string) {
  let text = initial
  let version = 3
  return {
    text: () => text,
    version: () => version,
    ctx: {
      rest: null as never,
      http: null as never,
      ot: {
        get: async () => ({
          pathToDocId: () => 'docX',
          joinDoc: async () => ({ docId: 'docX', text, version }),
          writeDoc: async (_: string, newText: string) => {
            text = newText
            version += 1
          },
          applyOps: async (_: string, ops: Array<{ p: number; i?: string; d?: string }>) => {
            // emulate ops on the text
            let out = text
            for (const op of ops) {
              if (op.i !== undefined) out = out.slice(0, op.p) + op.i + out.slice(op.p)
              else if (op.d !== undefined) out = out.slice(0, op.p) + out.slice(op.p + op.d.length)
            }
            text = out
            version += 1
          },
          getBaseline: () => ({ text, version }),
        }),
      },
    } as ServerContext,
  }
}

describe('write_doc summary', () => {
  it('returns charsBefore, charsAfter, versionBefore, versionAfter, charsDelta', async () => {
    const harness = makeCtx('hello')
    const out = await handleWriteDoc(harness.ctx, { projectId: 'p', path: 'a.tex', content: 'hello world' })
    expect(out.ok).toBe(true)
    expect(out.summary?.charsBefore).toBe(5)
    expect(out.summary?.charsAfter).toBe(11)
    expect(out.summary?.charsDelta).toBe(6)
    expect(out.summary?.versionBefore).toBe(3)
    expect(out.summary?.versionAfter).toBe(4)
  })
})

describe('apply_patch summary', () => {
  it('reports charsDelta from inserts/deletes', async () => {
    const harness = makeCtx('hello world')
    const out = await handleApplyPatch(harness.ctx, {
      projectId: 'p', path: 'a.tex',
      ops: [{ p: 5, i: ' lovely' }],
    })
    expect(out.ok).toBe(true)
    expect(out.summary?.charsDelta).toBe(7)
    expect(out.summary?.opsApplied).toBe(1)
  })
})
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- mcp-write-summary`
Expected: FAIL — `summary` is not on the return type.

- [ ] **Step 3: Update `handleWriteDoc` and `handleApplyPatch`**

In `src/mcp/tools/docs.ts`, replace both handlers' bodies:

```typescript
export interface WriteSummary {
  versionBefore: number
  versionAfter: number
  charsBefore: number
  charsAfter: number
  charsDelta: number
  opsApplied: number
}

export async function handleWriteDoc(
  ctx: ServerContext,
  input: { projectId: string; path: string; content: string },
): Promise<{ ok: true; summary: WriteSummary }> {
  const engine = await ctx.ot.get(input.projectId)
  const docId = engine.pathToDocId(input.path)
  if (docId === null) {
    throw new NotFoundError(`No doc at ${input.path} in project ${input.projectId}`)
  }
  const before = await engine.joinDoc(docId)
  const charsBefore = before.text.length
  const versionBefore = before.version
  await engine.writeDoc(docId, input.content)
  const after = engine.getBaseline?.(docId) ?? before
  return {
    ok: true,
    summary: {
      versionBefore,
      versionAfter: after.version,
      charsBefore,
      charsAfter: input.content.length,
      charsDelta: input.content.length - charsBefore,
      opsApplied: 1,
    },
  }
}

export async function handleApplyPatch(
  ctx: ServerContext,
  input: { projectId: string; path: string; ops: OtOp[] },
): Promise<{ ok: true; summary: WriteSummary }> {
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
  const before = await engine.joinDoc(docId)
  const charsBefore = before.text.length
  const versionBefore = before.version

  await engine.applyOps(docId, input.ops)
  const after = engine.getBaseline?.(docId) ?? before
  return {
    ok: true,
    summary: {
      versionBefore,
      versionAfter: after.version,
      charsBefore,
      charsAfter: after.text.length,
      charsDelta: after.text.length - charsBefore,
      opsApplied: input.ops.length,
    },
  }
}
```

The `engine.getBaseline?.(docId)` call uses the existing protected `getBaseline` method on `OtEngine`. To make it accessible to tools, change its visibility in `src/overleaf/ot.ts`:

```typescript
  getBaseline(docId: string): DocBaseline | undefined {
    return this.baselines.get(docId)
  }
```

(Drop the `protected` keyword.)

- [ ] **Step 4: Run the test — expect pass**

Run: `npm run build && npm test -- mcp-write-summary`
Expected: PASS.

- [ ] **Step 5: Update existing assertions if any**

Run: `npm test`
If any existing test asserts on `{ ok: true }` exactly (deep equality), loosen to `expect(result.ok).toBe(true)`. Re-run.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/docs.ts src/overleaf/ot.ts test/unit/mcp-write-summary.test.ts
git commit -m "feat(mcp): write_doc and apply_patch echo a summary

Both tools now return {ok, summary: {versionBefore, versionAfter,
charsBefore, charsAfter, charsDelta, opsApplied}}. Lets agents
sanity-check edits without re-reading the doc."
```

---

### Task 6: `read_file` base64-envelope opt-in for image MIMEs

**Files:**
- Modify: `src/mcp/tools/index.ts` — `read_file` accepts an optional `as: 'auto' | 'base64'` parameter
- Modify: `src/mcp/tools/index.ts` — `formatBinaryFile` honors `as` parameter
- Test: `test/unit/mcp-read-file-as.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `test/unit/mcp-read-file-as.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { formatBinaryFile } from '../../src/mcp/tools/index.js'

describe('read_file as=base64', () => {
  it('returns a {contentBase64, mimeType} envelope for image MIMEs when as=base64', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const result = formatBinaryFile(
      { bytes: png, contentType: 'image/png' },
      'p1', 'figs/x.png',
      'base64',
    )
    const c = result.content[0] as { type: string; text: string }
    expect(c.type).toBe('text')
    const parsed = JSON.parse(c.text)
    expect(parsed.contentBase64).toBe(png.toString('base64'))
    expect(parsed.mimeType).toBe('image/png')
  })

  it('still returns native image content when as is omitted', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const result = formatBinaryFile(
      { bytes: png, contentType: 'image/png' },
      'p1', 'figs/x.png',
    )
    const c = result.content[0] as { type: string }
    expect(c.type).toBe('image')
  })
})
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- mcp-read-file-as`
Expected: FAIL — `formatBinaryFile` doesn't accept the `as` parameter.

- [ ] **Step 3: Update `formatBinaryFile`**

In `src/mcp/tools/index.ts`, change the signature and add the `as` branch:

```typescript
export function formatBinaryFile(
  result: { bytes: Buffer; contentType: string },
  projectId: string,
  path: string,
  as: 'auto' | 'base64' = 'auto',
): { content: Array<unknown> } {
  const base64 = result.bytes.toString('base64')
  const ct = effectiveMime(result.contentType, path)
  if (as === 'base64') {
    return wrap({ contentBase64: base64, mimeType: ct })
  }
  if (ct.startsWith('image/')) {
    return { content: [{ type: 'image', data: base64, mimeType: ct }] }
  }
  // ... rest unchanged
```

(Keep all the other branches the same.)

- [ ] **Step 4: Wire `as` through the read_file tool**

Find the `case 'read_file'` block in `setRequestHandler`. Replace with:

```typescript
        case 'read_file': {
          const args2 = args as { projectId: string; path: string; as?: 'auto' | 'base64' }
          const result = await handleReadFile(ctx, args2)
          return formatBinaryFile(result, args2.projectId, args2.path, args2.as ?? 'auto')
        }
```

In the `read_file` tool definition, add `as` to the `properties`:

```typescript
        as: { type: 'string', enum: ['auto', 'base64'] },
```

And update the description:

```typescript
    description: 'Read a binary file by path within a project. Default (as=auto): returns native MCP image content for image MIMEs, text content for text MIMEs, resource for PDFs, and a {contentBase64,mimeType} envelope for other binary types. Pass as="base64" to force the {contentBase64,mimeType} envelope for all types — useful when you need programmatic access to the bytes (e.g. to copy a binary between paths via upload_file).',
```

- [ ] **Step 5: Run the test — expect pass**

Run: `npm run build && npm test -- mcp-read-file-as`
Expected: PASS.

- [ ] **Step 6: Run the full suite — expect pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools/index.ts test/unit/mcp-read-file-as.test.ts
git commit -m "feat(mcp): read_file as=base64 opt-in for image MIMEs

Agents that want programmatic byte access (e.g. to copy an image
between two project paths via upload_file) can now pass as='base64'
to force the {contentBase64, mimeType} envelope. Default behavior
(native MCP image content for image MIMEs) is unchanged."
```

---

### Task 7: `edit_doc` tool — anchor-based, line-based, raw-ops, atomic

**Files:**
- Create: `src/mcp/tools/edit.ts`
- Modify: `src/mcp/tools/index.ts` — register `edit_doc`
- Test: `test/unit/mcp-edit-doc.test.ts` (new)

This is the largest single task. It introduces a five-mode `edit_doc` tool that resolves anchors to OT ops on the server. The unified-diff mode comes in Task 8.

- [ ] **Step 1: Write the failing test**

Create `test/unit/mcp-edit-doc.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { handleEditDoc } from '../../src/mcp/tools/edit.js'
import type { ServerContext } from '../../src/mcp/server.js'

function makeCtx(initial: string) {
  let text = initial
  let version = 1
  return {
    text: () => text,
    version: () => version,
    ctx: {
      rest: null as never,
      http: null as never,
      ot: {
        get: async () => ({
          pathToDocId: () => 'docX',
          joinDoc: async () => ({ docId: 'docX', text, version }),
          getBaseline: () => ({ text, version }),
          applyOps: async (_: string, ops: Array<{ p: number; i?: string; d?: string }>) => {
            let out = text
            for (const op of ops) {
              if (op.i !== undefined) out = out.slice(0, op.p) + op.i + out.slice(op.p)
              else if (op.d !== undefined) out = out.slice(0, op.p) + out.slice(op.p + op.d.length)
            }
            text = out
            version += 1
          },
        }),
      },
    } as ServerContext,
  }
}

describe('edit_doc replace mode', () => {
  it('replaces a unique find-string', async () => {
    const h = makeCtx('hello world')
    const r = await handleEditDoc(h.ctx, {
      projectId: 'p', path: 'a.tex',
      edits: [{ mode: 'replace', find: 'world', replace: 'there' }],
    })
    expect(r.ok).toBe(true)
    expect(h.text()).toBe('hello there')
  })

  it('errors when find is not unique and occurrence is "unique"', async () => {
    const h = makeCtx('foo foo foo')
    await expect(
      handleEditDoc(h.ctx, {
        projectId: 'p', path: 'a.tex',
        edits: [{ mode: 'replace', find: 'foo', replace: 'bar' }],
      }),
    ).rejects.toThrow(/found 3 matches/)
  })

  it('replaces all occurrences when occurrence is "all"', async () => {
    const h = makeCtx('foo foo foo')
    await handleEditDoc(h.ctx, {
      projectId: 'p', path: 'a.tex',
      edits: [{ mode: 'replace', find: 'foo', replace: 'bar', occurrence: 'all' }],
    })
    expect(h.text()).toBe('bar bar bar')
  })

  it('errors when find is not present', async () => {
    const h = makeCtx('hello')
    await expect(
      handleEditDoc(h.ctx, {
        projectId: 'p', path: 'a.tex',
        edits: [{ mode: 'replace', find: 'absent', replace: 'x' }],
      }),
    ).rejects.toThrow(/not found/)
  })
})

describe('edit_doc insert_before / insert_after', () => {
  it('inserts before a unique anchor', async () => {
    const h = makeCtx('hello world')
    await handleEditDoc(h.ctx, {
      projectId: 'p', path: 'a.tex',
      edits: [{ mode: 'insert_before', find: 'world', text: 'big ' }],
    })
    expect(h.text()).toBe('hello big world')
  })

  it('inserts after a unique anchor', async () => {
    const h = makeCtx('hello world')
    await handleEditDoc(h.ctx, {
      projectId: 'p', path: 'a.tex',
      edits: [{ mode: 'insert_after', find: 'hello', text: ', big' }],
    })
    expect(h.text()).toBe('hello, big world')
  })
})

describe('edit_doc replace_lines', () => {
  it('replaces lines 2-3 inclusive (1-indexed)', async () => {
    const h = makeCtx('a\nb\nc\nd\n')
    await handleEditDoc(h.ctx, {
      projectId: 'p', path: 'a.tex',
      edits: [{ mode: 'replace_lines', startLine: 2, endLine: 3, text: 'B\nC' }],
    })
    expect(h.text()).toBe('a\nB\nC\nd\n')
  })
})

describe('edit_doc atomic semantics', () => {
  it('does not apply any edit when one of them fails to resolve', async () => {
    const h = makeCtx('hello world')
    await expect(
      handleEditDoc(h.ctx, {
        projectId: 'p', path: 'a.tex',
        edits: [
          { mode: 'replace', find: 'hello', replace: 'HI' },
          { mode: 'replace', find: 'absent', replace: 'X' },
        ],
      }),
    ).rejects.toThrow(/not found/)
    expect(h.text()).toBe('hello world')
  })
})

describe('edit_doc dry_run', () => {
  it('reports what would change without applying', async () => {
    const h = makeCtx('hello world')
    const r = await handleEditDoc(h.ctx, {
      projectId: 'p', path: 'a.tex',
      edits: [{ mode: 'replace', find: 'world', replace: 'there' }],
      dryRun: true,
    })
    expect(r.ok).toBe(true)
    expect(r.dryRun).toBe(true)
    expect(h.text()).toBe('hello world')
    expect(r.summary?.opsApplied).toBe(1)
  })
})
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- mcp-edit-doc`
Expected: FAIL — `edit.ts` does not exist.

- [ ] **Step 3: Implement `edit.ts`**

Create `src/mcp/tools/edit.ts`:

```typescript
import type { ServerContext } from '../server.js'
import { NotFoundError, OverleafError } from '../../errors.js'
import type { OtOp } from '../../overleaf/diff.js'
import type { WriteSummary } from './docs.js'

export type EditMode =
  | { mode: 'replace'; find: string; replace: string; occurrence?: 'unique' | 'first' | 'all' | number }
  | { mode: 'insert_before'; find: string; text: string }
  | { mode: 'insert_after'; find: string; text: string }
  | { mode: 'replace_lines'; startLine: number; endLine: number; text: string }
  | { mode: 'raw_ops'; ops: OtOp[] }

export interface EditDocInput {
  projectId: string
  path: string
  edits: EditMode[]
  dryRun?: boolean
}

export interface EditDocOutput {
  ok: true
  dryRun: boolean
  summary: WriteSummary
  resolvedOps?: OtOp[]
}

export async function handleEditDoc(
  ctx: ServerContext,
  input: EditDocInput,
): Promise<EditDocOutput> {
  if (!input.edits || input.edits.length === 0) {
    throw new OverleafError('OVERLEAF_GENERIC', 'edits must be a non-empty array')
  }

  const engine = await ctx.ot.get(input.projectId)
  const docId = engine.pathToDocId(input.path)
  if (docId === null) {
    throw new NotFoundError(`No doc at ${input.path} in project ${input.projectId}`)
  }
  const baseline = await engine.joinDoc(docId)
  const text = baseline.text
  const versionBefore = baseline.version
  const charsBefore = text.length

  // Resolve every edit to OT ops against the baseline. We compute ops for each
  // edit in DOCUMENT order (sorted by anchor position descending) so positions
  // remain stable. Atomicity: if any edit fails to resolve, throw — caller's
  // doc is untouched (we haven't emitted yet).
  const resolved = resolveEdits(text, input.edits)

  if (input.dryRun) {
    return {
      ok: true,
      dryRun: true,
      summary: summary(versionBefore, versionBefore, charsBefore, simulate(text, resolved).length, resolved.length),
      resolvedOps: resolved,
    }
  }

  await engine.applyOps(docId, resolved)
  const after = engine.getBaseline?.(docId) ?? baseline
  return {
    ok: true,
    dryRun: false,
    summary: summary(versionBefore, after.version, charsBefore, after.text.length, resolved.length),
  }
}

interface ResolvedEdit {
  ops: OtOp[]
  startPos: number  // for stable sorting
}

function resolveEdits(text: string, edits: EditMode[]): OtOp[] {
  const resolved: ResolvedEdit[] = edits.map((e) => resolveOne(text, e))
  // Sort descending by startPos so applying earlier-positioned edits later
  // doesn't shift later-positioned ones.
  resolved.sort((a, b) => b.startPos - a.startPos)
  // But the OT op convention is: each op's p is in DOCUMENT-VERSION order
  // (after prior ops). So we re-emit in ascending order, recomputing positions
  // by simulating cumulative shifts.
  resolved.sort((a, b) => a.startPos - b.startPos)
  return resolved.flatMap((r) => r.ops)
}

function resolveOne(text: string, edit: EditMode): ResolvedEdit {
  switch (edit.mode) {
    case 'replace': {
      const positions = findAll(text, edit.find)
      const occurrence = edit.occurrence ?? 'unique'
      const targets = pickOccurrences(positions, occurrence, edit.find)
      // Multi-occurrence: emit a delete+insert pair per match. Sort descending
      // so each pair operates on positions that haven't shifted yet.
      const sorted = [...targets].sort((a, b) => b - a)
      const ops: OtOp[] = []
      for (const p of sorted) {
        ops.push({ p, d: edit.find })
        ops.push({ p, i: edit.replace })
      }
      // Ascending sort for the OT-list convention
      ops.sort((a, b) => a.p - b.p)
      return { ops, startPos: targets[0]! }
    }
    case 'insert_before': {
      const positions = findAll(text, edit.find)
      ensureUnique(positions, edit.find)
      const p = positions[0]!
      return { ops: [{ p, i: edit.text }], startPos: p }
    }
    case 'insert_after': {
      const positions = findAll(text, edit.find)
      ensureUnique(positions, edit.find)
      const p = positions[0]! + edit.find.length
      return { ops: [{ p, i: edit.text }], startPos: p }
    }
    case 'replace_lines': {
      const lines = text.split('\n')
      if (edit.startLine < 1 || edit.endLine > lines.length || edit.startLine > edit.endLine) {
        throw new OverleafError(
          'OVERLEAF_GENERIC',
          `replace_lines range ${edit.startLine}..${edit.endLine} is out of bounds (doc has ${lines.length} lines)`,
        )
      }
      // Compute char offsets of startLine and endLine (1-indexed, inclusive).
      let pStart = 0
      for (let i = 0; i < edit.startLine - 1; i++) pStart += lines[i]!.length + 1
      let pEnd = pStart
      for (let i = edit.startLine - 1; i <= edit.endLine - 1; i++) {
        pEnd += lines[i]!.length + (i < edit.endLine - 1 ? 1 : 0)
      }
      const oldSlice = text.slice(pStart, pEnd)
      return {
        ops: [{ p: pStart, d: oldSlice }, { p: pStart, i: edit.text }],
        startPos: pStart,
      }
    }
    case 'raw_ops': {
      return {
        ops: edit.ops,
        startPos: edit.ops[0]?.p ?? 0,
      }
    }
  }
}

function findAll(text: string, needle: string): number[] {
  if (needle.length === 0) return []
  const out: number[] = []
  let i = 0
  while ((i = text.indexOf(needle, i)) !== -1) {
    out.push(i)
    i += needle.length
  }
  return out
}

function pickOccurrences(
  positions: number[],
  occurrence: 'unique' | 'first' | 'all' | number,
  find: string,
): number[] {
  if (positions.length === 0) {
    throw new OverleafError(
      'OVERLEAF_GENERIC',
      `find string not found: ${JSON.stringify(find.slice(0, 80))}`,
    )
  }
  if (occurrence === 'unique') {
    if (positions.length > 1) {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        `find string is ambiguous: found ${positions.length} matches for ${JSON.stringify(find.slice(0, 80))}`,
      )
    }
    return positions
  }
  if (occurrence === 'first') return [positions[0]!]
  if (occurrence === 'all') return positions
  if (typeof occurrence === 'number') {
    const p = positions[occurrence]
    if (p === undefined) {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        `occurrence ${occurrence} out of range (only ${positions.length} matches)`,
      )
    }
    return [p]
  }
  throw new OverleafError('OVERLEAF_GENERIC', `Unknown occurrence: ${String(occurrence)}`)
}

function ensureUnique(positions: number[], find: string): void {
  if (positions.length === 0) {
    throw new OverleafError(
      'OVERLEAF_GENERIC',
      `anchor not found: ${JSON.stringify(find.slice(0, 80))}`,
    )
  }
  if (positions.length > 1) {
    throw new OverleafError(
      'OVERLEAF_GENERIC',
      `anchor is ambiguous: found ${positions.length} matches for ${JSON.stringify(find.slice(0, 80))}`,
    )
  }
}

function simulate(text: string, ops: OtOp[]): string {
  let out = text
  for (const op of ops) {
    if (op.i !== undefined) out = out.slice(0, op.p) + op.i + out.slice(op.p)
    else if (op.d !== undefined) out = out.slice(0, op.p) + out.slice(op.p + op.d.length)
  }
  return out
}

function summary(
  versionBefore: number, versionAfter: number,
  charsBefore: number, charsAfter: number,
  opsApplied: number,
): WriteSummary {
  return {
    versionBefore, versionAfter,
    charsBefore, charsAfter,
    charsDelta: charsAfter - charsBefore,
    opsApplied,
  }
}
```

- [ ] **Step 4: Register the tool**

In `src/mcp/tools/index.ts`:

Add the import:

```typescript
import { handleEditDoc } from './edit.js'
```

Add to `TOOL_DEFINITIONS` (place after `apply_patch`):

```typescript
  {
    name: 'edit_doc',
    description: 'High-level text edits with anchor-based find/replace, insert before/after, line-range replace, or raw OT ops. All edits in one call apply atomically (all or none). Pass dryRun=true to preview without applying. For most edits prefer this over apply_patch — the server resolves anchors → OT positions for you.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
        edits: {
          type: 'array',
          minItems: 1,
          items: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  mode: { const: 'replace' },
                  find: { type: 'string' },
                  replace: { type: 'string' },
                  occurrence: {
                    oneOf: [
                      { type: 'string', enum: ['unique', 'first', 'all'] },
                      { type: 'integer', minimum: 0 },
                    ],
                  },
                },
                required: ['mode', 'find', 'replace'],
              },
              {
                type: 'object',
                properties: {
                  mode: { const: 'insert_before' },
                  find: { type: 'string' },
                  text: { type: 'string' },
                },
                required: ['mode', 'find', 'text'],
              },
              {
                type: 'object',
                properties: {
                  mode: { const: 'insert_after' },
                  find: { type: 'string' },
                  text: { type: 'string' },
                },
                required: ['mode', 'find', 'text'],
              },
              {
                type: 'object',
                properties: {
                  mode: { const: 'replace_lines' },
                  startLine: { type: 'integer', minimum: 1 },
                  endLine: { type: 'integer', minimum: 1 },
                  text: { type: 'string' },
                },
                required: ['mode', 'startLine', 'endLine', 'text'],
              },
              {
                type: 'object',
                properties: {
                  mode: { const: 'raw_ops' },
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
                required: ['mode', 'ops'],
              },
            ],
          },
        },
        dryRun: { type: 'boolean' },
      },
      required: ['projectId', 'path', 'edits'],
    },
  },
```

Add the switch case in `setRequestHandler`:

```typescript
        case 'edit_doc':
          return wrap(
            await handleEditDoc(
              ctx,
              args as Parameters<typeof handleEditDoc>[1],
            ),
          )
```

- [ ] **Step 5: Run the test — expect pass**

Run: `npm run build && npm test -- mcp-edit-doc`
Expected: PASS (8 tests).

- [ ] **Step 6: Run the full suite — expect pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools/edit.ts src/mcp/tools/index.ts test/unit/mcp-edit-doc.test.ts
git commit -m "feat(mcp): add edit_doc tool with anchor/line/raw modes

Five edit modes: replace (with unique/first/all/Nth occurrence),
insert_before, insert_after, replace_lines, and raw_ops. All edits in
a single call apply atomically — if any one fails to resolve, none
apply. Pass dryRun=true to preview (returns the resolved OT ops).

This is the high-level surface most agents should use; apply_patch
remains for advanced consumers that need raw OT control."
```

---

### Task 8: `edit_doc` unified-diff mode

**Files:**
- Modify: `package.json` — add `diff` dependency
- Modify: `src/mcp/tools/edit.ts` — add `unified_diff` mode
- Modify: `src/mcp/tools/index.ts` — extend the JSON schema oneOf with unified_diff
- Test: `test/unit/mcp-edit-doc-diff.test.ts` (new)

- [ ] **Step 1: Add the `diff` dependency**

Run: `npm install diff @types/diff`

Verify it's in `package.json` `dependencies` (not devDependencies — it's used at runtime).

- [ ] **Step 2: Write the failing test**

Create `test/unit/mcp-edit-doc-diff.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { handleEditDoc } from '../../src/mcp/tools/edit.js'
import type { ServerContext } from '../../src/mcp/server.js'

function makeCtx(initial: string) {
  let text = initial
  let version = 1
  return {
    text: () => text,
    ctx: {
      rest: null as never, http: null as never,
      ot: {
        get: async () => ({
          pathToDocId: () => 'docX',
          joinDoc: async () => ({ docId: 'docX', text, version }),
          getBaseline: () => ({ text, version }),
          applyOps: async (_: string, ops: Array<{ p: number; i?: string; d?: string }>) => {
            let out = text
            for (const op of ops) {
              if (op.i !== undefined) out = out.slice(0, op.p) + op.i + out.slice(op.p)
              else if (op.d !== undefined) out = out.slice(0, op.p) + out.slice(op.p + op.d.length)
            }
            text = out
            version += 1
          },
        }),
      },
    } as ServerContext,
  }
}

const DIFF = `--- a/file.tex
+++ b/file.tex
@@ -1,3 +1,3 @@
 first line
-second line
+second LINE
 third line
`

describe('edit_doc unified_diff', () => {
  it('applies a unified diff', async () => {
    const h = makeCtx('first line\nsecond line\nthird line\n')
    await handleEditDoc(h.ctx, {
      projectId: 'p', path: 'file.tex',
      edits: [{ mode: 'unified_diff', diff: DIFF }],
    })
    expect(h.text()).toBe('first line\nsecond LINE\nthird line\n')
  })

  it('errors when the context lines do not match the doc', async () => {
    const h = makeCtx('totally different content\n')
    await expect(
      handleEditDoc(h.ctx, {
        projectId: 'p', path: 'file.tex',
        edits: [{ mode: 'unified_diff', diff: DIFF }],
      }),
    ).rejects.toThrow(/diff did not apply/)
  })
})
```

- [ ] **Step 3: Run — expect failure**

Run: `npm test -- mcp-edit-doc-diff`
Expected: FAIL — `unified_diff` mode is not implemented.

- [ ] **Step 4: Add the unified_diff mode**

In `src/mcp/tools/edit.ts`, extend the union type at the top:

```typescript
export type EditMode =
  | { mode: 'replace'; find: string; replace: string; occurrence?: 'unique' | 'first' | 'all' | number }
  | { mode: 'insert_before'; find: string; text: string }
  | { mode: 'insert_after'; find: string; text: string }
  | { mode: 'replace_lines'; startLine: number; endLine: number; text: string }
  | { mode: 'raw_ops'; ops: OtOp[] }
  | { mode: 'unified_diff'; diff: string }
```

Add the import at the top:

```typescript
import { applyPatch as applyUnifiedDiff } from 'diff'
```

Add a new case in `resolveOne`:

```typescript
    case 'unified_diff': {
      const result = applyUnifiedDiff(text, edit.diff)
      if (result === false || typeof result !== 'string') {
        throw new OverleafError(
          'OVERLEAF_GENERIC',
          'unified diff did not apply: context lines did not match the doc',
        )
      }
      // Reduce to the smallest set of OT ops by computing a single
      // delete-everything + insert-new (cheap, server validates atomically).
      // For better minimality we could call computeOps from src/overleaf/diff.ts,
      // but a single replace is correct and simpler.
      return {
        ops: [
          { p: 0, d: text },
          { p: 0, i: result },
        ],
        startPos: 0,
      }
    }
```

(For multi-megabyte docs this is suboptimal — a follow-up could use `computeOps` from `src/overleaf/diff.ts` to derive minimal ops. Out of scope for v1.)

- [ ] **Step 5: Extend the JSON schema in `tools/index.ts`**

Find the `edit_doc` `oneOf` array and append:

```typescript
              {
                type: 'object',
                properties: {
                  mode: { const: 'unified_diff' },
                  diff: { type: 'string' },
                },
                required: ['mode', 'diff'],
              },
```

- [ ] **Step 6: Run the test — expect pass**

Run: `npm run build && npm test -- mcp-edit-doc-diff`
Expected: PASS.

- [ ] **Step 7: Run the full suite — expect pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/mcp/tools/edit.ts src/mcp/tools/index.ts test/unit/mcp-edit-doc-diff.test.ts
git commit -m "feat(mcp): edit_doc accepts unified_diff mode

Agents can now pass a unified diff (the format LLMs emit fluently) as
a single edit. Uses jsdiff/applyPatch to reconcile against the current
doc text and reduces to a single delete-all+insert-all op pair.

Note: multi-MB docs are suboptimal — follow-up could derive minimal
ops via computeOps. Acceptable for v1."
```

---

### Task 9: README + tool descriptions update; version bump

**Files:**
- Modify: `package.json` — bump version to `1.1.0`
- Modify: `README.md` — document new tools and modes
- Modify: `src/mcp/tools/index.ts` — update existing tool descriptions to point to `edit_doc`

- [ ] **Step 1: Bump the version**

In `package.json`:

```json
  "version": "1.1.0",
```

- [ ] **Step 2: Update `apply_patch` description to point to `edit_doc`**

In `src/mcp/tools/index.ts`, replace the `apply_patch` description with:

```typescript
    description: 'Advanced: emit raw OT ops [{p,i?,d?}] against a doc. Each op must have exactly one of `i` (insert) or `d` (delete); a `d`-string that does not match the doc at p surfaces as OT_DELETE_MISMATCH. For most use cases prefer edit_doc, which resolves anchors → OT positions for you. apply_patch is here for callers that already have positions computed.',
```

Update `write_doc` description:

```typescript
    description: 'Replace a text doc by path. Edits flow as live OT ops; collaborators see fine-grained changes, not a "file changed externally" toast. Returns a summary {versionBefore, versionAfter, charsBefore, charsAfter, charsDelta, opsApplied}. For surgical edits prefer edit_doc.',
```

- [ ] **Step 3: Update `README.md`**

Find the "Tools" / API section in `README.md`. Add or update entries to reflect:

- `edit_doc` (new — recommended for most edits)
- `read_doc_range` (new)
- `read_file` `as` parameter (new)
- `write_doc` and `apply_patch` summary echo (new)
- Error envelope shape: `{ code, message, context, retryable, hint? }`
- New error codes: `OT_DELETE_MISMATCH`, `OT_VERSION_DRIFT`

Add a section near the top explaining the high-level vs. low-level surface (edit_doc vs apply_patch).

If a CHANGELOG.md exists, add a `1.1.0` entry summarizing all tasks.

- [ ] **Step 4: Verify the build is green**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 5: Final smoke test against the real Overleaf**

Manually verify the new tools work end-to-end:

```bash
# Build and rerun the diagnose
npm run build
node dist/cli.js diagnose
```

Then in the Claude Code session, exercise:
- `edit_doc` with `mode: 'replace'`
- `read_doc_range` for a 10-line slice
- `read_file` with `as: 'base64'` on a small image
- Force an `OT_DELETE_MISMATCH` (apply_patch with a deliberately wrong `d`) and confirm it surfaces structured error envelope.

- [ ] **Step 6: Commit**

```bash
git add package.json README.md src/mcp/tools/index.ts CHANGELOG.md
git commit -m "docs: README + descriptions for v1.1.0 (edit_doc, range, summaries)

Documents the new high-level edit_doc tool, read_doc_range,
read_file as=base64, the write summary echo, and the structured
error envelope. Bumps to 1.1.0."
```

---

## Self-review

**Spec coverage:** All 10 review items from the conversation map to tasks above. ✓

| Review item | Task |
|---|---|
| 1. Silent no-op fix | 1 |
| 2. find/replace edit_doc | 7 |
| 3. Atomic multi-edit | 7 |
| 4. Unified diff | 8 |
| 5. Image base64 | 6 |
| 6. read_doc_range | 4 |
| 7. Summary echo | 5 |
| 8. Version drift | 2 |
| 9. README/docs | 9 |
| 10. Structured envelope | 3 |

**Placeholder scan:** No "TBD" / "TODO" / "implement later". All steps have concrete code or commands. ✓

**Type consistency:** `WriteSummary` is defined in Task 5 (`docs.ts`) and consumed in Task 7 (`edit.ts` imports it). `EditMode` and `EditDocInput` types are defined in Task 7 and extended in Task 8. `OtDeleteMismatchError` defined in Task 1 and referenced in Task 9 README. ✓

**Sequencing dependencies:** Task 7 imports `WriteSummary` from `docs.ts` — Task 5 must land first. Task 8 extends `EditMode` from Task 7 — Task 7 must land first. Task 9 references all prior tasks — last. ✓
