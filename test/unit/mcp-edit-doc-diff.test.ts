import { describe, it, expect } from 'vitest'
import { handleEditDoc } from '../../src/mcp/tools/edit.js'
import { makeToolHarness } from './fake-overleaf.js'

async function makeCtx(initial: string) {
  // Real engine against a fake Overleaf, so tool tests exercise the wire protocol too.
  const h = await makeToolHarness({ file: initial }, { startVersion: 1 })
  return {
    ...h,
    text: () => h.server.text('file'),
    version: () => h.server.docs.get('file')!.version,
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
    const h = await makeCtx('first line\nsecond line\nthird line\n')
    await handleEditDoc(h.ctx, {
      projectId: 'p', path: 'file.tex',
      edits: [{ mode: 'unified_diff', diff: DIFF }],
    })
    expect(h.text()).toBe('first line\nsecond LINE\nthird line\n')
  })

  it('errors when the context lines do not match the doc', async () => {
    const h = await makeCtx('totally different content\n')
    await expect(
      handleEditDoc(h.ctx, {
        projectId: 'p', path: 'file.tex',
        edits: [{ mode: 'unified_diff', diff: DIFF }],
      }),
    ).rejects.toThrow(/diff did not apply/)
  })

  it('rejects mixing unified_diff with anchor-based modes', async () => {
    const h = await makeCtx('first line\nsecond line\n')
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
    const h = await makeCtx('hello\n')
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
    const h = await makeCtx('first line\nsecond line')
    await handleEditDoc(h.ctx, {
      projectId: 'p', path: 'file.tex',
      edits: [{ mode: 'unified_diff', diff: DIFF_NO_TRAILING_NEWLINE }],
    })
    expect(h.text()).toBe('first line\nsecond LINE')
  })
})
