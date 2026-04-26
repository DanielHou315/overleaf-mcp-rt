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

export interface DownloadedBytes {
  bytes: Buffer
  contentType: string
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

  async compile(
    projectId: string,
    opts: { draft?: boolean; stopOnFirstError?: boolean; rootResourcePath?: string } = {},
  ): Promise<CompileResponse> {
    const res = await this.http.postJson(
      `/project/${encodeURIComponent(projectId)}/compile?auto_compile=true`,
      {
        check: 'silent',
        draft: opts.draft ?? false,
        incrementalCompilesEnabled: true,
        rootResourcePath: opts.rootResourcePath ?? 'main.tex',
        stopOnFirstError: opts.stopOnFirstError ?? false,
      },
    )
    if (!res.ok) {
      throw new OverleafError('OVERLEAF_GENERIC', `compile returned ${res.status}`)
    }
    return (await res.json()) as CompileResponse
  }

  async downloadOutputFile(buildUrl: string): Promise<DownloadedBytes> {
    const res = await this.http.get(buildUrl)
    if (!res.ok) {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        `output file ${buildUrl} returned ${res.status}`,
      )
    }
    const bytes = Buffer.from(await res.arrayBuffer())
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
    return { bytes, contentType }
  }

  async downloadFile(projectId: string, fileId: string): Promise<DownloadedBytes> {
    const res = await this.http.get(
      `/project/${encodeURIComponent(projectId)}/file/${encodeURIComponent(fileId)}`,
    )
    if (!res.ok) {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        `file ${fileId} returned ${res.status}`,
      )
    }
    const bytes = Buffer.from(await res.arrayBuffer())
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
    return { bytes, contentType }
  }

  /**
   * Create an empty text doc under `parentFolderId` with `name`.
   * Returns the new doc's id. The caller can subsequently `write_doc`
   * via OT to populate it.
   *
   * Workshop reference: src/api/base.ts addDoc.
   */
  async createDoc(
    projectId: string,
    parentFolderId: string,
    name: string,
  ): Promise<{ id: string }> {
    const res = await this.http.postJson(`/project/${encodeURIComponent(projectId)}/doc`, {
      name,
      parent_folder_id: parentFolderId,
    })
    if (!res.ok) {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        `createDoc returned ${res.status} for ${name}`,
      )
    }
    const json = (await res.json()) as { _id?: string }
    if (!json._id) {
      throw new OverleafError('OVERLEAF_GENERIC', 'createDoc response missing _id')
    }
    return { id: json._id }
  }

  /** Create an empty folder under `parentFolderId`. Workshop ref: addFolder. */
  async createFolder(
    projectId: string,
    parentFolderId: string,
    name: string,
  ): Promise<{ id: string }> {
    const res = await this.http.postJson(`/project/${encodeURIComponent(projectId)}/folder`, {
      name,
      parent_folder_id: parentFolderId,
    })
    if (!res.ok) {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        `createFolder returned ${res.status} for ${name}`,
      )
    }
    const json = (await res.json()) as { _id?: string }
    if (!json._id) {
      throw new OverleafError('OVERLEAF_GENERIC', 'createFolder response missing _id')
    }
    return { id: json._id }
  }

  /**
   * Upload a binary file under `parentFolderId`. The server may auto-promote
   * the upload to a doc if the filename matches the configured textExtensions
   * — in that case we surface `kind: 'doc'`.
   *
   * Workshop reference: src/api/base.ts uploadFile (uses multipart form-data).
   */
  async uploadFile(
    projectId: string,
    parentFolderId: string,
    name: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<{ id: string; kind: 'doc' | 'file' }> {
    const form = new FormData()
    form.append('targetFolderId', parentFolderId)
    form.append('name', name)
    form.append('type', mimeType)
    form.append(
      'qqfile',
      new File([bytes], name, { type: mimeType }),
      name,
    )
    const path =
      `/project/${encodeURIComponent(projectId)}/upload` +
      `?folder_id=${encodeURIComponent(parentFolderId)}`
    const res = await this.http.postForm(path, form)
    if (!res.ok) {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        `uploadFile returned ${res.status} for ${name}`,
      )
    }
    const json = (await res.json()) as { entity_id?: string; entity_type?: string }
    if (!json.entity_id || !json.entity_type) {
      throw new OverleafError('OVERLEAF_GENERIC', 'uploadFile response missing entity_id/entity_type')
    }
    if (json.entity_type !== 'doc' && json.entity_type !== 'file') {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        `uploadFile got unexpected entity_type ${json.entity_type}`,
      )
    }
    return { id: json.entity_id, kind: json.entity_type }
  }
}
