import type { ServerContext } from '../server.js'
import { NotFoundError, OverleafError } from '../../errors.js'
import type { OtOp } from '../../overleaf/diff.js'

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
): Promise<{ contentBase64: string }> {
  const engine = await ctx.ot.get(input.projectId)
  const fileId = engine.pathToFileId(input.path)
  if (fileId === null) {
    throw new NotFoundError(`No binary file at ${input.path} in project ${input.projectId}`)
  }
  const buf = await ctx.rest.downloadFile(input.projectId, fileId)
  return { contentBase64: buf.toString('base64') }
}

export async function handleWriteDoc(
  ctx: ServerContext,
  input: { projectId: string; path: string; content: string },
): Promise<{ ok: true }> {
  const engine = await ctx.ot.get(input.projectId)
  const docId = engine.pathToDocId(input.path)
  if (docId === null) {
    throw new NotFoundError(`No doc at ${input.path} in project ${input.projectId}`)
  }
  await engine.writeDoc(docId, input.content)
  return { ok: true }
}

export async function handleApplyPatch(
  ctx: ServerContext,
  input: { projectId: string; path: string; ops: OtOp[] },
): Promise<{ ok: true }> {
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
  await engine.applyOps(docId, input.ops)
  return { ok: true }
}
