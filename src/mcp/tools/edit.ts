import { applyPatch as applyUnifiedDiff } from 'diff'
import type { ServerContext } from '../server.js'
import { NotFoundError, OverleafError } from '../../errors.js'
import type { OtOp } from '../../overleaf/diff.js'
import type { WriteSummary } from './docs.js'

export type EditMode =
  | { mode: 'replace'; find: string; replace: string; occurrence?: 'unique' | 'first' | 'all' | number }
  | { mode: 'insert_before'; find: string; text: string }
  | { mode: 'insert_after'; find: string; text: string }
  | { mode: 'replace_lines'; startLine: number; endLine: number; text: string }
  | { mode: 'raw_ops'; ops: OtOp[] }
  | { mode: 'unified_diff'; diff: string }

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
  resolvedOps?: OtOp[]
}

export async function handleEditDoc(
  ctx: ServerContext,
  input: EditDocInput,
): Promise<EditDocOutput> {
  if (!input.edits || input.edits.length === 0) {
    throw new OverleafError('OVERLEAF_GENERIC', 'edits must be a non-empty array')
  }

  // raw_ops trusts caller-supplied positions and is not safe to interleave
  // with anchor-based modes (whose ops are derived from baseline positions).
  // Reject mixed calls to avoid silent corruption.
  const hasRawOps = input.edits.some((e) => e.mode === 'raw_ops')
  const hasAnchor = input.edits.some((e) => e.mode !== 'raw_ops')
  if (hasRawOps && hasAnchor) {
    throw new OverleafError(
      'OVERLEAF_GENERIC',
      'edit_doc cannot mix raw_ops with anchor-based modes in one call (positional safety)',
    )
  }

  const engine = await ctx.ot.get(input.projectId)
  const docId = engine.pathToDocId(input.path)
  if (docId === null) {
    throw new NotFoundError(`No doc at ${input.path} in project ${input.projectId}`)
  }
  const baseline = await engine.joinDoc(docId)
  const text = baseline.text
  const versionBefore = baseline.version
  const charsBefore = text.length

  // Resolve every edit to OT ops against the baseline. We compute ops for each
  // edit in DOCUMENT order (sorted by anchor position descending) so positions
  // remain stable. Atomicity: if any edit fails to resolve, throw — caller's
  // doc is untouched (we haven't emitted yet).
  const resolved = resolveEdits(text, input.edits)

  if (input.dryRun) {
    return {
      ok: true,
      dryRun: true,
      summary: summary(versionBefore, versionBefore, charsBefore, simulate(text, resolved).length, input.edits.length),
      resolvedOps: resolved,
    }
  }

  await engine.applyOps(docId, resolved)
  const after = engine.getBaseline(docId)
  if (!after) {
    throw new OverleafError(
      'OVERLEAF_GENERIC',
      `getBaseline returned undefined for docId ${docId} after a successful edit_doc`,
    )
  }
  return {
    ok: true,
    dryRun: false,
    summary: summary(versionBefore, after.version, charsBefore, after.text.length, input.edits.length),
  }
}

interface ResolvedEdit {
  ops: OtOp[]
  startPos: number  // for stable sorting
}

function resolveEdits(text: string, edits: EditMode[]): OtOp[] {
  const resolved: ResolvedEdit[] = edits.map((e) => resolveOne(text, e))
  // Sort descending by startPos so we emit ops back-to-front. Each op's
  // baseline-position is therefore still valid in the post-prior-ops doc
  // state — prior emitted ops were at HIGHER positions, which don't shift
  // the indices of lower positions. (Within a single resolved edit, ops are
  // already in descending order from resolveOne.)
  resolved.sort((a, b) => b.startPos - a.startPos)
  return resolved.flatMap((r) => r.ops)
}

function resolveOne(text: string, edit: EditMode): ResolvedEdit {
  switch (edit.mode) {
    case 'replace': {
      const positions = findAll(text, edit.find)
      const occurrence = edit.occurrence ?? 'unique'
      const targets = pickOccurrences(positions, occurrence, edit.find)
      // Emit back-to-front so each op's p is still valid in the post-prior-ops
      // doc state: prior emitted ops were at HIGHER positions, which don't
      // shift the indices of LOWER positions.
      const sorted = [...targets].sort((a, b) => b - a)
      const ops: OtOp[] = []
      for (const p of sorted) {
        ops.push({ p, d: edit.find })
        ops.push({ p, i: edit.replace })
      }
      return { ops, startPos: sorted[0]! }
    }
    case 'insert_before': {
      const positions = findAll(text, edit.find)
      ensureUnique(positions, edit.find)
      const p = positions[0]!
      return { ops: [{ p, i: edit.text }], startPos: p }
    }
    case 'insert_after': {
      const positions = findAll(text, edit.find)
      ensureUnique(positions, edit.find)
      const p = positions[0]! + edit.find.length
      return { ops: [{ p, i: edit.text }], startPos: p }
    }
    case 'replace_lines': {
      const lines = text.split('\n')
      if (edit.startLine < 1 || edit.endLine > lines.length || edit.startLine > edit.endLine) {
        throw new OverleafError(
          'OVERLEAF_GENERIC',
          `replace_lines range ${edit.startLine}..${edit.endLine} is out of bounds (doc has ${lines.length} lines)`,
        )
      }
      // Compute char offsets of startLine and endLine (1-indexed, inclusive).
      let pStart = 0
      for (let i = 0; i < edit.startLine - 1; i++) pStart += lines[i]!.length + 1
      let pEnd = pStart
      for (let i = edit.startLine - 1; i <= edit.endLine - 1; i++) {
        pEnd += lines[i]!.length + (i < edit.endLine - 1 ? 1 : 0)
      }
      const oldSlice = text.slice(pStart, pEnd)
      return {
        ops: [{ p: pStart, d: oldSlice }, { p: pStart, i: edit.text }],
        startPos: pStart,
      }
    }
    case 'raw_ops': {
      return {
        ops: edit.ops,
        startPos: edit.ops[0]?.p ?? 0,
      }
    }
    case 'unified_diff': {
      const result = applyUnifiedDiff(text, edit.diff)
      if (result === false || typeof result !== 'string') {
        throw new OverleafError(
          'OVERLEAF_GENERIC',
          'unified diff did not apply: context lines did not match the doc',
        )
      }
      // Reduce to the smallest set of OT ops by computing a single
      // delete-everything + insert-new (cheap, server validates atomically).
      // For better minimality we could call computeOps from src/overleaf/diff.ts,
      // but a single replace is correct and simpler.
      return {
        ops: [
          { p: 0, d: text },
          { p: 0, i: result },
        ],
        startPos: 0,
      }
    }
  }
}

function findAll(text: string, needle: string): number[] {
  if (needle.length === 0) return []
  const out: number[] = []
  let i = 0
  while ((i = text.indexOf(needle, i)) !== -1) {
    out.push(i)
    i += needle.length
  }
  return out
}

function pickOccurrences(
  positions: number[],
  occurrence: 'unique' | 'first' | 'all' | number,
  find: string,
): number[] {
  if (positions.length === 0) {
    throw new OverleafError(
      'OVERLEAF_GENERIC',
      `find string not found: ${JSON.stringify(find.slice(0, 80))}`,
    )
  }
  if (occurrence === 'unique') {
    if (positions.length > 1) {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        `find string is ambiguous: found ${positions.length} matches for ${JSON.stringify(find.slice(0, 80))}`,
      )
    }
    return positions
  }
  if (occurrence === 'first') return [positions[0]!]
  if (occurrence === 'all') return positions
  if (typeof occurrence === 'number') {
    const p = positions[occurrence]
    if (p === undefined) {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        `occurrence ${occurrence} out of range (only ${positions.length} matches)`,
      )
    }
    return [p]
  }
  throw new OverleafError('OVERLEAF_GENERIC', `Unknown occurrence: ${String(occurrence)}`)
}

function ensureUnique(positions: number[], find: string): void {
  if (positions.length === 0) {
    throw new OverleafError(
      'OVERLEAF_GENERIC',
      `anchor not found: ${JSON.stringify(find.slice(0, 80))}`,
    )
  }
  if (positions.length > 1) {
    throw new OverleafError(
      'OVERLEAF_GENERIC',
      `anchor is ambiguous: found ${positions.length} matches for ${JSON.stringify(find.slice(0, 80))}`,
    )
  }
}

function simulate(text: string, ops: OtOp[]): string {
  let out = text
  for (const op of ops) {
    if (op.i !== undefined) out = out.slice(0, op.p) + op.i + out.slice(op.p)
    else if (op.d !== undefined) out = out.slice(0, op.p) + out.slice(op.p + op.d.length)
  }
  return out
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
