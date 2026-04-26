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

  it('rejects when both startLine and startOffset are provided', async () => {
    await expect(
      handleReadDocRange(makeCtx(text), {
        projectId: 'p', path: 'a.tex', startLine: 1, startOffset: 0,
      }),
    ).rejects.toThrow(/not both/)
  })

  it('rejects when endLine < startLine', async () => {
    await expect(
      handleReadDocRange(makeCtx(text), {
        projectId: 'p', path: 'a.tex', startLine: 5, endLine: 2,
      }),
    ).rejects.toThrow(/before startLine/)
  })
})
