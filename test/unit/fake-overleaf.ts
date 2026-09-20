import { OtEngine, OtEngineRegistry } from '../../src/overleaf/ot.js'
import type { OtOp } from '../../src/overleaf/diff.js'
import { applyOps, transformOps } from '../../src/overleaf/text-ot.js'
import type { ServerContext } from '../../src/mcp/server.js'
import type { JoinProjectResponse } from '../../src/overleaf/ot.types.js'
import { FakeSocket } from './fake-socket.js'

interface ServerDoc {
  text: string
  version: number
  /** Ops by the version they were applied at, for transforming stale submissions. */
  history: Map<number, OtOp[]>
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
    } = {},
  ) {
    for (const [docId, text] of Object.entries(docs)) {
      this.docs.set(docId, { text, version: opts.startVersion ?? 1, history: new Map() })
    }
    this.sock.autoConfirmWrites = false
    this.sock.respondToEmit('joinDoc', (docId) => {
      const doc = this.docs.get(docId as string)
      if (!doc) return [{ message: 'not found' }]
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
    let op = update.op
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
