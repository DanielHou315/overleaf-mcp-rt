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
