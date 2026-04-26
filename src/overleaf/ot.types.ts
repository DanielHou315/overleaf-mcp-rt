// Wire-protocol types ported from Overleaf-Workshop
// (https://github.com/iamhyc/Overleaf-Workshop), specifically
// the schemas in src/api/socketio.ts. Used under AGPL-3.0-or-later.
import type { OtOp } from './diff.js'

/**
 * Server response to `joinProject` emit. The v2 server-driven handshake.
 * Workshop reference: src/api/socketio.ts: socket.on('joinProjectResponse', ...)
 */
export interface JoinProjectResponse {
  project: ProjectEntity
  permissionsLevel: 'owner' | 'readAndWrite' | 'readOnly' | string
  protocolVersion: number
  publicId: string
}

/** Server response to `connectionAccepted` event — the second source of publicId. */
export interface ConnectionAcceptedPayload {
  publicId: string
}

/** Top-level project tree entity. */
export interface ProjectEntity {
  _id: string
  name: string
  rootDoc_id: string
  rootFolder: FolderEntity[]
  features?: Record<string, unknown>
  // Other fields (compiler, owner, etc.) ignored for v0.2.
}

/** A folder in the project tree. */
export interface FolderEntity {
  _id: string
  name: string
  docs: DocEntity[]
  fileRefs: FileRefEntity[]
  folders: FolderEntity[]
}

/** A text doc in the tree (content not included; fetch via joinDoc). */
export interface DocEntity {
  _id: string
  name: string
}

/** A binary file in the tree. */
export interface FileRefEntity {
  _id: string
  name: string
  linkedFileData?: unknown
  created?: string
}

/**
 * OT update payload — the shape both directions on the wire.
 * Workshop reference: src/api/socketio.ts: UpdateSchema.
 */
export interface UpdateSchema {
  /** Doc ID the update applies to. */
  doc: string
  /** Ops, omitted on no-op acks. */
  op?: OtOp[]
  /** Doc version this update brings the doc TO. */
  v: number
  /** Optional: last known version (some Overleaf versions require it). */
  lastV?: number
  /** Server-stamped metadata, present on otUpdateApplied broadcasts. */
  meta?: {
    source: string  // socket.io client publicId
    ts: number      // unix epoch ms
    user_id: string
  }
}

/**
 * Server response to `joinDoc(docId, { encodeRanges: true })` emit.
 *
 * Returns the doc as an array of lines (latin1-packed UTF-8), the version
 * number, and pending updates that haven't been applied yet (we ignore
 * pending ops in v0.2 — server applies them server-side).
 *
 * Note: the lines come back as latin1 bytes. To recover UTF-8 text:
 *   Buffer.from(line, 'latin1').toString('utf-8')
 */
export type JoinDocResponse = [
  lines: string[],
  version: number,
  /** Pending updates the server has buffered; we don't replay them. */
  updates: UpdateSchema[],
  /** Optional ranges payload; not consumed in v0.2. */
  ranges?: unknown,
]
