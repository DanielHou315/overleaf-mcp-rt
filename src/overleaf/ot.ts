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
import { NetworkError, OverleafError } from '../errors.js'
import { computeOps, sanitizeOps, type OtOp } from './diff.js'
import { applyOps as applyTextOps, transformOps } from './text-ot.js'
import type { UpdateSchema } from './ot.types.js'

/** Mirrors v0.1's TreeNode shape so MCP tool outputs stay stable. */
export interface TreeNode {
  files: string[]
  folders: Record<string, TreeNode>
}

export interface DocBaseline {
  docId: string
  text: string
  version: number
  /** Comment anchors, kept in step with the text as ops arrive. */
  comments: CommentAnchor[]
}

/** Where a comment thread is attached in a doc. */
export interface CommentAnchor {
  threadId: string
  /** Offset of the commented text. */
  p: number
  /** The commented text. */
  text: string
}

/** Outcome of `updateDoc`: the server-confirmed text either side of our op. */
export interface UpdateResult {
  /** Live text our edit was authored against. */
  textBefore: string
  /** Server-confirmed text after our op (includes any ops that raced it). */
  textAfter: string
  versionBefore: number
  versionAfter: number
  ops: OtOp[]
  /** UTF-16 code units Overleaf cannot store (non-BMP characters) that were sent as U+FFFD instead. */
  unstorableCodeUnits: number
}

/** A change made by someone else to a doc the agent has already looked at. */
export interface ExternalDocChange {
  docId: string
  path: string | null
  /** Text as the agent last saw it. */
  before: string
  /** Text now (for the doc an edit targeted: just before our own op landed). */
  after: string
  fromVersion: number
  toVersion: number
  /** Display names (or user ids) of whoever edited, when we observed the ops live. */
  authors: string[]
  lastEditedAt: number | null
}

export interface ExternalChanges {
  docs: ExternalDocChange[]
  /** Human-readable file-tree events caused by other collaborators. */
  tree: string[]
}

interface Inflight {
  ops: OtOp[]
  resolve: () => void
  reject: (err: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

interface SeenState {
  text: string
  version: number
  authors: Set<string>
  lastEditedAt: number | null
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
  /** How long to wait for the server to confirm a submitted op (default 15s). */
  writeConfirmTimeoutMs?: number
  /** How long to wait for a joinDoc response (default 15s). */
  joinTimeoutMs?: number
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
  /**
   * Live, server-confirmed snapshot per joined doc. Kept current by applying
   * every `otUpdateApplied` broadcast, so `version` is always the version the
   * server will accept our next op at.
   */
  private baselines = new Map<string, DocBaseline>()
  private inflightJoinDoc = new Map<string, Promise<DocBaseline>>()
  /** Updates that arrive while a joinDoc is outstanding; replayed onto the snapshot. */
  private joinBuffers = new Map<string, UpdateSchema[]>()
  /** real-time rejects a joinDoc that another join/leave RPC overtakes, so joins run one at a time. */
  private joinQueue: Promise<unknown> = Promise.resolve()
  /** Per-docId promise chain for write serialization. */
  private writeQueues = new Map<string, Promise<unknown>>()
  /** Our op awaiting server confirmation, per doc. At most one (writes are serialized). */
  private inflightWrites = new Map<string, Inflight>()
  /**
   * What the agent has been shown, per doc. Survives reconnects — external
   * changes are reported as a text diff against this, so missed ops don't matter.
   */
  private seen = new Map<string, SeenState>()
  /** External changes captured at write time, waiting for the next collectExternalChanges(). */
  private pendingDocReports: ExternalDocChange[] = []
  private treeEvents: string[] = []
  /** Tree broadcasts we expect because we just made the REST call ourselves. */
  private ownTreeExpectations: Array<{ key: string; expires: number }> = []
  private userNames = new Map<string, string>()
  private readonly writeConfirmTimeoutMs: number
  private readonly joinTimeoutMs: number

  constructor(opts: OtEngineOptions) {
    this.currentSocket = opts.socket
    this.projectId = opts.projectId
    this.socketFactory = opts.socketFactory ?? null
    this.reconnectInitialDelayMs = opts.reconnectInitialDelayMs ?? 500
    this.reconnectMaxAttempts = opts.reconnectMaxAttempts ?? 10
    this.onReconnectFailed = opts.onReconnectFailed ?? null
    this.schedule = opts.schedule ?? setTimeout
    this.writeConfirmTimeoutMs = opts.writeConfirmTimeoutMs ?? 15_000
    this.joinTimeoutMs = opts.joinTimeoutMs ?? 15_000
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
      let finished = false
      const finishIfReady = () => {
        // connectionAccepted can land after a joinProjectResponse that already
        // carried publicId; installing the handlers twice would double-apply
        // every tree event and OT update.
        if (finished || !gotPublicId || !gotProject) return
        finished = true
        this.installTreeEventHandlers()
        this.installListener('otUpdateApplied', (update: unknown) =>
          this.handleOtUpdateApplied(update as UpdateSchema),
        )
        this.installListener('otUpdateError', (error: unknown, message: unknown) =>
          this.handleOtUpdateError(error, message as { doc_id?: string } | undefined),
        )
        this._isConnected = true
        resolve()
      }

      const onConnAccepted = (_: unknown, publicId: string): void => {
        this._publicId = publicId
        gotPublicId = true
        finishIfReady()
      }
      const onJoinResponse = (res: JoinProjectResponse): void => {
        this.project = res.project
        this.indexUserNames(res.project)
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
   * Join a doc and start tracking it live. Idempotent within a session — a
   * second call returns the tracked snapshot without re-emitting joinDoc.
   * Concurrent calls for the same docId are coalesced; joins for different
   * docs are serialized (see joinQueue).
   *
   * The returned object is the live snapshot: read `text`/`version` right
   * away rather than holding on to it across an await.
   */
  async joinDoc(docId: string): Promise<DocBaseline> {
    if (!this._isConnected) {
      throw new OverleafError('OVERLEAF_GENERIC', 'OtEngine not connected')
    }
    const cached = this.baselines.get(docId)
    if (cached) return cached
    const inflight = this.inflightJoinDoc.get(docId)
    if (inflight) return inflight

    const socket = this.currentSocket
    const buffer: UpdateSchema[] = []
    const promise: Promise<DocBaseline> = this.joinQueue
      .catch(() => undefined)
      .then(() => {
        if (socket !== this.currentSocket) {
          throw new NetworkError('Connection was reset while joining the doc')
        }
        // real-time subscribes us to the doc room *before* it fetches the
        // snapshot, so updates can overtake the joinDoc response. Buffer them
        // and replay whatever the snapshot doesn't already include.
        this.joinBuffers.set(docId, buffer)
        // A dead socket never acks; without a deadline one lost join would
        // wedge every later join behind it in the queue.
        return withTimeout(
          socket.emitWithAck('joinDoc', docId, { encodeRanges: true }),
          this.joinTimeoutMs,
          () => new NetworkError(`Timed out after ${this.joinTimeoutMs}ms joining doc ${docId}`),
        )
      })
      .then((data) => {
        if (socket !== this.currentSocket) {
          throw new NetworkError('Connection was reset while joining the doc')
        }
        const [lines, version, , ranges] = data as [string[], number, unknown, JoinDocRanges | undefined]
        const baseline: DocBaseline = {
          docId,
          text: decodeLatin1Lines(lines),
          version,
          comments: (ranges?.comments ?? []).map((c) => ({
            threadId: c.op.t ?? c.id,
            p: c.op.p,
            // encodeRanges packs comment text the same way as doc lines.
            text: Buffer.from(c.op.c ?? '', 'latin1').toString('utf-8'),
          })),
        }
        this.baselines.set(docId, baseline)
        this.joinBuffers.delete(docId)
        for (const update of buffer) this.handleOtUpdateApplied(update)
        return this.baselines.get(docId) ?? baseline
      })
      .finally(() => {
        // Only clean up our own entries: after a reconnect a newer join for
        // the same doc may have replaced them.
        if (this.joinBuffers.get(docId) === buffer) this.joinBuffers.delete(docId)
        if (this.inflightJoinDoc.get(docId) === promise) this.inflightJoinDoc.delete(docId)
      })
    this.joinQueue = promise
    this.inflightJoinDoc.set(docId, promise)
    return promise
  }

  /**
   * Join (if needed) and return the live snapshot, recording that the agent
   * has now looked at this doc so later external edits get reported.
   */
  async openDoc(docId: string): Promise<DocBaseline> {
    const baseline = await this.joinDoc(docId)
    if (!this.seen.has(docId)) this.markSeen(docId, baseline.text, baseline.version)
    return baseline
  }

  /** Return the tracked text for a doc, or null if not joined yet. */
  readDoc(docId: string): string | null {
    return this.baselines.get(docId)?.text ?? null
  }

  /** Read the tracked snapshot ({text, version}) for a doc, if joined. */
  getBaseline(docId: string): DocBaseline | undefined {
    return this.baselines.get(docId)
  }

  /** True when collaborators changed the doc since the agent last saw it. */
  hasUnseenExternalChanges(docId: string): boolean {
    const seen = this.seen.get(docId)
    const live = this.baselines.get(docId)
    return !!seen && !!live && seen.text !== live.text
  }

  /** Whether the agent has been shown this doc in this session. */
  hasSeen(docId: string): boolean {
    return this.seen.has(docId)
  }

  protected clearBaseline(docId: string): void {
    this.baselines.delete(docId)
  }

  /** Replace the doc's text with newContent via OT (lazy-joins the doc). */
  async writeDoc(docId: string, newContent: string): Promise<void> {
    await this.updateDoc(docId, () => newContent)
  }

  /**
   * Lower-level: apply caller-positioned OT ops. Positions are validated
   * against the live text; a stale offset throws OtDeleteMismatchError
   * before anything is sent. The MCP `raw_ops` edit mode routes here.
   */
  async applyOps(docId: string, ops: OtOp[]): Promise<void> {
    await this.updateDoc(docId, (text) => applyTextOps(text, ops))
  }

  /**
   * Edit a doc. `edit` receives the *live* text and returns the desired text;
   * it runs synchronously right before the op is emitted, so there is no
   * window in which a collaborator's keystroke can invalidate the offsets.
   * If `edit` throws, nothing is sent. Resolves once the server confirms.
   *
   * Writes to the same doc are serialized; different docs run in parallel.
   */
  async updateDoc(docId: string, edit: (text: string) => string): Promise<UpdateResult> {
    const previous = this.writeQueues.get(docId) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined) // a prior failure must not block the next caller
      .then(() => this.submitEdit(docId, edit))
    this.writeQueues.set(docId, next)
    try {
      return await next
    } finally {
      // If we're the tail of the queue, clear the entry so the map doesn't grow.
      if (this.writeQueues.get(docId) === next) this.writeQueues.delete(docId)
    }
  }

  private submitEdit(docId: string, edit: (text: string) => string): Promise<UpdateResult> {
    return this.submitOps(docId, (text) => computeOps(text, edit(text)))
  }

  /**
   * Attach comment thread `threadId` to a span of the doc. `locate` receives
   * the live text and returns the span; like edits it runs in the same tick
   * the op is emitted. The thread's first message must already exist.
   */
  async addCommentAnchor(
    docId: string,
    threadId: string,
    locate: (text: string) => { start: number; end: number },
  ): Promise<{ p: number; text: string; version: number }> {
    let anchor = { p: 0, text: '' }
    const previous = this.writeQueues.get(docId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() =>
      this.submitOps(docId, (text) => {
        const span = locate(text)
        anchor = { p: span.start, text: text.slice(span.start, span.end) }
        return [{ c: anchor.text, p: anchor.p, t: threadId }]
      }),
    )
    this.writeQueues.set(docId, next)
    try {
      const result = await next
      return { ...anchor, version: result.versionAfter }
    } finally {
      if (this.writeQueues.get(docId) === next) this.writeQueues.delete(docId)
    }
  }

  private async submitOps(docId: string, build: (text: string) => OtOp[]): Promise<UpdateResult> {
    const baseline = await this.joinDoc(docId)
    // No awaits from here to the emit: text, version and ops must be consistent.
    const textBefore = baseline.text
    const versionBefore = baseline.version
    // Send what the server will store, not what it will silently rewrite (see sanitizeOps).
    const { ops, replaced: unstorableCodeUnits } = sanitizeOps(build(textBefore))
    if (ops.length === 0) {
      this.reportExternal(docId, textBefore, versionBefore)
      this.markSeen(docId, textBefore, versionBefore)
      return { textBefore, textAfter: textBefore, versionBefore, versionAfter: versionBefore, ops, unstorableCodeUnits }
    }

    // The applyOtUpdate ack only means real-time queued the op in Redis. The
    // commit confirmation is a later `otUpdateApplied {doc, v}` without `op`
    // (DocumentUpdaterController._applyUpdateFromDocumentUpdater); a rejection
    // arrives as `otUpdateError`. Waiting for the ack alone would let us race
    // ahead with a version the server hasn't reached yet.
    const confirmed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failInflight(docId, new NetworkError(
          `Timed out after ${this.writeConfirmTimeoutMs}ms waiting for Overleaf to confirm the edit. ` +
            'It may or may not have been applied — re-read the doc before retrying.',
        ))
      }, this.writeConfirmTimeoutMs)
      this.inflightWrites.set(docId, { ops, resolve, reject, timer })
    })
    this.currentSocket
      .emitWithAck('applyOtUpdate', docId, { doc: docId, op: ops, v: versionBefore })
      .catch((err: unknown) => {
        this.failInflight(
          docId,
          err instanceof Error ? err : new OverleafError('OVERLEAF_GENERIC', String(err)),
        )
      })
    await confirmed

    // handleOwnAck normally leaves a fresh snapshot behind; if it had to drop
    // it (missed updates), rejoin for the authoritative text.
    const after = this.baselines.get(docId) ?? (await this.joinDoc(docId))
    this.markSeen(docId, after.text, after.version)
    return {
      textBefore,
      textAfter: after.text,
      versionBefore,
      versionAfter: after.version,
      ops,
      unstorableCodeUnits,
    }
  }

  /**
   * Discard a snapshot we can no longer trust. If the agent has seen the doc,
   * rejoin in the background so external changes to it keep being reported
   * rather than going silent until the agent happens to touch it again.
   */
  private dropBaseline(docId: string): void {
    this.baselines.delete(docId)
    if (!this._isConnected || !this.seen.has(docId) || this.inflightWrites.has(docId)) return
    void this.joinDoc(docId).catch(() => undefined)
  }

  private failInflight(docId: string, err: unknown): void {
    const inflight = this.inflightWrites.get(docId)
    if (!inflight) return
    clearTimeout(inflight.timer)
    this.inflightWrites.delete(docId)
    // Whether the op landed is unknown; force the next access to rejoin.
    this.baselines.delete(docId)
    inflight.reject(err)
  }

  /**
   * Every op applied to a joined doc arrives here: collaborators' ops carry
   * `op`; the confirmation of our own op is `{doc, v}` with no `op`.
   */
  private handleOtUpdateApplied(update: UpdateSchema): void {
    if (!update || typeof update.doc !== 'string') return
    const buffer = this.joinBuffers.get(update.doc)
    if (buffer) {
      buffer.push(update)
      return
    }
    const isOwnAck =
      !update.op || (update.meta?.source != null && update.meta.source === this._publicId)
    if (isOwnAck) this.handleOwnAck(update)
    else this.handleRemoteUpdate(update)
  }

  private handleOwnAck(update: UpdateSchema): void {
    const docId = update.doc
    const inflight = this.inflightWrites.get(docId)
    if (!inflight) return
    clearTimeout(inflight.timer)
    this.inflightWrites.delete(docId)
    const baseline = this.baselines.get(docId)
    if (baseline && update.v === baseline.version) {
      try {
        // Everything collaborators did up to this point is external to the
        // agent's edit; capture it before our own op is folded in.
        this.reportExternal(docId, baseline.text, baseline.version)
        // inflight.ops has been transformed past every op that beat ours to
        // the server, exactly as the server transformed it.
        applyToBaseline(baseline, inflight.ops)
        baseline.version = update.v + 1
      } catch {
        this.baselines.delete(docId)
      }
    } else {
      // We missed updates between our snapshot and the ack; the op is applied
      // but we can't reconstruct the text. Rejoin on next access.
      this.baselines.delete(docId)
    }
    inflight.resolve()
  }

  private handleRemoteUpdate(update: UpdateSchema): void {
    const docId = update.doc
    const baseline = this.baselines.get(docId)
    if (!baseline || !update.op) return
    if (update.v < baseline.version) return // already part of our snapshot
    if (update.v > baseline.version) {
      // Gap: we missed an update, so the text can't be reconstructed.
      this.dropBaseline(docId)
      return
    }
    try {
      applyToBaseline(baseline, update.op)
      baseline.version = update.v + 1
      const inflight = this.inflightWrites.get(docId)
      if (inflight) inflight.ops = transformOps(inflight.ops, update.op, 'left')
    } catch {
      this.dropBaseline(docId)
      return
    }
    const seen = this.seen.get(docId)
    if (seen) {
      const userId = update.meta?.user_id
      if (userId) seen.authors.add(this.userNames.get(userId) ?? userId)
      seen.lastEditedAt = update.meta?.ts ?? Date.now()
    }
  }

  /** Server rejected an op. real-time also disconnects every client in the doc room. */
  private handleOtUpdateError(error: unknown, message?: { doc_id?: string }): void {
    const detail =
      typeof error === 'string' ? error : (error as { message?: string })?.message ?? String(error)
    const err = new OverleafError('OVERLEAF_GENERIC', `Overleaf rejected the edit: ${detail}`, {
      docId: message?.doc_id,
    })
    const docIds = message?.doc_id ? [message.doc_id] : [...this.inflightWrites.keys()]
    for (const docId of docIds) this.failInflight(docId, err)
    if (message?.doc_id) this.baselines.delete(message.doc_id)
  }

  // ---- external-change awareness ----

  private markSeen(docId: string, text: string, version: number): void {
    this.seen.set(docId, { text, version, authors: new Set(), lastEditedAt: null })
  }

  /** Queue a report if `text` differs from what the agent last saw. */
  private reportExternal(docId: string, text: string, version: number): void {
    const seen = this.seen.get(docId)
    if (!seen || seen.text === text) return
    this.pendingDocReports.push({
      docId,
      path: this.idToPath(docId),
      before: seen.text,
      after: text,
      fromVersion: seen.version,
      toVersion: version,
      authors: [...seen.authors],
      lastEditedAt: seen.lastEditedAt,
    })
  }

  /**
   * Everything collaborators changed since the agent last looked: text diffs
   * for docs it has opened, plus file-tree events. Calling this marks those
   * changes as delivered, so each is reported exactly once.
   */
  collectExternalChanges(): ExternalChanges {
    for (const [docId, baseline] of this.baselines) {
      // A doc with our own op in flight is reported when that op is confirmed.
      if (this.inflightWrites.has(docId) || !this.seen.has(docId)) continue
      this.reportExternal(docId, baseline.text, baseline.version)
      this.markSeen(docId, baseline.text, baseline.version)
    }
    const docs = this.pendingDocReports
    const tree = this.treeEvents
    this.pendingDocReports = []
    this.treeEvents = []
    return { docs, tree }
  }

  /**
   * Announce a tree mutation we're about to make over REST so its broadcast
   * isn't reported back to the agent as someone else's change. `key` is the
   * entity id (rename/move/delete) or `parentFolderId/name` (create).
   */
  expectOwnTreeEvent(key: string): void {
    this.ownTreeExpectations.push({ key, expires: Date.now() + 15_000 })
  }

  private consumeOwnTreeEvent(...keys: string[]): boolean {
    const now = Date.now()
    this.ownTreeExpectations = this.ownTreeExpectations.filter((e) => e.expires > now)
    const idx = this.ownTreeExpectations.findIndex((e) => keys.includes(e.key))
    if (idx < 0) return false
    this.ownTreeExpectations.splice(idx, 1)
    return true
  }

  private idToPath(entityId: string): string | null {
    for (const [path, entry] of this.pathIndex) if (entry.id === entityId) return path
    return null
  }

  private indexUserNames(project: ProjectEntity): void {
    for (const user of [project.owner, ...(project.members ?? [])]) {
      if (!user?._id) continue
      const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim()
      this.userNames.set(user._id, name || user.email || user._id)
    }
  }

  private installTreeEventHandlers(): void {
    // web appends the acting user's id to the create broadcasts:
    // reciveNewDoc(folderId, doc, source, userId),
    // reciveNewFile(folderId, file, source, linkedFileData, userId),
    // reciveNewFolder(folderId, folder, userId). Rename/move/remove carry none.
    this.installListener('reciveNewDoc', (parentFolderId: unknown, doc: unknown, _source: unknown, userId: unknown) =>
      this.applyNewEntity(parentFolderId as string, doc as DocEntity, 'doc', userId),
    )
    this.installListener('reciveNewFile', (parentFolderId: unknown, file: unknown, _source: unknown, _linked: unknown, userId: unknown) =>
      this.applyNewEntity(parentFolderId as string, file as FileRefEntity, 'file', userId),
    )
    this.installListener('reciveNewFolder', (parentFolderId: unknown, folder: unknown, userId: unknown) =>
      this.applyNewEntity(parentFolderId as string, folder as FolderEntity, 'folder', userId),
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
    userId?: unknown,
  ): void {
    const project = this.getProject()
    if (!project) return
    const parent = findFolder(project.rootFolder[0]!, parentFolderId)
    if (!parent) return
    if (kind === 'doc') parent.docs.push(entity as DocEntity)
    else if (kind === 'file') parent.fileRefs.push(entity as FileRefEntity)
    else parent.folders.push(entity as FolderEntity)
    this.rebuildPathIndex()
    if (!this.consumeOwnTreeEvent(`${parentFolderId}/${entity.name}`)) {
      const who = typeof userId === 'string' ? ` by ${this.userNames.get(userId) ?? userId}` : ''
      this.treeEvents.push(`created ${kind} ${this.idToPath(entity._id) ?? entity.name}${who}`)
    }
  }

  private applyRename(entityId: string, newName: string): void {
    const project = this.getProject()
    if (!project) return
    const found = findEntity(project.rootFolder[0]!, entityId)
    if (!found) return
    const oldPath = this.idToPath(entityId)
    found.entity.name = newName
    this.rebuildPathIndex()
    if (!this.consumeOwnTreeEvent(entityId)) {
      this.treeEvents.push(`renamed ${found.kind} ${oldPath ?? entityId} → ${this.idToPath(entityId) ?? newName}`)
    }
  }

  private applyMove(entityId: string, newParentId: string): void {
    const project = this.getProject()
    if (!project) return
    const target = findEntity(project.rootFolder[0]!, entityId)
    const newParent = findFolder(project.rootFolder[0]!, newParentId)
    if (!target || !newParent) return
    const oldPath = this.idToPath(entityId)
    // Remove from old parent
    const arr = this.containerArray(target.parent, target.kind)
    const idx = arr.findIndex((e) => e._id === entityId)
    if (idx >= 0) arr.splice(idx, 1)
    // Add to new parent
    const newArr = this.containerArray(newParent, target.kind)
    newArr.push(target.entity as never)
    this.rebuildPathIndex()
    if (!this.consumeOwnTreeEvent(entityId)) {
      this.treeEvents.push(`moved ${target.kind} ${oldPath ?? entityId} → ${this.idToPath(entityId) ?? entityId}`)
    }
  }

  private applyRemove(entityId: string): void {
    const project = this.getProject()
    if (!project) return
    const found = findEntity(project.rootFolder[0]!, entityId)
    if (!found) return
    const oldPath = this.idToPath(entityId)
    const arr = this.containerArray(found.parent, found.kind)
    const idx = arr.findIndex((e) => e._id === entityId)
    if (idx >= 0) arr.splice(idx, 1)
    this.rebuildPathIndex()
    // Drop any tracked state for this doc
    this.clearBaseline(entityId)
    this.seen.delete(entityId)
    if (!this.consumeOwnTreeEvent(entityId)) {
      this.treeEvents.push(`deleted ${found.kind} ${oldPath ?? entityId}`)
    }
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

    // Drop live state; `seen` is kept so edits made while we were away are
    // still reported (as a diff) once the docs are rejoined.
    this._isConnected = false
    this.failAllInflight()
    this.baselines.clear()
    this.inflightJoinDoc.clear()
    this.joinBuffers.clear()
    this.joinQueue = Promise.resolve() // don't queue behind joins on the dead socket
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
        () => {
          this.reconnectAttempt = 0
          // Resume live tracking of every doc the agent has looked at.
          for (const docId of this.seen.keys()) {
            if (this.idToPath(docId) === null) this.seen.delete(docId)
            else void this.joinDoc(docId).catch(() => undefined)
          }
        },
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
    this.failAllInflight()
    this.currentSocket.disconnect()
  }

  private failAllInflight(): void {
    for (const docId of [...this.inflightWrites.keys()]) {
      this.failInflight(docId, new NetworkError(
        'Connection to Overleaf was lost before the edit was confirmed. ' +
          'It may or may not have been applied — re-read the doc before retrying.',
      ))
    }
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

  /** The engine for a project if one is already connected; never opens a connection. */
  peek(projectId: string): OtEngine | undefined {
    return this.engines.get(projectId)
  }

  /** Disconnect and drop every engine. */
  async closeAll(): Promise<void> {
    for (const engine of this.engines.values()) engine.disconnect()
    this.engines.clear()
  }
}

interface JoinDocRanges {
  comments?: Array<{ id: string; op: { c?: string; p: number; t?: string } }>
}

/** Apply ops to the snapshot text and keep comment anchors attached to their text. */
function applyToBaseline(baseline: DocBaseline, ops: OtOp[]): void {
  baseline.text = applyTextOps(baseline.text, ops)
  for (const op of ops) {
    if (op.c !== undefined) {
      if (op.t && !baseline.comments.some((c) => c.threadId === op.t)) {
        baseline.comments.push({ threadId: op.t, p: op.p, text: op.c })
      }
      continue
    }
    for (const anchor of baseline.comments) {
      const end = anchor.p + anchor.text.length
      if (op.i !== undefined) {
        if (op.p <= anchor.p) anchor.p += op.i.length
        else if (op.p < end) {
          anchor.text = anchor.text.slice(0, op.p - anchor.p) + op.i + anchor.text.slice(op.p - anchor.p)
        }
      } else if (op.d !== undefined) {
        const dEnd = op.p + op.d.length
        if (dEnd <= anchor.p) anchor.p -= op.d.length
        else if (op.p < end) {
          const keepHead = anchor.text.slice(0, Math.max(0, op.p - anchor.p))
          const keepTail = anchor.text.slice(Math.max(0, dEnd - anchor.p))
          anchor.text = keepHead + keepTail
          anchor.p = Math.min(anchor.p, op.p)
        }
      }
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err: unknown) => { clearTimeout(timer); reject(err) },
    )
  })
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

/** Apply ops to text locally, mirroring what the server will do. */
export { applyOps as applyOpsLocal } from './text-ot.js'

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
