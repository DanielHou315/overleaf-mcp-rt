import { describe, it, expect } from 'vitest'
import { handleReadDoc, handleWriteDoc } from '../../src/mcp/tools/docs.js'
import { makeToolHarness } from './fake-overleaf.js'

async function makeCtx(initial: string) {
  // Real engine against a fake Overleaf, so tool tests exercise the wire protocol too.
  const h = await makeToolHarness({ a: initial }, { startVersion: 3 })
  return {
    ...h,
    text: () => h.server.text('a'),
    version: () => h.server.docs.get('a')!.version,
  }
}

describe('write_doc summary', () => {
  it('returns charsBefore, charsAfter, versionBefore, versionAfter, charsDelta', async () => {
    const harness = await makeCtx('hello')
    await handleReadDoc(harness.ctx, { projectId: 'p', path: 'a.tex' })
    const out = await handleWriteDoc(harness.ctx, { projectId: 'p', path: 'a.tex', content: 'hello world' })
    expect(out.ok).toBe(true)
    expect(out.summary?.charsBefore).toBe(5)
    expect(out.summary?.charsAfter).toBe(11)
    expect(out.summary?.charsDelta).toBe(6)
    expect(out.summary?.versionBefore).toBe(3)
    expect(out.summary?.versionAfter).toBe(4)
  })

  it('reports zero charsDelta and unchanged version when content equals current text', async () => {
    const harness = await makeCtx('hello')
    await handleReadDoc(harness.ctx, { projectId: 'p', path: 'a.tex' })
    const out = await handleWriteDoc(harness.ctx, { projectId: 'p', path: 'a.tex', content: 'hello' })
    expect(out.summary?.charsBefore).toBe(5)
    expect(out.summary?.charsAfter).toBe(5)
    expect(out.summary?.charsDelta).toBe(0)
    expect(out.summary?.versionBefore).toBe(3)
    expect(out.summary?.versionAfter).toBe(3)  // no bump on no-op
  })

  it('refuses to overwrite a doc the agent has not read', async () => {
    const harness = await makeCtx('precious human text')
    await expect(
      handleWriteDoc(harness.ctx, { projectId: 'p', path: 'a.tex', content: 'clobber' }),
    ).rejects.toMatchObject({ code: 'DOC_NOT_READ' })
    expect(harness.text()).toBe('precious human text')
  })

  it('refuses to overwrite when a collaborator edited the doc after the last read', async () => {
    const harness = await makeCtx('hello')
    await handleReadDoc(harness.ctx, { projectId: 'p', path: 'a.tex' })
    harness.server.remoteEdit('a', [{ p: 5, i: ' from the browser' }])
    await expect(
      handleWriteDoc(harness.ctx, { projectId: 'p', path: 'a.tex', content: 'hello world' }),
    ).rejects.toMatchObject({ code: 'DOC_CHANGED_EXTERNALLY' })
    expect(harness.text()).toBe('hello from the browser')
  })

  it('overwrite=true bypasses both guards', async () => {
    const harness = await makeCtx('old')
    await handleWriteDoc(harness.ctx, { projectId: 'p', path: 'a.tex', content: 'new', overwrite: true })
    expect(harness.text()).toBe('new')
  })

  it('writes a new empty doc without requiring a read', async () => {
    const harness = await makeCtx('')
    await handleWriteDoc(harness.ctx, { projectId: 'p', path: 'a.tex', content: 'fresh' })
    expect(harness.text()).toBe('fresh')
  })
})
