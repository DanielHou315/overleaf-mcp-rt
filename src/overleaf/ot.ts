// Portions of this file are ported from Overleaf-Workshop
// (https://github.com/iamhyc/Overleaf-Workshop), specifically
// src/api/socketio.ts. Used under AGPL-3.0-or-later.
import type { SocketLike } from './socket.js'
import type {
  DocEntity,
  FileRefEntity,
  FolderEntity,
  JoinProjectResponse,
  ProjectEntity,
} from './ot.types.js'
import { OverleafError, OtVersionConflictError } from '../errors.js'
import { computeOps, type OtOp } from './diff.js'

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
  /** Called on reconnect to obtain a fresh socket. If omitted, reconnect is disabled. */
  socketFactory?: () => SocketLike
  /** Initial backoff delay in ms (default 500). Doubles each attempt up to 30s. */
  reconnectInitialDelayMs?: number
  /** Max attempts before giving up (default 10). */
  reconnectMaxAttempts?: number
  /**
   * Called when the engine has exhausted reconnectMaxAttempts and given up.
   * The OtEngineRegistry uses this to evict the dead engine from its cache so
   * the next consumer gets a fresh one.
   */
  onReconnectFailed?: () => void
  /**
   * Test seam: override setTimeout for reconnect scheduling. Defaults to the
   * global setTimeout.
   */
  schedule?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
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
  private currentSocket: SocketLike
  private readonly socketFactory: (() => SocketLike) | null
  private readonly reconnectInitialDelayMs: number
  private readonly reconnectMaxAttempts: number
  private readonly onReconnectFailed: (() => void) | null
  private readonly schedule: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _publicId: string | null = null
  private _isConnected = false
  private project: ProjectEntity | null = null
  /** Flat index: path → entry. Built/updated in updatePathIndex(). */
  private pathIndex = new Map<string, PathEntry>()

  /** Listener handles we install — cleaned up on disconnect(). */
  private installedHandlers: Array<{ event: string; handler: (...args: unknown[]) => void }> = []
  private baselines = new Map<string, DocBaseline>()
  private inflightJoinDoc = new Map<string, Promise<DocBaseline>>()
  /** Per-docId promise chain for write serialization. */
  private writeQueues = new Map<string, Promise<void>>()

  constructor(opts: OtEngineOptions) {
    this.currentSocket = opts.socket
    this.projectId = opts.projectId
    this.socketFactory = opts.socketFactory ?? null
    this.reconnectInitialDelayMs = opts.reconnectInitialDelayMs ?? 500
    this.reconnectMaxAttempts = opts.reconnectMaxAttempts ?? 10
    this.onReconnectFailed = opts.onReconnectFailed ?? null
    this.schedule = opts.schedule ?? setTimeout
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
          this.installTreeEventHandlers()
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

      const onDisconnect = (..._args: unknown[]): void => {
        // Don't trigger reconnect during graceful shutdown — disconnect() removes
        // listeners before calling socket.disconnect(), so the handler won't fire
        // for our own teardown.
        this.scheduleReconnect()
      }
      this.installListener('forceDisconnect', onDisconnect)
      this.installListener('disconnect', onDisconnect)

      // v2 mode is server-driven (the URL's projectId query causes CE to push
      // joinProjectResponse autonomously), but Workshop emits defensively in
      // case the server is in v1 mode or otherwise needs the explicit prod.
      // Belt-and-suspenders — if joinProjectResponse already arrived above,
      // the emit is harmless.
      this.currentSocket.emit('joinProject', { project_id: this.projectId })
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

  /** Path → root folder id, or null before connect. */
  get rootFolderId(): string | null {
    const project = this.getProject()
    return project?.rootFolder[0]?._id ?? null
  }

  /** Path → { kind, id }. Empty string returns null (use rootFolderId for the root). */
  pathToEntity(path: string): { kind: 'doc' | 'file' | 'folder'; id: string } | null {
    const entry = this.pathIndex.get(path)
    if (!entry) return null
    return { kind: entry.kind, id: entry.id }
  }

  /** Path → folder id. Empty string resolves to the root folder id. */
  pathToFolderId(path: string): string | null {
    if (path === '') return this.rootFolderId
    const entry = this.pathIndex.get(path)
    return entry?.kind === 'folder' ? entry.id : null
  }

  /**
   * Resolve once `path` appears in the path index, or reject after timeoutMs.
   *
   * Tree mutations go through REST and return the new entity id immediately,
   * but our pathIndex is updated by the recive* / removeEntity broadcast that
   * arrives shortly after. Callers that want to operate on the new path
   * (e.g. write_doc to a freshly-created doc) await this before proceeding.
   *
   * Resolves immediately if the path is already in the index. Otherwise polls
   * every 25ms until the path appears or the timeout fires. Default timeout
   * is 2000ms — long enough for any realistic broadcast latency, short enough
   * to surface a real coherence problem rather than hanging.
   */
  async waitForPath(
    path: string,
    timeoutMs = 2000,
  ): Promise<{ kind: 'doc' | 'file' | 'folder'; id: string }> {
    const POLL_INTERVAL_MS = 25
    const deadline = Date.now() + timeoutMs
    while (true) {
      const entity = this.pathToEntity(path)
      if (entity) return entity
      if (Date.now() >= deadline) {
        throw new OverleafError(
          'OVERLEAF_GENERIC',
          `waitForPath timed out after ${timeoutMs}ms for ${path}`,
          { path, timeoutMs },
        )
      }
      await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS))
    }
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

    const promise = this.currentSocket
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

  /**
   * Replace the doc's text with newContent via OT. Computes ops, emits
   * applyOtUpdate, awaits ack + the matching otUpdateApplied echo, then
   * bumps the baseline.
   *
   * If no baseline is cached, joinDoc is called first (lazy join).
   */
  async writeDoc(docId: string, newContent: string): Promise<void> {
    let baseline = this.getBaseline(docId)
    if (!baseline) {
      baseline = await this.joinDoc(docId)
    }
    if (baseline.text === newContent) return // no-op
    const ops = computeOps(baseline.text, newContent)
    if (ops.length === 0) return
    await this.applyOps(docId, ops)
  }

  /**
   * Lower-level: emit raw OT ops at the current baseline version. The MCP
   * `apply_patch` tool routes here.
   */
  async applyOps(docId: string, ops: OtOp[]): Promise<void> {
    // Chain onto any in-flight write for the same docId so concurrent
    // callers can't both read the same baseline. Across different docIds,
    // calls run in parallel.
    const previous = this.writeQueues.get(docId) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined) // a prior failure must not block the next caller
      .then(() => this.applyOpsWithResync(docId, ops, /* attemptsLeft */ 1))
    this.writeQueues.set(docId, next)
    try {
      await next
    } finally {
      // If we're the tail of the queue, clear the entry so the map doesn't grow.
      if (this.writeQueues.get(docId) === next) {
        this.writeQueues.delete(docId)
      }
    }
  }

  private async applyOpsWithResync(docId: string, ops: OtOp[], attemptsLeft: number): Promise<void> {
    let baseline = this.getBaseline(docId)
    if (!baseline) baseline = await this.joinDoc(docId)

    const update = { doc: docId, op: ops, v: baseline.version }

    try {
      // The applyOtUpdate ack IS the commit confirmation — the server only
      // acks after the doc-updater service applies the op. We do NOT wait for
      // an `otUpdateApplied` echo: the server omits `meta` for own-writes
      // (sends just `{doc, v}`), so filtering by `meta.source === publicId`
      // would hang forever. Workshop's applyOtUpdate likewise only awaits
      // the ack (src/api/socketio.ts:applyOtUpdate).
      await this.currentSocket.emitWithAck('applyOtUpdate', docId, update)
    } catch (err) {
      if (isVersionMismatch(err) && attemptsLeft > 0) {
        // Resync: drop baseline, re-joinDoc, recompute ops, retry.
        this.clearBaseline(docId)
        const fresh = await this.joinDoc(docId)
        // Recompute ops against the new text. The original ops were authored
        // against an older baseline, so we re-derive what the agent intended:
        // apply old ops to the OLD baseline text to get the desired final
        // text, then diff THAT against the new baseline.
        const oldText = applyOpsLocal(baseline.text, ops)
        const recomputedOps = computeOps(fresh.text, oldText)
        if (recomputedOps.length === 0) return
        return this.applyOpsWithResync(docId, recomputedOps, attemptsLeft - 1)
      }
      if (isVersionMismatch(err)) {
        throw new OtVersionConflictError(
          `Doc ${docId} kept conflicting after resync`,
          { docId, baselineVersion: baseline.version },
        )
      }
      throw err instanceof Error ? err : new OverleafError('OVERLEAF_GENERIC', String(err))
    }

    // Bump baseline locally — server has applied the op.
    const stillBaseline = this.getBaseline(docId)
    if (stillBaseline) {
      stillBaseline.text = applyOpsLocal(stillBaseline.text, ops)
      stillBaseline.version = baseline.version + 1
    }
  }

  private installTreeEventHandlers(): void {
    this.installListener('reciveNewDoc', (parentFolderId: unknown, doc: unknown) =>
      this.applyNewEntity(parentFolderId as string, doc as DocEntity, 'doc'),
    )
    this.installListener('reciveNewFile', (parentFolderId: unknown, file: unknown) =>
      this.applyNewEntity(parentFolderId as string, file as FileRefEntity, 'file'),
    )
    this.installListener('reciveNewFolder', (parentFolderId: unknown, folder: unknown) =>
      this.applyNewEntity(parentFolderId as string, folder as FolderEntity, 'folder'),
    )
    this.installListener('reciveEntityRename', (entityId: unknown, newName: unknown) =>
      this.applyRename(entityId as string, newName as string),
    )
    this.installListener('reciveEntityMove', (entityId: unknown, newParentId: unknown) =>
      this.applyMove(entityId as string, newParentId as string),
    )
    this.installListener('removeEntity', (entityId: unknown) =>
      this.applyRemove(entityId as string),
    )
  }

  private applyNewEntity(
    parentFolderId: string,
    entity: DocEntity | FileRefEntity | FolderEntity,
    kind: 'doc' | 'file' | 'folder',
  ): void {
    const project = this.getProject()
    if (!project) return
    const parent = findFolder(project.rootFolder[0]!, parentFolderId)
    if (!parent) return
    if (kind === 'doc') parent.docs.push(entity as DocEntity)
    else if (kind === 'file') parent.fileRefs.push(entity as FileRefEntity)
    else parent.folders.push(entity as FolderEntity)
    this.rebuildPathIndex()
  }

  private applyRename(entityId: string, newName: string): void {
    const project = this.getProject()
    if (!project) return
    const found = findEntity(project.rootFolder[0]!, entityId)
    if (!found) return
    found.entity.name = newName
    this.rebuildPathIndex()
  }

  private applyMove(entityId: string, newParentId: string): void {
    const project = this.getProject()
    if (!project) return
    const target = findEntity(project.rootFolder[0]!, entityId)
    const newParent = findFolder(project.rootFolder[0]!, newParentId)
    if (!target || !newParent) return
    // Remove from old parent
    const arr = this.containerArray(target.parent, target.kind)
    const idx = arr.findIndex((e) => e._id === entityId)
    if (idx >= 0) arr.splice(idx, 1)
    // Add to new parent
    const newArr = this.containerArray(newParent, target.kind)
    newArr.push(target.entity as never)
    this.rebuildPathIndex()
  }

  private applyRemove(entityId: string): void {
    const project = this.getProject()
    if (!project) return
    const found = findEntity(project.rootFolder[0]!, entityId)
    if (!found) return
    const arr = this.containerArray(found.parent, found.kind)
    const idx = arr.findIndex((e) => e._id === entityId)
    if (idx >= 0) arr.splice(idx, 1)
    this.rebuildPathIndex()
    // Drop any cached baseline for this doc
    this.clearBaseline(entityId)
  }

  private containerArray(folder: FolderEntity, kind: 'doc' | 'file' | 'folder'): Array<{ _id: string; name: string }> {
    if (kind === 'doc') return folder.docs
    if (kind === 'file') return folder.fileRefs
    return folder.folders as unknown as Array<{ _id: string; name: string }>
  }

  private scheduleReconnect(): void {
    if (!this.socketFactory) return
    if (this.reconnectTimer) return // already scheduled
    if (this.reconnectAttempt >= this.reconnectMaxAttempts) {
      this._isConnected = false
      if (this.onReconnectFailed) this.onReconnectFailed()
      return
    }

    // Drop old state. In-flight writes will see their underlying ws fail
    // when the socket closes; emitWithAck rejects, applyOpsWithResync
    // surfaces the error to the caller as NetworkError.
    this._isConnected = false
    this.baselines.clear()
    this.inflightJoinDoc.clear()
    for (const { event, handler } of this.installedHandlers) {
      this.currentSocket.off(event, handler)
    }
    this.installedHandlers = []
    try { this.currentSocket.disconnect() } catch { /* old socket may already be torn down */ }

    const baseDelay = Math.min(
      this.reconnectInitialDelayMs * 2 ** this.reconnectAttempt,
      30_000,
    )
    // Jitter ∈ [0.5, 1.5) × base. Spreads coordinated client herds.
    const delay = Math.round(baseDelay * (0.5 + Math.random()))
    this.reconnectAttempt += 1
    this.reconnectTimer = this.schedule(() => {
      this.reconnectTimer = null
      this.currentSocket = this.socketFactory!()
      void this.connect().then(
        () => { this.reconnectAttempt = 0 },
        () => this.scheduleReconnect(),
      )
    }, delay)
  }

  /** Disconnect socket, flush handlers. */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    for (const { event, handler } of this.installedHandlers) {
      this.currentSocket.off(event, handler)
    }
    this.installedHandlers = []
    this._isConnected = false
    this.currentSocket.disconnect()
  }

  // ---- internals (also called by later tasks) ----

  protected installListener(event: string, handler: (...args: unknown[]) => void): void {
    this.currentSocket.on(event, handler)
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
 * Function the registry calls to mint a new socket (and optionally a
 * socketFactory for reconnect) for a given projectId. Returns the inputs
 * `OtEngine` needs at construction time minus the projectId.
 */
export type OtEngineFactory = (projectId: string) => {
  socket: SocketLike
  socketFactory?: () => SocketLike
  reconnectInitialDelayMs?: number
  reconnectMaxAttempts?: number
}

export class OtEngineRegistry {
  private engines = new Map<string, OtEngine>()
  private inflight = new Map<string, Promise<OtEngine>>()

  constructor(private readonly factory: OtEngineFactory) {}

  async get(projectId: string): Promise<OtEngine> {
    const cached = this.engines.get(projectId)
    if (cached) return cached
    const inflight = this.inflight.get(projectId)
    if (inflight) return inflight

    const promise = (async () => {
      const inputs = this.factory(projectId)
      const engine = new OtEngine({
        projectId,
        ...inputs,
        onReconnectFailed: () => {
          // Evict the dead engine so the next get() rebuilds it.
          this.engines.delete(projectId)
        },
      })
      try {
        await engine.connect()
        this.engines.set(projectId, engine)
        return engine
      } catch (err) {
        try { engine.disconnect() } catch { /* may already be torn down */ }
        throw err
      } finally {
        this.inflight.delete(projectId)
      }
    })()
    this.inflight.set(projectId, promise)
    return promise
  }

  /** Disconnect and drop every engine. */
  async closeAll(): Promise<void> {
    for (const engine of this.engines.values()) engine.disconnect()
    this.engines.clear()
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

function isVersionMismatch(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown; name?: unknown }
  if (typeof e.code === 'string' && /version|OutOfSync/i.test(e.code)) return true
  if (typeof e.message === 'string' && /version|out.of.sync|conflict/i.test(e.message)) return true
  return false
}

/**
 * Apply ops to text locally to derive the post-update baseline. Mirrors what
 * the server will do; we use this (instead of waiting for the server to
 * echo back the resulting text) because Overleaf's otUpdateApplied
 * broadcasts only carry the op + version, not the resulting text.
 */
function applyOpsLocal(text: string, ops: OtOp[]): string {
  let out = text
  for (const op of ops) {
    if (op.i !== undefined) {
      out = out.slice(0, op.p) + op.i + out.slice(op.p)
    } else if (op.d !== undefined) {
      const slice = out.slice(op.p, op.p + op.d.length)
      if (slice !== op.d) {
        // Shouldn't happen — computeOps always emits exact-byte deletes —
        // but if it does we leave the doc unchanged rather than corrupt it.
        // The server-side ack would also reject in this case.
        return text
      }
      out = out.slice(0, op.p) + out.slice(op.p + op.d.length)
    }
  }
  return out
}

type EntityKind = 'doc' | 'file' | 'folder'
interface FoundEntity {
  entity: DocEntity | FileRefEntity | FolderEntity
  parent: FolderEntity
  kind: EntityKind
}

function findEntity(folder: FolderEntity, id: string): FoundEntity | null {
  for (const d of folder.docs) if (d._id === id) return { entity: d, parent: folder, kind: 'doc' }
  for (const f of folder.fileRefs) if (f._id === id) return { entity: f, parent: folder, kind: 'file' }
  for (const sub of folder.folders) {
    if (sub._id === id) return { entity: sub, parent: folder, kind: 'folder' }
    const inner = findEntity(sub, id)
    if (inner) return inner
  }
  return null
}

function findFolder(folder: FolderEntity, id: string): FolderEntity | null {
  if (folder._id === id) return folder
  for (const sub of folder.folders) {
    const inner = findFolder(sub, id)
    if (inner) return inner
  }
  return null
}
