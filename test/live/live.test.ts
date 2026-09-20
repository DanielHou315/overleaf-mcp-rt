import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { acquireTarget, startAgent, joinAsHuman, freshRead, sleep, liveEnabled, isBootstrap, type Agent, type ProjectKind, type Target } from './helpers.js'

/**
 * The live suite: the built server (`dist/cli.js`, over stdio) against a real
 * Overleaf. Run by test/live/run-matrix.sh against throw-away CE instances, or
 * by hand against a configured host (see test/live/README.md). Everything
 * happens inside one scratch folder, which is deleted at the end.
 */

// Be a polite guest on instances we don't own.
const PACE_MS = isBootstrap ? 0 : 400
const pace = () => (PACE_MS ? sleep(PACE_MS) : Promise.resolve())

/**
 * On a throw-away instance the whole suite runs twice: against a project on the
 * classic ShareJS protocol, and — where the server has it (LIVE_HISTORY_OT=1, set
 * by run-matrix.sh from versions.conf) — against one switched to history-ot.
 * On a configured host it runs once, against whatever the named project speaks.
 */
const kinds: ProjectKind[] = isBootstrap && process.env.LIVE_HISTORY_OT === '1'
  ? ['sharejs-text-ot', 'history-ot']
  : ['sharejs-text-ot']
const version = process.env.LIVE_EXPECT_VERSION ? ` CE ${process.env.LIVE_EXPECT_VERSION}` : ''

describe.skipIf(!liveEnabled || process.env.LIVE_PHASE === 'bootstrap').each(kinds)(`live Overleaf${version} — %s project`, (kind) => {
  let target: Target
  let agent: Agent
  let projectId: string
  let dir: string

  beforeAll(async () => {
    target = await acquireTarget(kind)
    projectId = target.projectId
    dir = target.scratch
    agent = await startAgent(target)
    const made = await agent.call('overleaf_create_folder', { projectId, parentPath: '', name: dir })
    expect(made.ok, made.text).toBe(true)
  }, 10 * 60_000)

  afterAll(async () => {
    if (!agent) return
    await agent.call('overleaf_delete_entity', { projectId, path: dir }).catch(() => undefined)
    await agent.close()
  }, 60_000)

  async function newDoc(name: string, content: string): Promise<string> {
    const path = `${dir}/${name}`
    const created = await agent.call('overleaf_create_doc', { projectId, parentPath: dir, name })
    expect(created.ok, created.text).toBe(true)
    const written = await agent.call('overleaf_write_doc', { projectId, path, content })
    expect(written.ok, written.text).toBe(true)
    return path
  }

  it('starts, exposes the full tool surface and sees the project', async () => {
    expect((await agent.tools()).length).toBe(22)
    const projects = await agent.call('overleaf_list_projects')
    expect(projects.ok, projects.text).toBe(true)
    expect(projects.text).toContain(projectId)
    const tree = await agent.call('overleaf_get_project_tree', { projectId })
    expect(tree.ok, tree.text).toBe(true)
    expect(tree.text).toContain(dir)
  }, 60_000)

  it('creates, renames, moves and deletes entities', async () => {
    await newDoc('tree-a.tex', 'a\n')
    expect((await agent.call('overleaf_create_folder', { projectId, parentPath: dir, name: 'sub' })).ok).toBe(true)
    await pace()
    const renamed = await agent.call('overleaf_rename', { projectId, path: `${dir}/tree-a.tex`, newName: 'tree-b.tex' })
    expect(renamed.ok, renamed.text).toBe(true)
    await pace()
    const moved = await agent.call('overleaf_move', { projectId, path: `${dir}/tree-b.tex`, newParentPath: `${dir}/sub` })
    expect(moved.ok, moved.text).toBe(true)
    const read = await agent.call('overleaf_read_doc', { projectId, path: `${dir}/sub/tree-b.tex` })
    expect(read.json.content).toBe('a\n')
    await pace()
    expect((await agent.call('overleaf_delete_entity', { projectId, path: `${dir}/sub` })).ok).toBe(true)
    const gone = await agent.call('overleaf_read_doc', { projectId, path: `${dir}/sub/tree-b.tex` })
    expect(gone.ok).toBe(false)
  }, 120_000)

  it('applies string edits that a fresh connection reads back byte-for-byte, including non-ASCII text', async () => {
    const original = [
      '\\section{Résumé}',
      'Naïve café — “quotes”, 数学, and a symbol ✓ before the target.',
      '    indented line with   odd   spacing',
      'repeat repeat repeat',
      '',
    ].join('\n')
    const path = await newDoc('edits.tex', original)

    const edited = await agent.call('overleaf_edit_doc', {
      projectId, path,
      edits: [
        { old_string: 'before the target', new_string: 'before the 目标 ✗' },
        // Sequential: the second edit sees the first one's result.
        { old_string: '目标 ✗.', new_string: '目标 ✗!' },
        { old_string: 'repeat', new_string: 'again', replace_all: true },
      ],
    })
    expect(edited.ok, edited.text).toBe(true)
    await pace()

    // Whitespace-tolerant fallback: wrong indentation and collapsed spaces still find the line.
    const fuzzy = await agent.call('overleaf_edit_doc', {
      projectId, path,
      edits: [{ old_string: 'indented line with odd spacing', new_string: 'tidy line' }],
    })
    expect(fuzzy.ok, fuzzy.text).toBe(true)

    const missing = await agent.call('overleaf_edit_doc', { projectId, path, edits: [{ old_string: 'not in the document at all', new_string: 'x' }] })
    expect(missing.ok).toBe(false)
    expect(missing.json.code).toBe('EDIT_NO_MATCH')
    const ambiguous = await agent.call('overleaf_edit_doc', { projectId, path, edits: [{ old_string: 'again', new_string: 'x' }] })
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.json.code).toBe('EDIT_AMBIGUOUS')

    const expected = original
      .replace('before the target.', 'before the 目标 ✗!')
      .replaceAll('repeat', 'again')
      .replace('indented line with   odd   spacing', 'tidy line')
    const stored = await freshRead(target, path)
    expect(stored).toBe(expected)
    expect((await agent.call('overleaf_read_doc', { projectId, path })).json.content).toBe(stored)
  }, 120_000)

  it('stays in step with the server over characters Overleaf cannot store (emoji)', async () => {
    // Overleaf rewrites non-BMP characters to U+FFFD and doesn't tell the sender. If our
    // snapshot kept the emoji, the delete below would be rejected — and a rejected op
    // disconnects everyone on the doc, so a bystander is watching for exactly that.
    const path = await newDoc('astral.tex', 'Result: pending.\n')
    const bystander = await joinAsHuman(target)
    try {
      const { id: docId } = await bystander.engine.waitForPath(path, 5000)
      await bystander.engine.openDoc(docId)

      const wrote = await agent.call('overleaf_edit_doc', { projectId, path, edits: [{ old_string: 'pending', new_string: 'passed 🎓' }] })
      expect(wrote.ok, wrote.text).toBe(true)
      expect(wrote.json.notes.join(' ')).toMatch(/cannot store characters outside the Basic Multilingual Plane/)
      expect(await freshRead(target, path)).toBe('Result: passed \uFFFD\uFFFD.\n')
      expect((await agent.call('overleaf_read_doc', { projectId, path })).json.content).toBe('Result: passed \uFFFD\uFFFD.\n')
      await pace()

      const across = await agent.call('overleaf_edit_doc', { projectId, path, edits: [{ old_string: 'passed \uFFFD\uFFFD.', new_string: 'done.' }] })
      expect(across.ok, across.text).toBe(true)
      await sleep(800)
      expect(await freshRead(target, path)).toBe('Result: done.\n')
      expect(bystander.engine.readDoc(docId)).toBe('Result: done.\n')
      expect(bystander.otErrors).toEqual([])
      expect(bystander.disconnects).toBe(0)
    } finally {
      bystander.close()
    }
  }, 120_000)

  it('edits a doc while someone else is typing in it: nobody is kicked out, nothing is lost, both converge', async () => {
    const slots = Array.from({ length: 8 }, (_, i) => `\\item slot-${i}`)
    const path = await newDoc('coedit.tex', ['% co-editing', ...slots, 'HUMAN><HUMAN AGENT><AGENT', ''].join('\n'))

    const human = await joinAsHuman(target)
    try {
      const { id: docId } = await human.engine.waitForPath(path, 5000)
      const opened = await human.engine.openDoc(docId)
      // Make sure the run exercises the protocol it claims to.
      if (isBootstrap) expect(opened.otType).toBe(kind)

      const typed = 'the quick brown fox jumps over the lazy dog'
      const typing = (async () => {
        for (const ch of typed) {
          await human.engine.updateDoc(docId, (text) => text.replace('<HUMAN', `${ch}<HUMAN`))
          await sleep(60 + PACE_MS / 4)
        }
      })()

      const results = []
      for (let i = 0; i < slots.length; i++) {
        // Alternate between other lines and the very line the human is typing in.
        results.push(await agent.call('overleaf_edit_doc', { projectId, path, edits: [{ old_string: `slot-${i}`, new_string: `done-${i}` }] }))
        results.push(await agent.call('overleaf_edit_doc', { projectId, path, edits: [{ old_string: '<AGENT', new_string: `${i}<AGENT` }] }))
        await pace()
      }
      await typing
      for (const r of results) expect(r.ok, r.text).toBe(true)

      // Let the last acknowledgements and broadcasts land.
      await sleep(1500)
      const agentView = (await agent.call('overleaf_read_doc', { projectId, path })).json.content as string
      const humanView = human.engine.readDoc(docId)
      const stored = await freshRead(target, path)

      expect(human.otErrors).toEqual([])
      expect(human.disconnects).toBe(0)
      expect(humanView).toBe(stored)
      expect(agentView).toBe(stored)
      expect(stored).toContain(`HUMAN>${typed}<HUMAN`)
      expect(stored).toContain('AGENT>01234567<AGENT')
      for (let i = 0; i < slots.length; i++) expect(stored).toContain(`\\item done-${i}`)
      expect(stored).not.toContain('slot-')
      // The agent was told what the other person typed.
      expect(results.some((r) => r.text.includes('<external-changes>'))).toBe(true)
    } finally {
      human.close()
    }
  }, 180_000)

  it('refuses to overwrite text the agent has not seen, unless told to', async () => {
    const path = await newDoc('guard.tex', 'first line\n')
    const human = await joinAsHuman(target)
    try {
      const { id: docId } = await human.engine.waitForPath(path, 5000)
      await human.engine.openDoc(docId)
      await human.engine.updateDoc(docId, (text) => text + 'typed by a person\n')
      await sleep(800)

      const clobber = await agent.call('overleaf_write_doc', { projectId, path, content: 'agent rewrite\n' })
      expect(clobber.ok).toBe(false)
      expect(clobber.json.code).toBe('DOC_CHANGED_EXTERNALLY')
      expect(clobber.text).toContain('typed by a person')
      expect(await freshRead(target, path)).toBe('first line\ntyped by a person\n')

      await pace()
      const forced = await agent.call('overleaf_write_doc', { projectId, path, content: 'agent rewrite\n', overwrite: true })
      expect(forced.ok, forced.text).toBe(true)
      await sleep(800)
      expect(human.engine.readDoc(docId)).toBe('agent rewrite\n')
      expect(human.otErrors).toEqual([])
      expect(human.disconnects).toBe(0)
    } finally {
      human.close()
    }
  }, 120_000)

  it('uploads a binary file and reads it back', async () => {
    // 1×1 transparent PNG
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
    const up = await agent.call('overleaf_upload_file', { projectId, parentPath: dir, name: 'dot.png', contentBase64: png })
    expect(up.ok, up.text).toBe(true)
    await pace()
    const back = await agent.call('overleaf_read_file', { projectId, path: `${dir}/dot.png`, as: 'base64' })
    expect(back.ok, back.text).toBe(true)
    expect(back.json.contentBase64).toBe(png)
  }, 120_000)

  it('compiles, and returns the log and the PDF', async () => {
    if (isBootstrap) {
      // Our own project: make the root file something any TeX install can build.
      const minimal = '\\documentclass{article}\n\\begin{document}\nlive suite\n\\end{document}\n'
      const w = await agent.call('overleaf_write_doc', { projectId, path: 'main.tex', content: minimal, overwrite: true })
      expect(w.ok, w.text).toBe(true)
    }
    const compiled = await agent.call('overleaf_compile', { projectId })
    expect(compiled.ok, compiled.text).toBe(true)
    if (isBootstrap) expect(compiled.json.status).toBe('success')
    const log = await agent.call('overleaf_read_compile_log', { projectId })
    expect(log.ok, log.text).toBe(true)
    expect(log.json.log).toMatch(/This is \w*TeX/)
    if (compiled.json.status === 'success') {
      const pdf = await agent.call('overleaf_download_pdf', { projectId })
      expect(pdf.ok, pdf.text).toBe(true)
      const blob = (pdf.content[0] as { resource: { blob: string } }).resource.blob
      expect(Buffer.from(blob, 'base64').subarray(0, 5).toString()).toBe('%PDF-')
    }
  }, 300_000)

  it('comments: a full thread lifecycle where the server has a review panel, a clean refusal where it does not', async () => {
    const body = 'A sentence worth discussing.\n'
    const path = await newDoc('comments.tex', body)
    const listed = await agent.call('overleaf_list_comments', { projectId, path })

    if (!listed.ok) {
      // Stock Community Edition.
      expect(listed.json.code).toBe('COMMENTS_UNSUPPORTED')
      const add = await agent.call('overleaf_add_comment', { projectId, path, anchorText: 'worth discussing', content: 'Why?', agentName: 'Quill' })
      expect(add.ok).toBe(false)
      expect(add.json.code).toBe('COMMENTS_UNSUPPORTED')
      expect(await freshRead(target, path)).toBe(body)
      return
    }
    expect(isBootstrap, 'a stock CE is expected to have no review panel').toBe(false)

    const add = await agent.call('overleaf_add_comment', { projectId, path, anchorText: 'worth discussing', content: 'Why?', agentName: 'Quill' })
    expect(add.ok, add.text).toBe(true)
    const threadId = add.json.threadId as string
    await pace()
    expect((await agent.call('overleaf_reply_comment', { projectId, threadId, content: 'Because.', agentName: 'Quill' })).ok).toBe(true)
    await pace()
    const after = await agent.call('overleaf_list_comments', { projectId, path })
    expect(after.text).toContain('Co-authored by Quill')
    expect(after.text).toContain('worth discussing')
    expect((await agent.call('overleaf_resolve_comment', { projectId, path, threadId })).ok).toBe(true)
    expect(await freshRead(target, path)).toBe(body)
  }, 120_000)
})
