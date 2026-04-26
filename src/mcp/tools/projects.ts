import type { ServerContext } from '../server.js'
import type { TreeNode } from '../../overleaf/ot.js'

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
  const engine = await ctx.ot.get(input.projectId)
  return { tree: engine.getTree() }
}
