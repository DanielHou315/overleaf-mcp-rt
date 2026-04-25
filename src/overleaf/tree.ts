import { OverleafError } from '../errors.js'
import type { ProjectEntry as ZipEntry } from './zip.js'

export type ProjectEntry = ZipEntry

export interface TreeNode {
  files: string[]
  folders: Record<string, TreeNode>
}

export class ProjectTree {
  private readonly byPath: Map<string, ProjectEntry>

  constructor(entries: ProjectEntry[]) {
    this.byPath = new Map(entries.map((e) => [e.path, e]))
  }

  readDoc(path: string): string | null {
    const entry = this.byPath.get(path)
    if (!entry) return null
    if (entry.kind !== 'text') {
      throw new OverleafError('NOT_FOUND', `Path ${path} is binary, not text`)
    }
    return entry.content
  }

  readFile(path: string): Buffer | null {
    const entry = this.byPath.get(path)
    if (!entry) return null
    if (entry.kind !== 'binary') {
      throw new OverleafError('NOT_FOUND', `Path ${path} is text, not binary`)
    }
    return entry.content
  }

  asTree(): TreeNode {
    const root: TreeNode = { files: [], folders: {} }
    for (const path of this.byPath.keys()) {
      const parts = path.split('/')
      let cursor = root
      for (let i = 0; i < parts.length - 1; i++) {
        const folder = parts[i]!
        cursor.folders[folder] ??= { files: [], folders: {} }
        cursor = cursor.folders[folder]!
      }
      cursor.files.push(parts[parts.length - 1]!)
    }
    return root
  }

  listPaths(): string[] {
    return Array.from(this.byPath.keys()).sort()
  }
}
