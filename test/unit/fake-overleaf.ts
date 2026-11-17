import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { OtEngine, OtEngineRegistry } from '../../src/overleaf/ot.js'
import type { OtOp } from '../../src/overleaf/diff.js'
import { applyOps, transformOps } from '../../src/overleaf/text-ot.js'
import type { ServerContext } from '../../src/mcp/server.js'
import { registerAllTools } from '../../src/mcp/tools/index.js'
import type { JoinDocRanges, JoinProjectResponse, TrackedChange } from '../../src/overleaf/ot.types.js'
import { FakeSocket } from './fake-socket.js'
import { TextOp } from './text-operation-oracle.js'

interface ServerDoc {
  text: string
  version: number
  /** Ops by the version they were applied at, for transforming stale submissions. */
  history: Map<number, OtOp[]>
  /** history-ot mode: the same, as text operations. */
  textOps: Map<number, TextOp>
  /** history-ot mode: the text at each version, so a collaborator can submit against an old one. */
  textAt: Map<number, string>
  /** Tracked changes, as joinDoc returns them (see recordTrackedChanges for how faithfully). */
  changes: TrackedChange[]
}

/** An applyOtUpdate payload as the agent sent it. */
export interface SentUpdate {
  doc: string
  op: OtOp[]
  v: number
  meta?: Record<string, unknown>
}

/** The `features` option for overleaf.com and Server Pro: the owner has track changes, and there is a review panel. */
export const REVIEW_PANEL = { trackChanges: true, trackChangesVisible: true }
/** The `features` option for a stock Community Edition: the flag is on for new users, but nothing shows the changes. */
export const STOCK_CE = { trackChanges: true, trackChangesVisible: false }
/** A tracked update's id seed, as real-time checks it (Router.js: `zz.hex().length(18)`). */
export const TC_SEED = /^[0-9a-f]{18}$/

/** `n` tracked insertions a doc already has, as joinDoc reports them (for the `ranges` option). */
export function existingChanges(n: number): TrackedChange[] {
  return Array.from({ length: n }, (_, k) => ({
    id: k.toString(16).padStart(24, '0'), op: { i: 'x', p: 0 }, metadata: { user_id: 'u-human' },
  }))
}

/** RangesManager.MAX_CHANGES */
const MAX_TRACKED_CHANGES = 2000

/** Router.js applyOtUpdateSchema: a strict object, and `meta` may hold only `tc`, 18 lowercase hex. */
function validateUpdate(update: Record<string, unknown>): string | null {
  const allowed = ['doc', 'dupIfSource', 'hash', 'lastV', 'meta', 'op', 'v']
  const unknownKey = Object.keys(update).find((k) => !allowed.includes(k))
  if (unknownKey) return `Unrecognized key: "${unknownKey}"`
  if (update.meta === undefined) return null
  const meta = update.meta as Record<string, unknown>
  const unknownMeta = Object.keys(meta).find((k) => k !== 'tc')
  if (unknownMeta) return `Unrecognized key in meta: "${unknownMeta}"`
  if (meta.tc !== undefined && !(typeof meta.tc === 'string' && TC_SEED.test(meta.tc))) return 'Invalid meta.tc'
  return null
}

/**
 * A miniature Overleaf: real-time + document-updater behaviour behind a
 * FakeSocket. Holds the authoritative text per doc, transforms ops submitted
 * at an old version exactly like ShareJS does, confirms to the sender with
 * `{doc, v}`, and lets tests play a second collaborator via `remoteEdit`.
 */
export class FakeOverleaf {
  readonly sock = new FakeSocket()
  readonly docs = new Map<string, ServerDoc>()
  /** When true, agent ops are queued instead of applied; release with flush(). */
  holdAgentOps = false
  private held: Array<{ docId: string; update: SentUpdate }> = []
  /** Updates real-time's validation refused (it then disconnects the sender, and only the sender). */
  readonly invalidUpdates: string[] = []
  private humanSeeds = 0

  constructor(
    docs: Record<string, string>,
    private readonly opts: {
      startVersion?: number
      /**
       * Ranges returned by joinDoc, per doc id: comments as given, and tracked
       * changes the doc starts with (afterwards kept up to date by the fake).
       */
      ranges?: Record<string, JoinDocRanges>
      /**
       * The project's `features` in the join response (ProjectEditorHandler), such as STOCK_CE or
       * REVIEW_PANEL. Default: none, like a server that doesn't report them.
       */
      features?: Record<string, unknown>
      /**
       * Behave like a project with otMigrationStage > 0: joinDoc needs supportsHistoryOT and
       * returns a raw StringFileData; updates carry one text operation and are transformed with
       * the editor-core algorithm (text-operation-oracle.ts), not with the ShareJS one.
       */
      historyOt?: boolean
      /**
       * history-ot: stamp broadcasts and acks with the version the op was applied at. The real
       * document-updater (6.0 – 6.3) does NOT: it leaves the version the sender submitted at, which
       * is what this fake does by default. `true` models a server that fixes that.
       */
      restampVersions?: boolean
      /** history-ot: acknowledge agent ops but store a (same-length) variation — a server that disagrees with our model. */
      storesDifferently?: boolean
      /** Project settings in the join response. `rootDocId: null` is a project with no main document. Default: `d1`, pdflatex. */
      settings?: { rootDocId?: string | null; compiler?: string; imageName?: string }
      /** history-ot: comments in the snapshot, per doc id. */
      historyOtComments?: Record<string, Array<{ id: string; ranges: Array<{ pos: number; length: number }> }>>
    } = {},
  ) {
    for (const [docId, text] of Object.entries(docs)) {
      this.docs.set(docId, {
        text, version: opts.startVersion ?? 1, history: new Map(), textOps: new Map(), textAt: new Map(),
        changes: [...(opts.ranges?.[docId]?.changes ?? [])],
      })
    }
    this.sock.autoConfirmWrites = false
    this.sock.respondToEmit('joinDoc', (docId, options) => {
      const doc = this.docs.get(docId as string)
      if (!doc) return [{ message: 'not found' }]
      if (this.opts.historyOt) {
        // WebsocketController.joinDoc
        if (!(options as { supportsHistoryOT?: boolean } | undefined)?.supportsHistoryOT) {
          return [{ message: 'client does not support history-ot' }]
        }
        const raw = { content: doc.text, comments: this.opts.historyOtComments?.[docId as string] }
        return [null, raw, doc.version, [], {}, 'history-ot']
      }
      // Overleaf ships lines as latin1-packed UTF-8; with encodeRanges, the text in ranges too.
      const latin1 = (s: string) => Buffer.from(s, 'utf-8').toString('latin1')
      const lines = doc.text.split('\n').map(latin1)
      const comments = this.opts.ranges?.[docId as string]?.comments
      const ranges = {
        ...(comments ? { comments } : {}),
        ...(doc.changes.length > 0
          ? {
              changes: doc.changes.map((c) => ({
                ...c,
                op: { ...c.op, ...(c.op.i !== undefined ? { i: latin1(c.op.i) } : { d: latin1(c.op.d!) }) },
              })),
            }
          : {}),
      }
      return [null, lines, doc.version, [], ranges]
    })
    this.sock.respondToEmit('applyOtUpdate', (docId, update) => {
      const u = update as SentUpdate
      const invalid = validateUpdate(u as unknown as Record<string, unknown>)
      if (invalid) {
        // Router._handleError: the error goes to the sender's callback, then the sender is disconnected.
        this.invalidUpdates.push(invalid)
        setTimeout(() => this.sock.disconnect(), 0)
        return [{ message: invalid }]
      }
      if (this.holdAgentOps) this.held.push({ docId: docId as string, update: u })
      else queueMicrotask(() => this.applyAgentOp(docId as string, u))
      return [null]
    })
  }

  /** Every applyOtUpdate the agent sent, in order. */
  sentUpdates(): SentUpdate[] {
    return this.sock.emitsOf('applyOtUpdate').map((e) => e.args[1] as SentUpdate)
  }

  /** The doc's tracked changes as the server stores them. */
  changes(docId: string): TrackedChange[] {
    return this.docs.get(docId)!.changes
  }

  /** Someone accepts every tracked change in the review panel: the ranges go, the text stays. */
  acceptAllChanges(docId: string): void {
    const doc = this.docs.get(docId)!
    const ids = doc.changes.map((c) => c.id)
    doc.changes = []
    this.sock.simulate('accept-changes', docId, ids)
  }

  /**
   * RangesManager.applyUpdate for a tracked update, simplified: one change per
   * insert or delete component, with RangesTracker's ids (the seed plus a
   * 6-hex counter that restarts with every seed). It never merges, splits or
   * moves changes, so where Overleaf would, the fake's ids, counts and
   * positions differ. Returns false and stores nothing when the doc would go
   * over the limit (applyAgentOp shows what the real server then does).
   */
  private recordTrackedChanges(doc: ServerDoc, op: OtOp[], tc: string, userId: string): boolean {
    const components = op.filter((c) => c.i !== undefined || c.d !== undefined)
    if (doc.changes.length + components.length > MAX_TRACKED_CHANGES) return false
    components.forEach((c, n) => {
      doc.changes.push({
        id: tc + (n + 1).toString(16).padStart(6, '0'),
        op: c.i !== undefined ? { i: c.i, p: c.p } : { d: c.d!, p: c.p },
        metadata: { user_id: userId },
      })
    })
    return true
  }

  joinResponse(): JoinProjectResponse {
    return {
      project: {
        _id: 'p1',
        name: 'Test',
        rootDoc_id: this.opts.settings && 'rootDocId' in this.opts.settings ? this.opts.settings.rootDocId : 'd1',
        compiler: this.opts.settings?.compiler ?? 'pdflatex',
        ...(this.opts.settings?.imageName ? { imageName: this.opts.settings.imageName } : {}),
        rootFolder: [{
          _id: 'root',
          name: 'rootFolder',
          docs: [...this.docs.keys()].map((id) => ({ _id: id, name: `${id}.tex` })),
          fileRefs: [],
          folders: [],
        }],
        owner: { _id: 'u-human', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
        ...(this.opts.features ? { features: this.opts.features } : {}),
      },
      permissionsLevel: 'owner',
      protocolVersion: 2,
      publicId: 'pub-AGENT',
    }
  }

  get heldCount(): number {
    return this.held.length
  }

  /** Release ops queued while holdAgentOps was set. */
  flush(): void {
    const held = this.held
    this.held = []
    this.holdAgentOps = false
    for (const h of held) this.applyAgentOp(h.docId, h.update)
  }

  private applyAgentOp(docId: string, update: SentUpdate): void {
    const doc = this.docs.get(docId)!
    // history-ot carries tracking inside the text operation; HistoryOTUpdateManager ignores meta.tc.
    if (this.opts.historyOt) return this.applyAgentTextOperation(docId, update as unknown as { op: unknown[]; v: number })
    // UpdateManager._sanitizeUpdate: surrogates in inserts become U+FFFD; the sender is not told.
    let op = update.op.map((c) => (c.i === undefined ? c : { ...c, i: c.i.replace(/[\uD800-\uDFFF]/g, '\uFFFD') }))
    let text: string
    try {
      for (let v = update.v; v < doc.version; v++) op = transformOps(op, doc.history.get(v)!, 'left')
      text = applyOps(doc.text, op)
    } catch (err) {
      // real-time tells *every* client in the doc room and disconnects them.
      this.sock.simulate('otUpdateError', String((err as Error).message), { doc_id: docId })
      return
    }
    const tc = update.meta?.tc as string | undefined
    if (tc && !this.recordTrackedChanges(doc, op, tc, 'u-agent')) {
      // RangesManager throws only after ShareJS applied and published the op, so the sender is
      // confirmed first. Then every client in the doc gets the error and is disconnected, and the
      // update is never stored: text and version stay as they were.
      this.sock.simulate('otUpdateApplied', { doc: docId, v: doc.version })
      this.sock.simulate('otUpdateError', 'too many comments or tracked changes', { doc_id: docId })
      return
    }
    doc.text = text
    doc.history.set(doc.version, op)
    const v = doc.version++
    this.sock.simulate('otUpdateApplied', { doc: docId, v })
  }

  /** HistoryOTUpdateManager.tryApplyUpdate. */
  private applyAgentTextOperation(docId: string, update: { op: unknown[]; v: number }): void {
    const doc = this.docs.get(docId)!
    try {
      const raw = update.op[0] as { textOperation?: unknown[] }
      if (update.op.length !== 1 || !Array.isArray(raw?.textOperation)) throw new Error('unsupported update for history-ot')
      let op = TextOp.fromJSON(raw as { textOperation: unknown[] })
      if (update.v > doc.version) throw new Error('Op at future version')
      for (let v = update.v; v < doc.version; v++) op = TextOp.transform(op, doc.textOps.get(v)!)[0]
      doc.textAt.set(doc.version, doc.text)
      doc.text = op.apply(doc.text)
      if (this.opts.storesDifferently) doc.text = doc.text.split('').reverse().join('')
      doc.textOps.set(doc.version, op)
    } catch (err) {
      this.sock.simulate('otUpdateError', String((err as Error).message), { doc_id: docId })
      return
    }
    const appliedAt = doc.version++
    // tryApplyUpdate never touches update.v: the sender hears back the version it submitted at.
    this.sock.simulate('otUpdateApplied', { doc: docId, v: this.opts.restampVersions ? appliedAt : update.v })
  }

  /**
   * history-ot: a collaborator replaces `del` characters at `pos` with `ins`.
   * `basedOn` is the version their editor was at when they typed (default: current);
   * an older one is transformed forward like the real server does — and, like the
   * real server, broadcast still stamped with `basedOn`.
   */
  remoteSplice(
    docId: string, pos: number, del: number, ins: string,
    opts: { broadcast?: boolean; basedOn?: number } = {},
  ): void {
    const doc = this.docs.get(docId)!
    const basedOn = opts.basedOn ?? doc.version
    const base = basedOn === doc.version ? doc.text : doc.textAt.get(basedOn)!
    let op = TextOp.splice(base.length, Math.min(pos, base.length), Math.min(del, base.length - Math.min(pos, base.length)), ins)
    for (let v = basedOn; v < doc.version; v++) op = TextOp.transform(op, doc.textOps.get(v)!)[0]
    doc.textAt.set(doc.version, doc.text)
    doc.text = op.apply(doc.text)
    doc.textOps.set(doc.version, op)
    const appliedAt = doc.version++
    if (opts.broadcast === false) return
    this.sock.simulate('otUpdateApplied', {
      doc: docId, op: [op.toJSON()], v: this.opts.restampVersions ? appliedAt : basedOn,
      meta: { source: 'pub-HUMAN', user_id: 'u-human', ts: Date.now() },
    })
  }

  /**
   * history-ot: a collaborator's client sends this exact text operation. The server parses it
   * (which reorders an insert before an adjacent remove) but, unless it had to transform it,
   * broadcasts the JSON it was given — so other clients see the sender's own component order.
   */
  remoteTextOperation(docId: string, raw: { textOperation: Array<number | string> }): void {
    const doc = this.docs.get(docId)!
    const op = TextOp.fromJSON(raw)
    doc.textAt.set(doc.version, doc.text)
    doc.text = op.apply(doc.text)
    doc.textOps.set(doc.version, op)
    const v = doc.version++
    this.sock.simulate('otUpdateApplied', {
      doc: docId, op: [raw], v,
      meta: { source: 'pub-HUMAN', user_id: 'u-human', ts: Date.now() },
    })
  }

  /** The version the server is at — what a collaborator's editor would base its next op on. */
  version(docId: string): number {
    return this.docs.get(docId)!.version
  }

  /**
   * A collaborator edits in the browser; the agent's socket gets the broadcast.
   * With `trackChanges` the edit is one of their suggestions: the broadcast
   * carries its id seed, as the editor's does.
   */
  remoteEdit(docId: string, op: OtOp[], opts: { broadcast?: boolean; trackChanges?: boolean } = {}): void {
    const doc = this.docs.get(docId)!
    const tc = opts.trackChanges ? `00000000beef${(this.humanSeeds++).toString(16).padStart(6, '0')}` : undefined
    if (tc && !this.recordTrackedChanges(doc, op, tc, 'u-human')) throw new Error('test setup: over the tracked-change limit')
    doc.text = applyOps(doc.text, op)
    doc.history.set(doc.version, op)
    const v = doc.version++
    if (opts.broadcast === false) return
    this.sock.simulate('otUpdateApplied', {
      doc: docId, op, v,
      meta: { source: 'pub-HUMAN', user_id: 'u-human', ts: Date.now(), ...(tc ? { tc } : {}) },
    })
  }

  text(docId: string): string {
    return this.docs.get(docId)!.text
  }
}

export async function connectEngine(
  server: FakeOverleaf,
  opts: { historyOtWrites?: boolean; trackChangesSkipCheck?: boolean } = {},
): Promise<OtEngine> {
  // Tests exercise history-ot writes unless they are about the opt-in itself.
  const engine = new OtEngine({
    socket: server.sock, projectId: 'p1', writeConfirmTimeoutMs: 200, historyOtWrites: opts.historyOtWrites ?? true,
    trackChangesSkipCheck: opts.trackChangesSkipCheck,
  })
  const connecting = engine.connect()
  server.sock.simulate('connectionAccepted', null, 'pub-AGENT')
  server.sock.simulate('joinProjectResponse', server.joinResponse())
  await connecting
  return engine
}

/** A ServerContext whose OT registry is wired to the fake server. Docs are addressed as `<docId>.tex`. */
export async function makeToolHarness(
  docs: Record<string, string>,
  opts: ConstructorParameters<typeof FakeOverleaf>[1] = {},
  engineOpts: Parameters<typeof connectEngine>[1] = {},
) {
  const server = new FakeOverleaf(docs, opts)
  const engine = await connectEngine(server, engineOpts)
  const ot = {
    get: async () => engine,
    peek: () => engine,
  } as unknown as OtEngineRegistry
  const ctx: ServerContext = { rest: null as never, http: null as never, ot }
  return { server, engine, ctx }
}

/**
 * Everything an agent would see: a real MCP client talking, in memory, to the
 * real tool dispatcher on `ctx`. `call` adds `projectId: 'p1'` and returns the
 * result's first text block parsed as JSON, and the blocks after it (the
 * <external-changes> report) as `external`.
 */
export async function connectAgent(ctx: ServerContext) {
  const server = new Server({ name: 'test', version: '0' }, { capabilities: { tools: {} } })
  registerAllTools(server, ctx)
  const client = new Client({ name: 'agent', version: '0' }, { capabilities: {} })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: { projectId: 'p1', ...args } })
    const blocks = (res.content as Array<{ type: string; text: string }>).map((c) => c.text)
    return {
      isError: res.isError === true,
      json: JSON.parse(blocks[0]!) as Record<string, any>,
      external: blocks.slice(1).join('\n'),
    }
  }
  return { client, call }
}
