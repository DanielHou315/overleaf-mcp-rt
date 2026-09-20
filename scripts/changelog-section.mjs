// Print the CHANGELOG.md section for one version (default: package.json's),
// for use as GitHub release notes. Exits non-zero if the section is missing,
// which stops a release whose changelog was forgotten.
// Usage: node scripts/changelog-section.mjs [version]
import { readFileSync } from 'node:fs'

const version = process.argv[2] ?? JSON.parse(readFileSync('package.json', 'utf-8')).version
const lines = readFileSync('CHANGELOG.md', 'utf-8').split('\n')
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`))
if (start < 0) {
  console.error(`CHANGELOG.md has no section for ${version}`)
  process.exit(1)
}
const rest = lines.slice(start + 1)
const end = rest.findIndex((l) => l.startsWith('## ['))
console.log((end < 0 ? rest : rest.slice(0, end)).join('\n').trim())
