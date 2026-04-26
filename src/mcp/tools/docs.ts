import type { ServerContext } from '../server.js'
import { NotFoundError, OverleafError } from '../../errors.js'
import type { OtOp } from '../../overleaf/diff.js'
import type { DownloadedBytes } from '../../overleaf/rest.js'

export interface WriteSummary {
  versionBefore: number
  versionAfter: number
  charsBefore: number
  charsAfter: number
  charsDelta: number
  opsApplied: number
}

export async function handleReadDoc(
  ctx: ServerContext,
  input: { projectId: string; path: string },
): Promise<{ content: string }> {
  const engine = await ctx.ot.get(input.projectId)
  const docId = engine.pathToDocId(input.path)
  if (docId === null) {
    throw new NotFoundError(`No doc at ${input.path} in project ${input.projectId}`)
  }
  const baseline = await engine.joinDoc(docId)
  return { content: baseline.text }
}

export async function handleReadFile(
  ctx: ServerContext,
  input: { projectId: string; path: string },
): Promise<DownloadedBytes> {
  const engine = await ctx.ot.get(input.projectId)
  const fileId = engine.pathToFileId(input.path)
  if (fileId === null) {
    throw new NotFoundError(`No binary file at ${input.path} in project ${input.projectId}`)
  }
  return ctx.rest.downloadFile(input.projectId, fileId)
}

export async function handleWriteDoc(
  ctx: ServerContext,
  input: { projectId: string; path: string; content: string },
): Promise<{ ok: true; summary: WriteSummary }> {
  const engine = await ctx.ot.get(input.projectId)
  const docId = engine.pathToDocId(input.path)
  if (docId === null) {
    throw new NotFoundError(`No doc at ${input.path} in project ${input.projectId}`)
  }
  const before = await engine.joinDoc(docId)
  const charsBefore = before.text.length
  const versionBefore = before.version
  await engine.writeDoc(docId, input.content)
  const after = engine.getBaseline(docId)
  if (!after) {
    throw new OverleafError(
      'OVERLEAF_GENERIC',
      `getBaseline returned undefined for docId ${docId} after a successful write`,
    )
  }
  return {
    ok: true,
    summary: {
      versionBefore,
      versionAfter: after.version,
      charsBefore,
      charsAfter: input.content.length,
      charsDelta: input.content.length - charsBefore,
      opsApplied: 1,
    },
  }
}

export async function handleApplyPatch(
  ctx: ServerContext,
  input: { projectId: string; path: string; ops: OtOp[] },
): Promise<{ ok: true; summary: WriteSummary }> {
  // Validate op shape — each op must have exactly one of i or d.
  for (const op of input.ops) {
    if (typeof op.p !== 'number' || op.p < 0) {
      throw new OverleafError('OVERLEAF_GENERIC', 'Each op must have a numeric p ≥ 0')
    }
    const hasInsert = typeof op.i === 'string'
    const hasDelete = typeof op.d === 'string'
    if (hasInsert === hasDelete) {
      throw new OverleafError('OVERLEAF_GENERIC', 'Each op must have exactly one of i or d')
    }
  }

  const engine = await ctx.ot.get(input.projectId)
  const docId = engine.pathToDocId(input.path)
  if (docId === null) {
    throw new NotFoundError(`No doc at ${input.path} in project ${input.projectId}`)
  }
  const before = await engine.joinDoc(docId)
  const charsBefore = before.text.length
  const versionBefore = before.version

  await engine.applyOps(docId, input.ops)
  const after = engine.getBaseline(docId)
  if (!after) {
    throw new OverleafError(
      'OVERLEAF_GENERIC',
      `getBaseline returned undefined for docId ${docId} after a successful write`,
    )
  }
  return {
    ok: true,
    summary: {
      versionBefore,
      versionAfter: after.version,
      charsBefore,
      charsAfter: after.text.length,
      charsDelta: after.text.length - charsBefore,
      opsApplied: input.ops.length,
    },
  }
}
