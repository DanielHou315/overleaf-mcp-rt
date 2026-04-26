import type { ServerContext } from '../server.js'
import { NotFoundError } from '../../errors.js'

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
