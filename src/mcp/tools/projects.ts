import type { ServerContext } from '../server.js'
import type { TreeNode } from '../../overleaf/tree.js'

export async function handleListProjects(
  ctx: ServerContext,
  _input: Record<string, never>,
): Promise<{ projects: Array<{ id: string; name: string; lastUpdated: string; ownerEmail: string }> }> {
  const projects = await ctx.rest.listProjects()
  return { projects }
}

export async function handleGetProjectTree(
  ctx: ServerContext,
  input: { projectId: string },
): Promise<{ tree: TreeNode }> {
  const tree = await ctx.cache.get(input.projectId)
  return { tree: tree.asTree() }
}
