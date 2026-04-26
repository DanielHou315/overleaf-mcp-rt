import type { SocketLike } from './socket.js'
import type {
  DocEntity,
  FileRefEntity,
  FolderEntity,
  JoinProjectResponse,
  ProjectEntity,
} from './ot.types.js'
import { OverleafError } from '../errors.js'

/** Mirrors v0.1's TreeNode shape so MCP tool outputs stay stable. */
export interface TreeNode {
  files: string[]
  folders: Record<string, TreeNode>
}

export interface DocBaseline {
  docId: string
  text: string
  version: number
}

interface PathEntry {
  kind: 'doc' | 'file' | 'folder'
  id: string
  parentFolderId: string | null
}

export interface OtEngineOptions {
  socket: SocketLike
  projectId: string
}

/**
 * Per-project OT engine. Owns one Socket.IO connection (via SocketLike),
 * the canonical tree state, the per-doc baseline cache, and the publicId
 * used to filter our own otUpdateApplied broadcasts.
 *
 * Lifecycle: construct with a SocketLike (already opened), then `await
 * connect()` which emits joinProject and waits for joinProjectResponse +
 * connectionAccepted. After that the engine is ready for joinDoc / writeDoc.
 */
export class OtEngine {
  readonly projectId: string
  private readonly socket: SocketLike
  private _publicId: string | null = null
  private _isConnected = false
  private project: ProjectEntity | null = null
  /** Flat index: path → entry. Built/updated in updatePathIndex(). */
  private pathIndex = new Map<string, PathEntry>()

  /** Listener handles we install — cleaned up on disconnect(). */
  private installedHandlers: Array<{ event: string; handler: (...args: unknown[]) => void }> = []
  private baselines = new Map<string, DocBaseline>()
  private inflightJoinDoc = new Map<string, Promise<DocBaseline>>()

  constructor(opts: OtEngineOptions) {
    this.socket = opts.socket
    this.projectId = opts.projectId
  }

  get publicId(): string | null { return this._publicId }
  get isConnected(): boolean { return this._isConnected }

  /**
   * Wait for the server-driven handshake to complete. Resolves when
   * BOTH connectionAccepted (carries publicId) AND joinProjectResponse
   * (carries the tree) have arrived. Rejects on connectionRejected.
   */
  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let gotPublicId = false
      let gotProject = false
      const finishIfReady = () => {
        if (gotPublicId && gotProject) {
          this._isConnected = true
          resolve()
        }
      }

      const onConnAccepted = (_: unknown, publicId: string): void => {
        this._publicId = publicId
        gotPublicId = true
        finishIfReady()
      }
      const onJoinResponse = (res: JoinProjectResponse): void => {
        this.project = res.project
        // joinProjectResponse can carry publicId too — treat as authoritative.
        if (res.publicId) {
          this._publicId = res.publicId
          gotPublicId = true
        }
        this.rebuildPathIndex()
        gotProject = true
        finishIfReady()
      }
      const onConnRejected = (err: { message?: string } | string): void => {
        const msg = typeof err === 'string' ? err : err?.message ?? 'connection rejected'
        reject(new OverleafError('OVERLEAF_AUTH_FAILED', `OT connectionRejected: ${msg}`))
      }

      this.installListener('connectionAccepted', onConnAccepted as (...args: unknown[]) => void)
      this.installListener('joinProjectResponse', onJoinResponse as (...args: unknown[]) => void)
      this.installListener('connectionRejected', onConnRejected as (...args: unknown[]) => void)

      // v2 mode is server-driven (the URL's projectId query causes CE to push
      // joinProjectResponse autonomously), but Workshop emits defensively in
      // case the server is in v1 mode or otherwise needs the explicit prod.
      // Belt-and-suspenders — if joinProjectResponse already arrived above,
      // the emit is harmless.
      this.socket.emit('joinProject', { project_id: this.projectId })
    })
  }

  /** Path → docId, or null. */
  pathToDocId(path: string): string | null {
    const entry = this.pathIndex.get(path)
    return entry?.kind === 'doc' ? entry.id : null
  }

  /** Path → fileId (binary), or null. */
  pathToFileId(path: string): string | null {
    const entry = this.pathIndex.get(path)
    return entry?.kind === 'file' ? entry.id : null
  }

  /** Folder/file tree in the same shape as v0.1's ProjectTree.asTree(). */
  getTree(): TreeNode {
    const root: TreeNode = { files: [], folders: {} }
    if (!this.project) return root
    this.populateTreeNode(root, this.project.rootFolder[0]!)
    return root
  }

  /**
   * Join a doc and cache its baseline. Idempotent within a session — a
   * second call returns the cached baseline without re-emitting joinDoc.
   * Concurrent calls for the same docId are coalesced.
   */
  async joinDoc(docId: string): Promise<DocBaseline> {
    if (!this._isConnected) {
      throw new OverleafError('OVERLEAF_GENERIC', 'OtEngine not connected')
    }
    const cached = this.baselines.get(docId)
    if (cached) return cached
    const inflight = this.inflightJoinDoc.get(docId)
    if (inflight) return inflight

    const promise = this.socket
      .emitWithAck('joinDoc', docId, { encodeRanges: true })
      .then((data) => {
        const [lines, version] = data as [string[], number, ...unknown[]]
        const text = decodeLatin1Lines(lines)
        const baseline: DocBaseline = { docId, text, version }
        this.baselines.set(docId, baseline)
        this.inflightJoinDoc.delete(docId)
        return baseline
      })
      .catch((err: unknown) => {
        this.inflightJoinDoc.delete(docId)
        throw err
      })
    this.inflightJoinDoc.set(docId, promise)
    return promise
  }

  /** Return the cached baseline text for a doc, or null if not joined yet. */
  readDoc(docId: string): string | null {
    return this.baselines.get(docId)?.text ?? null
  }

  /** For internal use by Tasks 8/9 — read or fetch the baseline. */
  protected getBaseline(docId: string): DocBaseline | undefined {
    return this.baselines.get(docId)
  }

  /** For internal use by Task 9's resync path. */
  protected clearBaseline(docId: string): void {
    this.baselines.delete(docId)
  }

  /** Disconnect socket, flush handlers. */
  disconnect(): void {
    for (const { event, handler } of this.installedHandlers) {
      this.socket.off(event, handler)
    }
    this.installedHandlers = []
    this._isConnected = false
    this.socket.disconnect()
  }

  // ---- internals (also called by later tasks) ----

  protected installListener(event: string, handler: (...args: unknown[]) => void): void {
    this.socket.on(event, handler)
    this.installedHandlers.push({ event, handler })
  }

  protected getProject(): ProjectEntity | null { return this.project }

  /** Rebuild path → entity index from scratch. Call after joinProjectResponse. */
  protected rebuildPathIndex(): void {
    this.pathIndex.clear()
    if (!this.project) return
    this.indexFolder(this.project.rootFolder[0]!, '', null)
  }

  private indexFolder(folder: FolderEntity, prefix: string, parentId: string | null): void {
    const folderPath = prefix === '' ? '' : prefix.replace(/\/$/, '')
    if (folderPath !== '') {
      this.pathIndex.set(folderPath, { kind: 'folder', id: folder._id, parentFolderId: parentId })
    }
    for (const doc of folder.docs) {
      this.pathIndex.set(prefix + doc.name, { kind: 'doc', id: doc._id, parentFolderId: folder._id })
    }
    for (const file of folder.fileRefs) {
      this.pathIndex.set(prefix + file.name, { kind: 'file', id: file._id, parentFolderId: folder._id })
    }
    for (const sub of folder.folders) {
      this.indexFolder(sub, prefix + sub.name + '/', folder._id)
    }
  }

  private populateTreeNode(node: TreeNode, folder: FolderEntity): void {
    for (const doc of folder.docs) node.files.push(doc.name)
    for (const file of folder.fileRefs) node.files.push(file.name)
    for (const sub of folder.folders) {
      const child: TreeNode = { files: [], folders: {} }
      node.folders[sub.name] = child
      this.populateTreeNode(child, sub)
    }
  }
}

/**
 * Overleaf packs UTF-8 doc bytes through latin1 over the Socket.IO transport.
 * Each line comes back as a latin1 string whose char codes are the original
 * UTF-8 byte values; reconstruct UTF-8 by treating the chars as latin1 bytes.
 *
 * Workshop reference: src/api/socketio.ts joinDoc handler.
 */
function decodeLatin1Lines(lines: string[]): string {
  return lines.map((line) => Buffer.from(line, 'latin1').toString('utf-8')).join('\n')
}
