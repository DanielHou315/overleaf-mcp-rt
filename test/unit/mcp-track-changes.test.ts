import { describe, it, expect, afterEach, vi } from 'vitest'
import { buildContext } from '../../src/mcp/server.js'
import { TRACKED_NOTE } from '../../src/mcp/tools/edit.js'
import { connectAgent, existingChanges, makeToolHarness, REVIEW_PANEL, STOCK_CE, TC_SEED } from './fake-overleaf.js'

/** A real MCP client on the real dispatcher, against the fake server. */
async function agent(
  docs: Record<string, string>,
  opts: Parameters<typeof makeToolHarness>[1] = {},
  engineOpts: Parameters<typeof makeToolHarness>[2] = {},
) {
  const harness = await makeToolHarness(docs, opts, engineOpts)
  return { ...harness, ...(await connectAgent(harness.ctx)) }
}

describe('trackChanges on overleaf_edit_doc and overleaf_write_doc', () => {
  it('is offered by both tools', async () => {
    const { client } = await agent({ main: '' })
    const { tools } = await client.listTools()
    for (const name of ['overleaf_edit_doc', 'overleaf_write_doc']) {
      const tool = tools.find((t) => t.name === name)!
      expect((tool.inputSchema.properties as Record<string, { type: string }>).trackChanges?.type, name).toBe('boolean')
      expect(tool.description, name).toContain('trackChanges')
    }
  })

  it('overleaf_edit_doc sends the edit as tracked changes and says so', async () => {
    const { server, call } = await agent({ main: 'Results are good.' }, { features: REVIEW_PANEL })
    const edit = await call('overleaf_edit_doc', {
      path: 'main.tex', trackChanges: true, edits: [{ old_string: 'good', new_string: 'excellent' }],
    })
    expect(edit.isError).toBe(false)
    expect(edit.json.tracked).toBe(true)
    expect(edit.json.notes).toEqual(expect.arrayContaining([TRACKED_NOTE]))
    expect(edit.json.diff).toContain('+Results are excellent.')
    expect(server.text('main')).toBe('Results are excellent.')
    expect(server.sentUpdates()[0]!.meta).toEqual({ tc: expect.stringMatching(TC_SEED) })
    expect(server.changes('main').map((c) => c.op)).toEqual([{ p: 12, d: 'good' }, { p: 12, i: 'excellent' }])
  })

  it('overleaf_write_doc sends the rewrite as tracked changes and says so', async () => {
    const { server, call } = await agent({ main: 'Old text.' }, { features: REVIEW_PANEL })
    await call('overleaf_read_doc', { path: 'main.tex' })
    const write = await call('overleaf_write_doc', { path: 'main.tex', content: 'New text.', trackChanges: true })
    expect(write.isError).toBe(false)
    expect(write.json.tracked).toBe(true)
    expect(write.json.notes).toEqual(expect.arrayContaining([TRACKED_NOTE]))
    expect(server.text('main')).toBe('New text.')
    expect(server.sentUpdates()[0]!.meta?.tc).toMatch(TC_SEED)
  })

  it('without it, edits are direct and results are as before', async () => {
    const { server, call } = await agent({ main: 'a b' }, { features: REVIEW_PANEL })
    await call('overleaf_read_doc', { path: 'main.tex' })
    const edit = await call('overleaf_edit_doc', { path: 'main.tex', edits: [{ old_string: 'a', new_string: 'A' }] })
    const write = await call('overleaf_write_doc', { path: 'main.tex', content: 'A B' })
    for (const res of [edit, write]) {
      expect(res.isError).toBe(false)
      expect(res.json.tracked).toBeUndefined()
      expect(res.json.notes).toBeUndefined()
    }
    expect(server.sentUpdates().map((u) => u.meta)).toEqual([undefined, undefined])
    expect(server.changes('main')).toEqual([])
  })

  it('the session default (OVERLEAF_TRACK_CHANGES=1) tracks edits; trackChanges=false still edits directly', async () => {
    const { server, ctx, call } = await agent({ main: 'a b c' }, { features: REVIEW_PANEL })
    ctx.trackChanges = true // what OVERLEAF_TRACK_CHANGES=1 sets
    await call('overleaf_read_doc', { path: 'main.tex' })
    const byDefault = await call('overleaf_edit_doc', { path: 'main.tex', edits: [{ old_string: 'a', new_string: 'A' }] })
    const direct = await call('overleaf_edit_doc', { path: 'main.tex', trackChanges: false, edits: [{ old_string: 'c', new_string: 'C' }] })
    const written = await call('overleaf_write_doc', { path: 'main.tex', content: 'A b C!' })
    const writtenDirect = await call('overleaf_write_doc', { path: 'main.tex', content: 'A b C!?', trackChanges: false })

    expect(byDefault.json.tracked).toBe(true)
    expect(direct.json.tracked).toBeUndefined()
    expect(written.json.tracked).toBe(true)
    expect(writtenDirect.json.tracked).toBeUndefined()
    const seeds = server.sentUpdates().map((u) => u.meta?.tc)
    expect(seeds[0]).toMatch(TC_SEED)
    expect(seeds[1]).toBeUndefined()
    expect(seeds[2]).toMatch(TC_SEED)
    expect(seeds[3]).toBeUndefined()
    expect(server.text('main')).toBe('A b C!?')
  })

  it('dryRun previews a tracked edit without sending it', async () => {
    const { server, call } = await agent({ main: 'hello' }, { features: REVIEW_PANEL })
    const preview = await call('overleaf_edit_doc', {
      path: 'main.tex', trackChanges: true, dryRun: true, edits: [{ old_string: 'hello', new_string: 'hi' }],
    })
    expect(preview.isError).toBe(false)
    expect(preview.json).toMatchObject({ dryRun: true, tracked: true })
    expect(server.sentUpdates()).toEqual([])
  })

  it('a stock Community Edition refuses with TRACK_CHANGES_UNSUPPORTED and a hint, also on dryRun, and nothing changes', async () => {
    const { server, call } = await agent({ main: 'hello' }, { features: STOCK_CE })
    await call('overleaf_read_doc', { path: 'main.tex' })
    const edits = [{ old_string: 'hello', new_string: 'hi' }]
    const refusals = [
      await call('overleaf_edit_doc', { path: 'main.tex', trackChanges: true, edits }),
      await call('overleaf_edit_doc', { path: 'main.tex', trackChanges: true, dryRun: true, edits }),
      await call('overleaf_write_doc', { path: 'main.tex', trackChanges: true, content: 'hi' }),
    ]
    for (const res of refusals) {
      expect(res.isError).toBe(true)
      expect(res.json.code).toBe('TRACK_CHANGES_UNSUPPORTED')
      expect(res.json.message).toMatch(/no review panel/)
      expect(res.json.hint).toMatch(/trackChanges=false/)
    }
    expect(server.sentUpdates()).toEqual([])
    expect(server.text('main')).toBe('hello')
  })

  it('a document in Overleaf\'s newer format refuses the same way', async () => {
    const { server, call } = await agent({ main: 'hello' }, { historyOt: true, features: REVIEW_PANEL })
    const res = await call('overleaf_edit_doc', { path: 'main.tex', trackChanges: true, edits: [{ old_string: 'hello', new_string: 'hi' }] })
    expect(res.isError).toBe(true)
    expect(res.json.code).toBe('TRACK_CHANGES_UNSUPPORTED')
    expect(res.json.message).toMatch(/history-OT/)
    expect(server.sentUpdates()).toEqual([])
  })

  it('there, with direct edits off as they are by default, it says a direct edit is no way out either', async () => {
    const { call } = await agent({ main: 'hello' }, { historyOt: true, features: REVIEW_PANEL }, { historyOtWrites: false })
    const res = await call('overleaf_edit_doc', { path: 'main.tex', trackChanges: true, edits: [{ old_string: 'hello', new_string: 'hi' }] })
    expect(res.json.code).toBe('TRACK_CHANGES_UNSUPPORTED')
    expect(res.json.message).toMatch(/OVERLEAF_HISTORY_OT_WRITES=1/)
    expect(res.json.context.directEditPossible).toBe(false)
    expect(res.json.hint).toMatch(/If the message says a direct edit is possible/)
  })

  it('a document at the tracked-change limit refuses with TRACK_CHANGES_LIMIT and a hint, on dryRun too', async () => {
    const { server, call } = await agent({ main: 'hello' }, { features: REVIEW_PANEL, ranges: { main: { changes: existingChanges(1990) } } })
    const edits = [{ old_string: 'hello', new_string: 'hi' }]
    for (const dryRun of [true, false]) {
      const res = await call('overleaf_edit_doc', { path: 'main.tex', trackChanges: true, dryRun, edits })
      expect(res.isError, `dryRun: ${dryRun}`).toBe(true)
      expect(res.json.code).toBe('TRACK_CHANGES_LIMIT')
      expect(res.json.context.limit).toBe('changes')
      expect(res.json.hint).toMatch(/accept or reject/)
      expect(res.json.hint, 'an untracked edit is no way around the limit').not.toMatch(/trackChanges/)
    }
    expect(server.sentUpdates()).toEqual([])
  })

  it('refuses a trackChanges that is not true or false, before anything is sent', async () => {
    const { server, call } = await agent({ main: 'hello' }, { features: REVIEW_PANEL })
    await call('overleaf_read_doc', { path: 'main.tex' })
    const edits = [{ old_string: 'hello', new_string: 'hi' }]
    const refusals = [
      await call('overleaf_edit_doc', { path: 'main.tex', trackChanges: 'true', edits }),
      await call('overleaf_edit_doc', { path: 'main.tex', trackChanges: 'false', dryRun: true, edits }),
      await call('overleaf_write_doc', { path: 'main.tex', trackChanges: 1, content: 'hi' }),
    ]
    for (const res of refusals) {
      expect(res.isError).toBe(true)
      expect(res.json.message).toMatch(/trackChanges must be true or false/)
    }
    expect(server.sentUpdates()).toEqual([])
    expect(server.text('main')).toBe('hello')
  })
})

describe('OVERLEAF_TRACK_CHANGES', () => {
  afterEach(() => vi.unstubAllEnvs())
  const options = { url: 'https://o.example', sessionCookie: 'overleaf_session2=abc', extraHeaders: {}, debug: false, csrfToken: 'csrf' }

  it('=1 makes tracked changes the session default; anything else leaves it off', () => {
    vi.stubEnv('OVERLEAF_TRACK_CHANGES', '')
    expect(buildContext(options).trackChanges).toBe(false)
    vi.stubEnv('OVERLEAF_TRACK_CHANGES', '0')
    expect(buildContext(options).trackChanges).toBe(false)
    vi.stubEnv('OVERLEAF_TRACK_CHANGES', '1')
    expect(buildContext(options).trackChanges).toBe(true)
  })
})
