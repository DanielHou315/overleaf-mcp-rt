// Prepare a release PR: set the version everywhere it is written down and
// turn the changelog's Unreleased section into the new version's section.
// Usage: node scripts/release-prep.mjs <x.y.z>
//
// package.json is the source of truth (the build injects it into the CLI and
// the MCP handshake); the plugin manifests and marketplace catalogs carry
// copies that test/unit/skills.test.ts requires to match.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error('Usage: node scripts/release-prep.mjs <x.y.z>')
  process.exit(1)
}

execFileSync('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], { stdio: 'inherit' })

for (const path of [
  '.claude-plugin/plugin.json',
  '.cursor-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  '.cursor-plugin/marketplace.json',
]) {
  const manifest = JSON.parse(readFileSync(path, 'utf-8'))
  manifest.version = version
  for (const plugin of manifest.plugins ?? []) plugin.version = version
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`${path} → ${version}`)
}

const changelog = readFileSync('CHANGELOG.md', 'utf-8')
if (changelog.includes(`## [${version}]`)) {
  console.log(`CHANGELOG.md already has a section for ${version}`)
} else if (!changelog.includes('## [Unreleased]')) {
  console.error('CHANGELOG.md has no "## [Unreleased]" section to release')
  process.exit(1)
} else {
  const today = new Date().toISOString().slice(0, 10)
  writeFileSync(
    'CHANGELOG.md',
    changelog.replace('## [Unreleased]', `## [Unreleased]\n\n## [${version}] — ${today}`),
  )
  console.log(`CHANGELOG.md: Unreleased → [${version}] — ${today}`)
}
