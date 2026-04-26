import type { ServerContext } from '../server.js'
import { NotFoundError } from '../../errors.js'

export interface MutationResult {
  ok: true
  id: string
  kind: 'doc' | 'file' | 'folder'
}

/**
 * Resolve a parent path to its folder id (or root) on the engine, throwing
 * NotFoundError if the path is missing or doesn't refer to a folder.
 *
 * Empty string ⇒ root.
 */
async function resolveParentFolderId(
  ctx: ServerContext,
  projectId: string,
  parentPath: string,
): Promise<string> {
  const engine = await ctx.ot.get(projectId)
  const folderId = engine.pathToFolderId(parentPath)
  if (folderId === null) {
    throw new NotFoundError(
      `parentPath ${parentPath || '(root)'} is not a folder in project ${projectId}`,
      { projectId, parentPath },
    )
  }
  return folderId
}

export async function handleCreateFolder(
  ctx: ServerContext,
  input: { projectId: string; parentPath: string; name: string },
): Promise<MutationResult> {
  const parentFolderId = await resolveParentFolderId(ctx, input.projectId, input.parentPath)
  const { id } = await ctx.rest.createFolder(input.projectId, parentFolderId, input.name)
  // Wait for the realtime broadcast so subsequent reads see a coherent tree.
  const engine = await ctx.ot.get(input.projectId)
  const newPath = input.parentPath === '' ? input.name : `${input.parentPath}/${input.name}`
  await engine.waitForPath(newPath).catch(() => {
    // Timeout is non-fatal — REST already succeeded; the next get_project_tree
    // call will see the new folder once the broadcast catches up.
  })
  return { ok: true, id, kind: 'folder' }
}

export async function handleCreateDoc(
  ctx: ServerContext,
  input: { projectId: string; parentPath: string; name: string; content?: string },
): Promise<MutationResult> {
  const parentFolderId = await resolveParentFolderId(ctx, input.projectId, input.parentPath)
  const { id } = await ctx.rest.createDoc(input.projectId, parentFolderId, input.name)
  const engine = await ctx.ot.get(input.projectId)
  const newPath = input.parentPath === '' ? input.name : `${input.parentPath}/${input.name}`
  await engine.waitForPath(newPath).catch(() => {
    // Broadcast hasn't caught up; OT-write below will fail loudly if needed.
  })
  if (input.content !== undefined && input.content !== '') {
    await engine.writeDoc(id, input.content)
  }
  return { ok: true, id, kind: 'doc' }
}

export async function handleUploadFile(
  ctx: ServerContext,
  input: {
    projectId: string
    parentPath: string
    name: string
    contentBase64: string
    mimeType: string
  },
): Promise<MutationResult> {
  const parentFolderId = await resolveParentFolderId(ctx, input.projectId, input.parentPath)
  const bytes = new Uint8Array(Buffer.from(input.contentBase64, 'base64'))
  const { id, kind } = await ctx.rest.uploadFile(
    input.projectId,
    parentFolderId,
    input.name,
    bytes,
    input.mimeType,
  )
  const engine = await ctx.ot.get(input.projectId)
  const newPath = input.parentPath === '' ? input.name : `${input.parentPath}/${input.name}`
  await engine.waitForPath(newPath).catch(() => {
    /* tree will catch up shortly */
  })
  return { ok: true, id, kind }
}
