import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OverleafError } from './errors.js'

/**
 * Agent Skills shipped with the package (skills/<name>/SKILL.md at the repo
 * root, which is also the plugin root). Both src/cli.ts and the bundled
 * dist/cli.js sit one level below the package root, so the same relative path
 * works for either.
 */
export const BUNDLED_SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url))

export interface SkillInfo {
  name: string
  description: string
  dir: string
}

export function listSkills(skillsDir = BUNDLED_SKILLS_DIR): SkillInfo[] {
  if (!existsSync(skillsDir)) return []
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(skillsDir, e.name, 'SKILL.md')))
    .map((e) => {
      const text = readFileSync(join(skillsDir, e.name, 'SKILL.md'), 'utf-8')
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
      const field = (key: string) => new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(frontmatter)?.[1]?.trim() ?? ''
      return { name: field('name') || e.name, description: field('description'), dir: join(skillsDir, e.name) }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Copy the bundled skills into a directory an agent harness reads skills from
 * (default ~/.claude/skills; pass another for other harnesses). Existing copies are replaced so that
 * upgrading the package upgrades the skills.
 */
export function installSkills(target = join(homedir(), '.claude', 'skills'), skillsDir = BUNDLED_SKILLS_DIR): string[] {
  const skills = listSkills(skillsDir)
  if (skills.length === 0) {
    throw new OverleafError('OVERLEAF_GENERIC', `No bundled skills found at ${skillsDir}`)
  }
  mkdirSync(target, { recursive: true })
  return skills.map((skill) => {
    const dest = join(target, skill.name)
    cpSync(skill.dir, dest, { recursive: true, force: true })
    return dest
  })
}
