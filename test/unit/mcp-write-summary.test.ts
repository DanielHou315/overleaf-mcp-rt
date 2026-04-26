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
            if (newText === text) return  // mirror OtEngine.writeDoc no-op
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

  it('reports zero charsDelta and unchanged version when content equals current text', async () => {
    const harness = makeCtx('hello')
    const out = await handleWriteDoc(harness.ctx, { projectId: 'p', path: 'a.tex', content: 'hello' })
    expect(out.summary?.charsBefore).toBe(5)
    expect(out.summary?.charsAfter).toBe(5)
    expect(out.summary?.charsDelta).toBe(0)
    expect(out.summary?.versionBefore).toBe(3)
    expect(out.summary?.versionAfter).toBe(3)  // no bump on no-op
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
