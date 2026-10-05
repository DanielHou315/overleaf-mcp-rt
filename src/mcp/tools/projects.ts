import type { ServerContext } from '../server.js'
import type { TreeNode } from '../../overleaf/ot.js'

export async function handleListProjects(
  ctx: ServerContext,
  _input: Record<string, never>,
): Promise<{ projects: Array<{ id: string; name: string; lastUpdated: string; ownerEmail: string }> }> {
  const projects = await ctx.rest.listProjects()
  return { projects }
}

export async function handleCreateProject(
  ctx: ServerContext,
  input: { name: string; template?: 'blank' | 'example' },
): Promise<{ projectId: string; name: string; template: 'blank' | 'example' }> {
  const template = input.template ?? 'blank'
  const created = await ctx.rest.createProject(input.name, template)
  return { projectId: created.id, name: input.name, template }
}

export async function handleCloneProject(
  ctx: ServerContext,
  input: { projectId: string; name: string },
): Promise<{ projectId: string; sourceProjectId: string; name: string }> {
  const created = await ctx.rest.cloneProject(input.projectId, input.name)
  return { projectId: created.id, sourceProjectId: input.projectId, name: input.name }
}

export async function handleRenameProject(
  ctx: ServerContext,
  input: { projectId: string; newName: string },
): Promise<{ ok: true; projectId: string; name: string }> {
  await ctx.rest.renameProject(input.projectId, input.newName)
  return { ok: true, projectId: input.projectId, name: input.newName }
}

export async function handleArchiveProject(
  ctx: ServerContext,
  input: { projectId: string },
): Promise<{ ok: true; projectId: string }> {
  await ctx.rest.archiveProject(input.projectId)
  return { ok: true, projectId: input.projectId }
}

export async function handleUnarchiveProject(
  ctx: ServerContext,
  input: { projectId: string },
): Promise<{ ok: true; projectId: string }> {
  await ctx.rest.unarchiveProject(input.projectId)
  return { ok: true, projectId: input.projectId }
}

export async function handleTrashProject(
  ctx: ServerContext,
  input: { projectId: string },
): Promise<{ ok: true; projectId: string }> {
  await ctx.rest.trashProject(input.projectId)
  return { ok: true, projectId: input.projectId }
}

export async function handleUntrashProject(
  ctx: ServerContext,
  input: { projectId: string },
): Promise<{ ok: true; projectId: string }> {
  await ctx.rest.untrashProject(input.projectId)
  return { ok: true, projectId: input.projectId }
}

export async function handleDeleteProject(
  ctx: ServerContext,
  input: { projectId: string },
): Promise<{ ok: true; projectId: string }> {
  await ctx.rest.deleteProject(input.projectId)
  return { ok: true, projectId: input.projectId }
}

export async function handleGetProjectTree(
  ctx: ServerContext,
  input: { projectId: string },
): Promise<{ tree: TreeNode }> {
  const engine = await ctx.ot.get(input.projectId)
  return { tree: engine.getTree() }
}
