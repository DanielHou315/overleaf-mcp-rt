import { describe, it, expect } from 'vitest'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerAllTools } from '../../src/mcp/tools/index.js'
import { makeToolHarness } from './fake-overleaf.js'

const DOC = [
  '\\section{Introduction}',
  'We study the problem of widgets.',
  '',
  '\\section{Method}',
  'Our method is simple.',
  '',
  '\\section{Results}',
  'Results are good.',
].join('\n')

/** Everything an agent would see: a real MCP client talking to the real tool dispatcher. */
async function agent(docs: Record<string, string>) {
  const harness = await makeToolHarness(docs)
  const server = new Server({ name: 'test', version: '0' }, { capabilities: { tools: {} } })
  registerAllTools(server, harness.ctx)
  const client = new Client({ name: 'agent', version: '0' }, { capabilities: {} })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: { projectId: 'p1', ...args } })
    const blocks = (res.content as Array<{ type: string; text: string }>).map((c) => c.text)
    return {
      isError: res.isError === true,
      json: JSON.parse(blocks[0]!) as Record<string, any>,
      external: blocks.slice(1).join('\n'),
    }
  }
  return { ...harness, call }
}

describe('agent + human editing the same doc', () => {
  it('string edits land next to concurrent browser edits, and the agent is told what the human changed', async () => {
    const { server, call } = await agent({ main: DOC })
    const read = await call('overleaf_read_doc', { path: 'main.tex' })
    expect(read.json.content).toBe(DOC)
    expect(read.external).toBe('')

    // Human fixes the intro in the browser while the agent is thinking.
    const at = DOC.indexOf('widgets')
    server.remoteEdit('main', [{ p: at, d: 'widgets' }, { p: at, i: 'gadgets' }])

    const edit = await call('overleaf_edit_doc', {
      path: 'main.tex',
      edits: [{ old_string: 'Results are good.', new_string: 'Results are excellent.' }],
    })
    expect(edit.isError).toBe(false)
    expect(server.text('main')).toBe(
      DOC.replace('widgets', 'gadgets').replace('Results are good.', 'Results are excellent.'),
    )
    // The tool result shows the agent's own change…
    expect(edit.json.diff).toContain('-Results are good.')
    expect(edit.json.diff).toContain('+Results are excellent.')
    expect(edit.json.diff).not.toContain('gadgets')
    // …and, separately, the human's — attributed by name.
    expect(edit.external).toContain('<external-changes>')
    expect(edit.external).toContain('main.tex — edited by Ada Lovelace')
    expect(edit.external).toContain('-We study the problem of widgets.')
    expect(edit.external).toContain('+We study the problem of gadgets.')
    expect(edit.external).not.toContain('excellent')

    // Reported once.
    const again = await call('overleaf_check_changes', {})
    expect(again.external).toBe('')
  })

  it('explains a failed match with the collaborator change that caused it, and changes nothing', async () => {
    const { server, call } = await agent({ main: DOC })
    await call('overleaf_read_doc', { path: 'main.tex' })
    const at = DOC.indexOf('simple')
    server.remoteEdit('main', [{ p: at, d: 'simple' }, { p: at, i: 'elegant' }])
    const before = server.text('main')

    const edit = await call('overleaf_edit_doc', {
      path: 'main.tex',
      edits: [
        { old_string: 'Results are good.', new_string: 'Results are great.' },
        { old_string: 'Our method is simple.', new_string: 'Our method is very simple.' },
      ],
    })
    expect(edit.isError).toBe(true)
    expect(edit.json.code).toBe('EDIT_NO_MATCH')
    expect(edit.json.message).toContain('edits[1]')
    expect(edit.json.context.closest.text).toBe('Our method is elegant.')
    expect(edit.external).toContain('+Our method is elegant.')
    expect(server.text('main')).toBe(before) // atomic: the first edit was not applied either
  })

  it('reports edits to other docs the agent has read, and file-tree changes', async () => {
    const { server, call } = await agent({ main: DOC, refs: '@book{a}' })
    await call('overleaf_read_doc', { path: 'main.tex' })
    await call('overleaf_read_doc', { path: 'refs.tex' })

    server.remoteEdit('refs', [{ p: 8, i: '\n@book{b}' }])
    server.sock.simulate('reciveNewDoc', 'root', { _id: 'd9', name: 'appendix.tex' }, 'editor', 'u-human')

    const range = await call('overleaf_read_doc_range', { path: 'main.tex', startLine: 1, endLine: 1 })
    expect(range.external).toContain('refs.tex — edited by Ada Lovelace')
    expect(range.external).toContain('+@book{b}')
    expect(range.external).toContain('created doc appendix.tex by Ada Lovelace')
  })

  it('does not report docs the agent never looked at', async () => {
    const { server, engine, call } = await agent({ main: DOC, refs: '@book{a}' })
    await engine.joinDoc('refs') // tracked live, but never shown to the agent
    server.remoteEdit('refs', [{ p: 0, i: '% ' }])
    const read = await call('overleaf_read_doc', { path: 'main.tex' })
    expect(read.external).toBe('')
  })

  it('refuses line-number edits when the doc shifted under the agent', async () => {
    const { server, call } = await agent({ main: DOC })
    await call('overleaf_read_doc', { path: 'main.tex' })
    server.remoteEdit('main', [{ p: 0, i: '% draft\n' }])
    const edit = await call('overleaf_edit_doc', {
      path: 'main.tex',
      edits: [{ mode: 'replace_lines', startLine: 2, endLine: 2, text: 'We study gizmos.' }],
    })
    expect(edit.json.code).toBe('DOC_CHANGED_EXTERNALLY')
    expect(edit.external).toContain('+% draft')
    expect(server.text('main')).toBe(`% draft\n${DOC}`)
  })
})

describe('overleaf_edit_doc string matching', () => {
  it('rejects an ambiguous old_string and lists where it matched', async () => {
    const { call } = await agent({ main: 'x = 1\ny = 2\nx = 1\n' })
    const edit = await call('overleaf_edit_doc', {
      path: 'main.tex', edits: [{ old_string: 'x = 1', new_string: 'x = 3' }],
    })
    expect(edit.json.code).toBe('EDIT_AMBIGUOUS')
    expect(edit.json.context.lines).toEqual([1, 3])
  })

  it('replace_all changes every occurrence', async () => {
    const { server, call } = await agent({ main: 'x = 1\ny = 2\nx = 1\n' })
    await call('overleaf_edit_doc', {
      path: 'main.tex', edits: [{ old_string: 'x = 1', new_string: 'x = 3', replace_all: true }],
    })
    expect(server.text('main')).toBe('x = 3\ny = 2\nx = 3\n')
  })

  it('applies edits sequentially, each seeing the previous result', async () => {
    const { server, call } = await agent({ main: 'alpha' })
    await call('overleaf_edit_doc', {
      path: 'main.tex',
      edits: [
        { old_string: 'alpha', new_string: 'beta' },
        { old_string: 'beta', new_string: 'gamma' },
      ],
    })
    expect(server.text('main')).toBe('gamma')
  })

  it('tolerates indentation and re-wrapping differences when the match is unambiguous', async () => {
    const tex = '\\begin{itemize}\n    \\item first   \n    \\item second\n\\end{itemize}\nA long sentence that was\nwrapped by the editor.\n'
    const { server, call } = await agent({ main: tex })
    const edit = await call('overleaf_edit_doc', {
      path: 'main.tex',
      edits: [
        { old_string: '\\item first\n\\item second', new_string: '    \\item only' },
        { old_string: 'A long sentence that was wrapped by the editor.', new_string: 'Short.' },
      ],
    })
    expect(edit.isError).toBe(false)
    expect(server.text('main')).toBe('\\begin{itemize}\n    \\item only\n\\end{itemize}\nShort.\n')
    expect(edit.json.notes).toEqual([
      'edits[0] matched ignoring indentation at line 2',
      'edits[1] matched ignoring whitespace differences at line 4',
    ])
  })

  it('sends only the characters that differ, so a concurrent cursor elsewhere is undisturbed', async () => {
    const { server, call } = await agent({ main: DOC })
    await call('overleaf_edit_doc', {
      path: 'main.tex', edits: [{ old_string: 'Results are good.', new_string: 'Results are very good.' }],
    })
    const sent = server.sock.emitsOf('applyOtUpdate')[0]!.args[1] as { op: unknown[] }
    expect(sent.op).toEqual([{ p: DOC.indexOf('good'), i: 'very ' }])
  })

  it('dryRun previews the diff without sending anything', async () => {
    const { server, call } = await agent({ main: 'hello world' })
    const edit = await call('overleaf_edit_doc', {
      path: 'main.tex', dryRun: true, edits: [{ old_string: 'world', new_string: 'there' }],
    })
    expect(edit.json.dryRun).toBe(true)
    expect(edit.json.diff).toContain('+hello there')
    expect(server.text('main')).toBe('hello world')
    expect(server.sock.emitsOf('applyOtUpdate')).toHaveLength(0)
  })
})
