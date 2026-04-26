import type { ServerContext } from '../server.js'
import { NotFoundError } from '../../errors.js'
import { effectiveMime } from './mime.js'

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
    mimeType?: string
  },
): Promise<MutationResult> {
  const parentFolderId = await resolveParentFolderId(ctx, input.projectId, input.parentPath)
  const bytes = new Uint8Array(Buffer.from(input.contentBase64, 'base64'))
  const mime = effectiveMime(input.mimeType ?? '', input.name)
  const { id, kind } = await ctx.rest.uploadFile(
    input.projectId,
    parentFolderId,
    input.name,
    bytes,
    mime,
  )
  const engine = await ctx.ot.get(input.projectId)
  const newPath = input.parentPath === '' ? input.name : `${input.parentPath}/${input.name}`
  await engine.waitForPath(newPath).catch(() => {
    /* tree will catch up shortly */
  })
  return { ok: true, id, kind }
}

async function resolvePathEntity(
  ctx: ServerContext,
  projectId: string,
  path: string,
): Promise<{ kind: 'doc' | 'file' | 'folder'; id: string }> {
  const engine = await ctx.ot.get(projectId)
  const entity = engine.pathToEntity(path)
  if (!entity) {
    throw new NotFoundError(`No entity at ${path} in project ${projectId}`, {
      projectId, path,
    })
  }
  return entity
}

export async function handleRename(
  ctx: ServerContext,
  input: { projectId: string; path: string; newName: string },
): Promise<MutationResult> {
  const { kind, id } = await resolvePathEntity(ctx, input.projectId, input.path)
  await ctx.rest.renameEntity(input.projectId, kind, id, input.newName)
  // Best-effort wait for the broadcast.
  const engine = await ctx.ot.get(input.projectId)
  const lastSlash = input.path.lastIndexOf('/')
  const newPath = lastSlash >= 0
    ? `${input.path.slice(0, lastSlash)}/${input.newName}`
    : input.newName
  await engine.waitForPath(newPath).catch(() => undefined)
  return { ok: true, id, kind }
}

export async function handleMove(
  ctx: ServerContext,
  input: { projectId: string; path: string; newParentPath: string },
): Promise<MutationResult> {
  const { kind, id } = await resolvePathEntity(ctx, input.projectId, input.path)
  const newParentFolderId = await resolveParentFolderId(
    ctx,
    input.projectId,
    input.newParentPath,
  )
  await ctx.rest.moveEntity(input.projectId, kind, id, newParentFolderId)
  const engine = await ctx.ot.get(input.projectId)
  const lastSlash = input.path.lastIndexOf('/')
  const name = lastSlash >= 0 ? input.path.slice(lastSlash + 1) : input.path
  const newPath = input.newParentPath === '' ? name : `${input.newParentPath}/${name}`
  await engine.waitForPath(newPath).catch(() => undefined)
  return { ok: true, id, kind }
}

export async function handleDeleteEntity(
  ctx: ServerContext,
  input: { projectId: string; path: string },
): Promise<MutationResult> {
  const { kind, id } = await resolvePathEntity(ctx, input.projectId, input.path)
  await ctx.rest.deleteEntity(input.projectId, kind, id)
  return { ok: true, id, kind }
}
