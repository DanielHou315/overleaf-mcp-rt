import { parse as parseHtml } from 'node-html-parser'
import { OverleafHttp } from './http.js'
import { OverleafError } from '../errors.js'

export interface ProjectSummary {
  id: string
  name: string
  lastUpdated: string
  ownerEmail: string
}

export interface CompileOutputFile {
  path: string
  url: string
  type: string
  build?: string
}

export interface CompileResponse {
  status: string
  outputFiles: CompileOutputFile[]
  compileGroup?: string
  pdfDownloadDomain?: string
}

export class OverleafRest {
  constructor(private readonly http: OverleafHttp) {}

  async listProjects(): Promise<ProjectSummary[]> {
    const res = await this.http.get('/project')
    const html = await res.text()
    const root = parseHtml(html)
    const meta = root.querySelector('meta[name="ol-prefetchedProjectsBlob"]')
    const content = meta?.getAttribute('content')
    if (!content) {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        'Could not find <meta name="ol-prefetchedProjectsBlob"> in /project HTML',
      )
    }
    let blob: { projects?: Array<Record<string, unknown>> }
    try {
      blob = JSON.parse(content) as typeof blob
    } catch (err) {
      throw new OverleafError('OVERLEAF_GENERIC', 'Invalid JSON in projects blob', {
        cause: String(err),
      })
    }
    return (blob.projects ?? []).map((p) => ({
      id: String(p.id),
      name: String(p.name),
      lastUpdated: String(p.lastUpdated),
      ownerEmail: String((p.owner as { email?: string } | undefined)?.email ?? ''),
    }))
  }
}
