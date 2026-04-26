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
  const tree = await ctx.cache.get(input.projectId)
  const buf = tree.readFile(input.path)
  if (buf === null) {
    throw new NotFoundError(`No file at ${input.path} in project ${input.projectId}`)
  }
  return { contentBase64: buf.toString('base64') }
}
