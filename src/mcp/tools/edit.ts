import { applyPatch as applyUnifiedDiff, createTwoFilesPatch } from 'diff'
import type { ServerContext } from '../server.js'
import {
  DocChangedExternallyError,
  EditAmbiguousError,
  EditNoMatchError,
  NotFoundError,
  OverleafError,
} from '../../errors.js'
import { computeOps, type OtOp } from '../../overleaf/diff.js'
import { applyOps } from '../../overleaf/text-ot.js'
import type { WriteSummary } from './docs.js'
import { closestRegion, findMatches, lineOf, type MatchStrategy } from './match.js'

/** The primary edit shape: replace `old_string` with `new_string`. */
export interface StringEdit {
  old_string: string
  new_string: string
  replace_all?: boolean
}

/** Mode-based edits from v1.1, still accepted. */
export type LegacyEdit =
  | { mode: 'replace'; find: string; replace: string; occurrence?: 'unique' | 'first' | 'all' | number }
  | { mode: 'insert_before'; find: string; text: string }
  | { mode: 'insert_after'; find: string; text: string }
  | { mode: 'replace_lines'; startLine: number; endLine: number; text: string }
  | { mode: 'raw_ops'; ops: OtOp[] }
  | { mode: 'unified_diff'; diff: string }

export type EditMode = StringEdit | LegacyEdit

export interface EditDocInput {
  projectId: string
  path: string
  edits: EditMode[]
  dryRun?: boolean
}

export interface EditDocOutput {
  ok: true
  dryRun: boolean
  summary: WriteSummary
  /** Unified diff of what this call changed, so the result can be checked without re-reading. */
  diff: string
  /** Present when an old_string only matched after relaxing whitespace. */
  notes?: string[]
  resolvedOps?: OtOp[]
}

const MAX_DIFF_CHARS = 6000

export async function handleEditDoc(
  ctx: ServerContext,
  input: EditDocInput,
): Promise<EditDocOutput> {
  if (!input.edits || input.edits.length === 0) {
    throw new OverleafError('OVERLEAF_GENERIC', 'edits must be a non-empty array')
  }

  // raw_ops and unified_diff address the doc as a whole (caller-supplied
  // offsets / line numbers), so combining them with other edits is ambiguous.
  const isFullDoc = (e: EditMode): boolean =>
    'mode' in e && (e.mode === 'raw_ops' || e.mode === 'unified_diff')
  const fullDocCount = input.edits.filter(isFullDoc).length
  if (fullDocCount > 0 && fullDocCount < input.edits.length) {
    throw new OverleafError(
      'OVERLEAF_GENERIC',
      'edit_doc cannot mix raw_ops or unified_diff with anchor-based modes in one call (positional safety)',
    )
  }
  if (fullDocCount > 1) {
    throw new OverleafError(
      'OVERLEAF_GENERIC',
      'edit_doc accepts at most one raw_ops or unified_diff edit per call',
    )
  }

  const engine = await ctx.ot.get(input.projectId)
  const docId = engine.pathToDocId(input.path)
  if (docId === null) {
    throw new NotFoundError(`No doc at ${input.path} in project ${input.projectId}`)
  }

  // Edits that address the doc by line number or offset are only meaningful
  // against the text the agent actually saw.
  const positional = input.edits.some(
    (e) => 'mode' in e && (e.mode === 'replace_lines' || e.mode === 'raw_ops'),
  )
  const notes: string[] = []
  const edit = (text: string): string => {
    if (positional && engine.hasUnseenExternalChanges(docId)) {
      throw new DocChangedExternallyError(
        `${input.path} was edited by a collaborator after you last read it, so line numbers and offsets may have shifted. Nothing was changed.`,
        { path: input.path },
      )
    }
    notes.length = 0
    return applyEdits(text, input.edits, notes)
  }

  if (input.dryRun) {
    const baseline = await engine.openDoc(docId)
    const before = baseline.text
    const after = edit(before)
    return {
      ok: true,
      dryRun: true,
      summary: summary(baseline.version, baseline.version, before.length, after.length, input.edits.length),
      diff: renderDiff(input.path, before, after),
      ...(notes.length ? { notes: [...notes] } : {}),
      resolvedOps: computeOps(before, after),
    }
  }

  // `edit` runs inside the engine against the live text at the instant the op
  // is emitted, so edits compose with whatever collaborators typed meanwhile.
  let intended = ''
  const result = await engine.updateDoc(docId, (text) => (intended = edit(text)))
  return {
    ok: true,
    dryRun: false,
    summary: summary(
      result.versionBefore, result.versionAfter,
      result.textBefore.length, result.textAfter.length,
      input.edits.length,
    ),
    diff: renderDiff(input.path, result.textBefore, intended),
    ...notesWith(notes, result.unstorableCodeUnits),
  }
}

/** Overleaf's own limitation, but the agent asked for text it did not get: say so. */
export function unstorableNote(codeUnits: number): string {
  return (
    `Overleaf cannot store characters outside the Basic Multilingual Plane (emoji and some rare symbols): ` +
    `${codeUnits / 2} such character(s) in your text were stored as U+FFFD replacement characters. ` +
    'Use a LaTeX command or a BMP character instead.'
  )
}

function notesWith(notes: string[], unstorableCodeUnits: number): { notes?: string[] } {
  const all = unstorableCodeUnits > 0 ? [...notes, unstorableNote(unstorableCodeUnits)] : [...notes]
  return all.length ? { notes: all } : {}
}

/** Apply edits in order, each to the result of the previous. Throws before anything is sent. */
export function applyEdits(text: string, edits: EditMode[], notes: string[] = []): string {
  let out = text
  edits.forEach((e, index) => {
    out = applyOne(out, e, index, notes)
  })
  return out
}

function applyOne(text: string, e: EditMode, index: number, notes: string[]): string {
  if (!('mode' in e)) {
    if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') {
      throw new OverleafError('OVERLEAF_GENERIC', `edits[${index}] needs old_string and new_string`)
    }
    if (e.old_string === e.new_string) {
      throw new OverleafError('OVERLEAF_GENERIC', `edits[${index}]: old_string and new_string are identical`)
    }
    return replaceString(text, e.old_string, e.new_string, e.replace_all ? 'all' : 'unique', index, notes)
  }
  switch (e.mode) {
    case 'replace':
      return replaceString(text, e.find, e.replace, e.occurrence ?? 'unique', index, notes)
    case 'insert_before': {
      const [span] = locate(text, e.find, 'unique', index, notes)
      return text.slice(0, span!.start) + e.text + text.slice(span!.start)
    }
    case 'insert_after': {
      const [span] = locate(text, e.find, 'unique', index, notes)
      return text.slice(0, span!.end) + e.text + text.slice(span!.end)
    }
    case 'replace_lines': {
      const lines = text.split('\n')
      if (e.startLine < 1 || e.endLine > lines.length || e.startLine > e.endLine) {
        throw new OverleafError(
          'OVERLEAF_GENERIC',
          `replace_lines range ${e.startLine}..${e.endLine} is out of bounds (doc has ${lines.length} lines)`,
        )
      }
      lines.splice(e.startLine - 1, e.endLine - e.startLine + 1, e.text)
      return lines.join('\n')
    }
    case 'raw_ops':
      return applyOps(text, e.ops)
    case 'unified_diff': {
      const result = applyUnifiedDiff(text, e.diff, { fuzzFactor: 2 })
      if (typeof result !== 'string') {
        throw new EditNoMatchError(
          'unified diff did not apply: context lines did not match the doc',
        )
      }
      return result
    }
  }
}

type Occurrence = 'unique' | 'first' | 'all' | number

function replaceString(
  text: string, find: string, replacement: string,
  occurrence: Occurrence, index: number, notes: string[],
): string {
  const spans = locate(text, find, occurrence, index, notes)
  let out = text
  // Back to front so earlier offsets stay valid.
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, span.start) + replacement + out.slice(span.end)
  }
  return out
}

function locate(
  text: string, find: string, occurrence: Occurrence, index: number, notes: string[],
) {
  if (find === '') {
    throw new OverleafError('OVERLEAF_GENERIC', `edits[${index}]: the text to find must not be empty`)
  }
  const { strategy, spans } = findMatches(text, find)
  const shown = JSON.stringify(find.length > 80 ? `${find.slice(0, 80)}…` : find)
  if (spans.length === 0) {
    const near = closestRegion(text, find)
    throw new EditNoMatchError(
      `edits[${index}]: find string not found: ${shown}` +
        (near ? `. Closest text is at lines ${near.startLine}-${near.endLine}.` : ''),
      near ? { closest: near } : {},
    )
  }
  const lines = spans.map((s) => lineOf(text, s.start))
  if (strategy !== 'exact') {
    // A tolerant match is a guess at intent; only trust it when unambiguous.
    if (spans.length > 1) throw ambiguous(index, shown, lines)
    notes.push(`edits[${index}] matched ${describe(strategy)} at line ${lines[0]}`)
    return spans
  }
  if (occurrence === 'all') return spans
  if (occurrence === 'first') return [spans[0]!]
  if (typeof occurrence === 'number') {
    const span = spans[occurrence]
    if (!span) {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        `edits[${index}]: occurrence ${occurrence} out of range (only ${spans.length} matches)`,
      )
    }
    return [span]
  }
  if (spans.length > 1) throw ambiguous(index, shown, lines)
  return spans
}

function ambiguous(index: number, shown: string, lines: number[]): EditAmbiguousError {
  return new EditAmbiguousError(
    `edits[${index}]: find string is ambiguous: found ${lines.length} matches for ${shown} (lines ${lines.join(', ')})`,
    { lines },
  )
}

function describe(strategy: MatchStrategy): string {
  return strategy.replace(/-/g, ' ')
}

function renderDiff(path: string, before: string, after: string): string {
  if (before === after) return ''
  const patch = createTwoFilesPatch(path, path, before, after, undefined, undefined, { context: 3 })
  // Drop the "Index:/===" preamble; the hunks are what matter.
  const body = patch.slice(patch.indexOf('@@'))
  return body.length > MAX_DIFF_CHARS
    ? `${body.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated; ${body.length - MAX_DIFF_CHARS} more chars)`
    : body
}

function summary(
  versionBefore: number, versionAfter: number,
  charsBefore: number, charsAfter: number,
  opsApplied: number,
): WriteSummary {
  return {
    versionBefore, versionAfter,
    charsBefore, charsAfter,
    charsDelta: charsAfter - charsBefore,
    opsApplied,
  }
}
