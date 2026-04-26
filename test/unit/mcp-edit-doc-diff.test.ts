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

  it('rejects mixing unified_diff with anchor-based modes', async () => {
    const h = makeCtx('first line\nsecond line\n')
    await expect(
      handleEditDoc(h.ctx, {
        projectId: 'p', path: 'file.tex',
        edits: [
          { mode: 'replace', find: 'first', replace: 'FIRST' },
          { mode: 'unified_diff', diff: DIFF },
        ],
      }),
    ).rejects.toThrow(/cannot mix raw_ops or unified_diff/)
  })

  it('rejects mixing unified_diff with raw_ops', async () => {
    const h = makeCtx('hello\n')
    await expect(
      handleEditDoc(h.ctx, {
        projectId: 'p', path: 'file.tex',
        edits: [
          { mode: 'unified_diff', diff: DIFF },
          { mode: 'raw_ops', ops: [{ p: 0, i: 'X' }] },
        ],
      }),
    ).rejects.toThrow(/at most one raw_ops or unified_diff/)
  })

  const DIFF_NO_TRAILING_NEWLINE = `--- a/file.tex
+++ b/file.tex
@@ -1,2 +1,2 @@
 first line
-second line
\\ No newline at end of file
+second LINE
\\ No newline at end of file
`

  it('applies a unified diff to a doc with no trailing newline', async () => {
    const h = makeCtx('first line\nsecond line')
    await handleEditDoc(h.ctx, {
      projectId: 'p', path: 'file.tex',
      edits: [{ mode: 'unified_diff', diff: DIFF_NO_TRAILING_NEWLINE }],
    })
    expect(h.text()).toBe('first line\nsecond LINE')
  })
})
