import { createTwoFilesPatch } from 'diff'
import type { ExternalChanges, ExternalDocChange } from '../overleaf/ot.js'

const MAX_DIFF_CHARS_PER_DOC = 6000

/**
 * Render what collaborators changed as a block appended to a tool result —
 * the Overleaf analogue of a coding agent being told a file changed on disk.
 * Returns null when there is nothing to report.
 */
export function formatExternalChanges(changes: ExternalChanges, now = Date.now()): string | null {
  if (changes.docs.length === 0 && changes.tree.length === 0) return null
  const parts: string[] = [
    '<external-changes>',
    'Collaborators changed this project since your last tool call. Anything you read earlier is stale ' +
      'where it differs from the diffs below; they bring you up to date (reported once).',
  ]
  for (const doc of changes.docs) parts.push('', formatDoc(doc, now))
  if (changes.tree.length > 0) {
    parts.push('', 'File tree:', ...changes.tree.map((e) => `- ${e}`))
  }
  parts.push('</external-changes>')
  return parts.join('\n')
}

function formatDoc(doc: ExternalDocChange, now: number): string {
  const name = doc.path ?? doc.docId
  const who = doc.authors.length > 0 ? ` by ${doc.authors.join(', ')}` : ''
  const when = doc.lastEditedAt !== null ? `, ${ago(now - doc.lastEditedAt)}` : ''
  const header = `${name} — edited${who}${when} (v${doc.fromVersion} → v${doc.toVersion})`
  const patch = createTwoFilesPatch(name, name, doc.before, doc.after, undefined, undefined, { context: 2 })
  const hunks = patch.slice(patch.indexOf('@@'))
  if (hunks.length > MAX_DIFF_CHARS_PER_DOC) {
    const changed = hunks.split('\n').filter((l) => /^[+-]/.test(l)).length
    return `${header}\n(${changed} lines changed — too large to show; re-read the doc before editing it.)`
  }
  return `${header}\n${hunks.trimEnd()}`
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}
