import { ProjectTree } from './tree.js'

export interface CacheOptions {
  ttlMs?: number
}

interface Entry {
  tree: ProjectTree
  fetchedAt: number
}

export class ProjectCache {
  private readonly entries = new Map<string, Entry>()
  private readonly inflight = new Map<string, Promise<ProjectTree>>()
  private readonly ttlMs: number

  constructor(
    private readonly fetcher: (projectId: string) => Promise<ProjectTree>,
    opts: CacheOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 60_000
  }

  async get(projectId: string): Promise<ProjectTree> {
    const existing = this.entries.get(projectId)
    if (existing && Date.now() - existing.fetchedAt < this.ttlMs) {
      return existing.tree
    }
    const inflight = this.inflight.get(projectId)
    if (inflight) return inflight

    const promise = this.fetcher(projectId)
      .then((tree) => {
        this.entries.set(projectId, { tree, fetchedAt: Date.now() })
        this.inflight.delete(projectId)
        return tree
      })
      .catch((err: unknown) => {
        this.inflight.delete(projectId)
        throw err
      })
    this.inflight.set(projectId, promise)
    return promise
  }

  invalidate(projectId: string) {
    this.entries.delete(projectId)
  }

  invalidateAll() {
    this.entries.clear()
  }
}
