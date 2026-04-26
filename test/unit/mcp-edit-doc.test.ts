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

  it('replaces all occurrences correctly when replacement is shorter than find', async () => {
    const h = makeCtx('foo foo foo')
    await handleEditDoc(h.ctx, {
      projectId: 'p', path: 'a.tex',
      edits: [{ mode: 'replace', find: 'foo', replace: 'X', occurrence: 'all' }],
    })
    expect(h.text()).toBe('X X X')
  })

  it('replaces all occurrences correctly when replacement is longer than find', async () => {
    const h = makeCtx('a b a b')
    await handleEditDoc(h.ctx, {
      projectId: 'p', path: 'a.tex',
      edits: [{ mode: 'replace', find: 'a', replace: 'AAA', occurrence: 'all' }],
    })
    expect(h.text()).toBe('AAA b AAA b')
  })
})

describe('edit_doc multi-edit success', () => {
  it('applies multiple anchor edits correctly with length-changing replacements', async () => {
    const h = makeCtx('alpha beta gamma')
    await handleEditDoc(h.ctx, {
      projectId: 'p', path: 'a.tex',
      edits: [
        { mode: 'replace', find: 'alpha', replace: 'A' },
        { mode: 'replace', find: 'gamma', replace: 'GGG' },
      ],
    })
    expect(h.text()).toBe('A beta GGG')
  })
})

describe('edit_doc raw_ops safety', () => {
  it('rejects mixing raw_ops with anchor-based modes', async () => {
    const h = makeCtx('hello world')
    await expect(
      handleEditDoc(h.ctx, {
        projectId: 'p', path: 'a.tex',
        edits: [
          { mode: 'replace', find: 'hello', replace: 'HI' },
          { mode: 'raw_ops', ops: [{ p: 0, i: 'X' }] },
        ],
      }),
    ).rejects.toThrow(/cannot mix raw_ops/)
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
