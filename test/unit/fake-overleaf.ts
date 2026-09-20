import { OtEngine, OtEngineRegistry } from '../../src/overleaf/ot.js'
import type { OtOp } from '../../src/overleaf/diff.js'
import { applyOps, transformOps } from '../../src/overleaf/text-ot.js'
import type { ServerContext } from '../../src/mcp/server.js'
import type { JoinProjectResponse } from '../../src/overleaf/ot.types.js'
import { FakeSocket } from './fake-socket.js'
import { TextOp } from './text-operation-oracle.js'

interface ServerDoc {
  text: string
  version: number
  /** Ops by the version they were applied at, for transforming stale submissions. */
  history: Map<number, OtOp[]>
  /** history-ot mode: the same, as text operations. */
  textOps: Map<number, TextOp>
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
  private held: Array<{ docId: string; update: { op: OtOp[]; v: number } }> = []

  constructor(
    docs: Record<string, string>,
    private readonly opts: {
      startVersion?: number
      /** Comment ranges returned by joinDoc, per doc id. */
      ranges?: Record<string, { comments: Array<{ id: string; op: { c: string; p: number; t: string } }> }>
      /**
       * Behave like a project with otMigrationStage > 0: joinDoc needs supportsHistoryOT and
       * returns a raw StringFileData; updates carry one text operation and are transformed with
       * the editor-core algorithm (text-operation-oracle.ts), not with the ShareJS one.
       */
      historyOt?: boolean
      /** history-ot: comments in the snapshot, per doc id. */
      historyOtComments?: Record<string, Array<{ id: string; ranges: Array<{ pos: number; length: number }> }>>
    } = {},
  ) {
    for (const [docId, text] of Object.entries(docs)) {
      this.docs.set(docId, { text, version: opts.startVersion ?? 1, history: new Map(), textOps: new Map() })
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
      // Overleaf ships lines as latin1-packed UTF-8.
      const lines = doc.text.split('\n').map((l) => Buffer.from(l, 'utf-8').toString('latin1'))
      return [null, lines, doc.version, [], this.opts.ranges?.[docId as string] ?? {}]
    })
    this.sock.respondToEmit('applyOtUpdate', (docId, update) => {
      const u = update as { op: OtOp[]; v: number }
      if (this.holdAgentOps) this.held.push({ docId: docId as string, update: u })
      else queueMicrotask(() => this.applyAgentOp(docId as string, u))
      return [null]
    })
  }

  joinResponse(): JoinProjectResponse {
    return {
      project: {
        _id: 'p1',
        name: 'Test',
        rootDoc_id: 'd1',
        rootFolder: [{
          _id: 'root',
          name: 'rootFolder',
          docs: [...this.docs.keys()].map((id) => ({ _id: id, name: `${id}.tex` })),
          fileRefs: [],
          folders: [],
        }],
        owner: { _id: 'u-human', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
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

  private applyAgentOp(docId: string, update: { op: OtOp[]; v: number }): void {
    const doc = this.docs.get(docId)!
    if (this.opts.historyOt) return this.applyAgentTextOperation(docId, update as unknown as { op: unknown[]; v: number })
    // UpdateManager._sanitizeUpdate: surrogates in inserts become U+FFFD; the sender is not told.
    let op = update.op.map((c) => (c.i === undefined ? c : { ...c, i: c.i.replace(/[\uD800-\uDFFF]/g, '\uFFFD') }))
    try {
      for (let v = update.v; v < doc.version; v++) op = transformOps(op, doc.history.get(v)!, 'left')
      doc.text = applyOps(doc.text, op)
    } catch (err) {
      // real-time tells *every* client in the doc room and disconnects them.
      this.sock.simulate('otUpdateError', String((err as Error).message), { doc_id: docId })
      return
    }
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
      for (let v = update.v; v < doc.version; v++) op = TextOp.transform(op, doc.textOps.get(v)!)[0]
      doc.text = op.apply(doc.text)
      doc.textOps.set(doc.version, op)
    } catch (err) {
      this.sock.simulate('otUpdateError', String((err as Error).message), { doc_id: docId })
      return
    }
    const v = doc.version++
    this.sock.simulate('otUpdateApplied', { doc: docId, v })
  }

  /** history-ot: a collaborator replaces `del` characters at `pos` with `ins`. */
  remoteSplice(docId: string, pos: number, del: number, ins: string, opts: { broadcast?: boolean } = {}): void {
    const doc = this.docs.get(docId)!
    const op = TextOp.splice(doc.text.length, pos, del, ins)
    doc.text = op.apply(doc.text)
    doc.textOps.set(doc.version, op)
    const v = doc.version++
    if (opts.broadcast === false) return
    this.sock.simulate('otUpdateApplied', {
      doc: docId, op: [op.toJSON()], v,
      meta: { source: 'pub-HUMAN', user_id: 'u-human', ts: Date.now() },
    })
  }

  /** A collaborator edits in the browser; the agent's socket gets the broadcast. */
  remoteEdit(docId: string, op: OtOp[], opts: { broadcast?: boolean } = {}): void {
    const doc = this.docs.get(docId)!
    doc.text = applyOps(doc.text, op)
    doc.history.set(doc.version, op)
    const v = doc.version++
    if (opts.broadcast === false) return
    this.sock.simulate('otUpdateApplied', {
      doc: docId, op, v,
      meta: { source: 'pub-HUMAN', user_id: 'u-human', ts: Date.now() },
    })
  }

  text(docId: string): string {
    return this.docs.get(docId)!.text
  }
}

export async function connectEngine(server: FakeOverleaf): Promise<OtEngine> {
  const engine = new OtEngine({ socket: server.sock, projectId: 'p1', writeConfirmTimeoutMs: 200 })
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
) {
  const server = new FakeOverleaf(docs, opts)
  const engine = await connectEngine(server)
  const ot = {
    get: async () => engine,
    peek: () => engine,
  } as unknown as OtEngineRegistry
  const ctx: ServerContext = { rest: null as never, http: null as never, ot }
  return { server, engine, ctx }
}
