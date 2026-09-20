import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { BUNDLED_SKILLS_DIR, installSkills, listSkills } from '../../src/skills.js'
import { registerAllTools } from '../../src/mcp/tools/index.js'

const root = join(BUNDLED_SKILLS_DIR, '..')
const json = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf-8'))
const frontmatter = (file: string) => /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, 'utf-8'))?.[1] ?? ''

/**
 * The repo root is one plugin published to several harnesses: Claude Code,
 * Cursor and Codex each read their own manifest (Codex shares Claude Code's
 * marketplace catalog). These keep the copies from drifting apart.
 */
describe('plugin packaging', () => {
  const claude = json('.claude-plugin/plugin.json')
  const cursor = json('.cursor-plugin/plugin.json')
  const codex = json('.codex-plugin/plugin.json')
  const pkg = json('package.json')

  it('the manifests agree with each other and with package.json', () => {
    for (const key of ['name', 'displayName', 'version', 'description', 'license', 'keywords', 'author']) {
      expect(cursor[key], key).toEqual(claude[key])
    }
    for (const key of ['name', 'version', 'description', 'license', 'keywords', 'author']) {
      expect(codex[key], key).toEqual(claude[key])
    }
    expect(codex.interface.displayName).toBe(claude.displayName)
    expect(claude.name).toBe(pkg.name)
    expect(claude.version).toBe(pkg.version)
    expect(claude.license).toBe(pkg.license)
  })

  it('both marketplace catalogs list exactly this plugin, rooted at the repo', () => {
    for (const path of ['.claude-plugin/marketplace.json', '.cursor-plugin/marketplace.json']) {
      const catalog = json(path)
      expect(catalog.owner.name, path).toBeTruthy()
      expect(catalog.plugins, path).toHaveLength(1)
      expect(catalog.plugins[0], path).toMatchObject({
        name: claude.name, source: './', version: claude.version, description: claude.description,
      })
    }
  })

  it('wires the MCP server per harness, and keeps .mcp.json out of the repo root', () => {
    // Claude Code loads a root .mcp.json as plugin config AND as project config;
    // ${CLAUDE_PLUGIN_ROOT} only exists in the former. Declaring it inline avoids the clash.
    expect(existsSync(join(root, '.mcp.json'))).toBe(false)
    expect(claude.mcpServers.overleaf).toEqual({
      command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/mcp-launch.mjs'],
    })
    expect(existsSync(join(root, 'scripts', 'mcp-launch.mjs'))).toBe(true)
    expect(json('mcp.json').mcpServers.overleaf).toEqual({ command: 'npx', args: ['-y', 'overleaf-mcp-rt'] })
  })

  it('gives Codex a launcher path it can resolve: no plugin-root variable, cwd at the plugin root', () => {
    // Codex installs happily from the Claude Code manifest but does not expand
    // ${CLAUDE_PLUGIN_ROOT} in MCP args, so that server never starts. Its own manifest
    // wins when present, and it resolves a relative cwd against the plugin root.
    expect(codex.skills).toBe('./skills/')
    expect(codex.mcpServers).toBe('./.codex-plugin/mcp.json')
    expect(json('.codex-plugin/mcp.json').mcpServers.overleaf).toEqual({
      command: 'node', args: ['./scripts/mcp-launch.mjs'], cwd: '.',
    })
  })

  it('has a changelog section for the version being shipped', () => {
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf-8')).toContain(`## [${pkg.version}]`)
  })

  it('ships the skills in the npm package', () => {
    expect(pkg.files).toContain('skills')
    expect(pkg.files).toContain('CHANGELOG.md')
  })

  it('gives every command a name and description', () => {
    const dir = join(root, 'commands')
    for (const file of readdirSync(dir)) {
      const fm = frontmatter(join(dir, file))
      expect(fm, file).toMatch(new RegExp(`^name: ${file.replace(/\.md$/, '')}$`, 'm'))
      expect(fm, file).toMatch(/^description: .{20,}$/m)
    }
  })
})

describe('bundled skills', () => {
  const skills = listSkills()
  const body = (name: string) => readFileSync(join(BUNDLED_SKILLS_DIR, name, 'SKILL.md'), 'utf-8')

  it('ships the expected skills, each named after its directory', () => {
    expect(skills.map((s) => s.name)).toEqual([
      'overleaf-comments', 'overleaf-editing', 'overleaf-latex-workflow', 'overleaf-setup',
    ])
    for (const s of skills) expect(s.dir.endsWith(s.name), s.name).toBe(true)
  })

  it('gives each a trigger-worthy description and keeps it concise', () => {
    for (const s of skills) {
      expect(s.description.length, `${s.name} description`).toBeGreaterThan(80)
      expect(s.description.length, `${s.name} description`).toBeLessThan(1024)
      expect(s.description, s.name).toMatch(/\bUse when/)
      expect(body(s.name).split('\n').length, `${s.name} should stay small`).toBeLessThan(80)
    }
  })

  it('only mentions MCP tools that exist', async () => {
    const server = new Server({ name: 't', version: '0' }, { capabilities: { tools: {} } })
    registerAllTools(server, { list: () => [], get: async () => { throw new Error('unused') } })
    const client = new Client({ name: 'c', version: '0' }, { capabilities: {} })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    const real = new Set((await client.listTools()).tools.map((t) => t.name))

    const docs = [
      ...skills.map((s) => [s.name, body(s.name)] as const),
      ...readdirSync(join(root, 'commands')).map((f) => [f, readFileSync(join(root, 'commands', f), 'utf-8')] as const),
    ]
    for (const [name, text] of docs) {
      for (const tool of new Set(text.match(/\boverleaf_[a-z_]+\b/g) ?? [])) {
        if (tool.endsWith('_')) continue // prose like "overleaf_* tools"
        expect(real.has(tool), `${name} mentions unknown tool ${tool}`).toBe(true)
      }
    }
  })

  it('is written for any agent: no model or vendor names', () => {
    for (const s of skills) {
      expect(body(s.name), s.name).not.toMatch(/\b(Claude(?! Code)|GPT|ChatGPT|Gemini|Anthropic|OpenAI|Copilot)\b/)
    }
  })

  it('states the comment signature rule', () => {
    expect(body('overleaf-comments')).toContain('Co-authored by <your agent name>')
    expect(body('overleaf-comments')).toMatch(/omitSignature: true.*only if the user has explicitly/is)
  })

  it('installs into a skills directory, replacing older copies', () => {
    const target = mkdtempSync(join(tmpdir(), 'olmcp-skills-'))
    expect(installSkills(target)).toHaveLength(4)
    expect(readdirSync(target).sort()).toEqual(skills.map((s) => s.name))
    expect(existsSync(join(target, 'overleaf-setup', 'SKILL.md'))).toBe(true)
    expect(() => installSkills(target)).not.toThrow()
  })
})
