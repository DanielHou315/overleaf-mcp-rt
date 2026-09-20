import type { ServerContext } from '../server.js'
import { DocChangedExternallyError, DocNotReadError, NotFoundError } from '../../errors.js'
import type { DownloadedBytes } from '../../overleaf/rest.js'
import { unstorableNote } from './edit.js'

export interface WriteSummary {
  versionBefore: number
  versionAfter: number
  charsBefore: number
  charsAfter: number
  charsDelta: number
  opsApplied: number
}

export async function handleReadDoc(
  ctx: ServerContext,
  input: { projectId: string; path: string },
): Promise<{ content: string; version: number }> {
  const engine = await ctx.ot.get(input.projectId)
  const docId = engine.pathToDocId(input.path)
  if (docId === null) {
    throw new NotFoundError(`No doc at ${input.path} in project ${input.projectId}`)
  }
  const baseline = await engine.openDoc(docId)
  return { content: baseline.text, version: baseline.version }
}

export async function handleReadFile(
  ctx: ServerContext,
  input: { projectId: string; path: string },
): Promise<DownloadedBytes> {
  const engine = await ctx.ot.get(input.projectId)
  const fileId = engine.pathToFileId(input.path)
  if (fileId === null) {
    throw new NotFoundError(`No binary file at ${input.path} in project ${input.projectId}`)
  }
  return ctx.rest.downloadFile(input.projectId, fileId)
}

export async function handleWriteDoc(
  ctx: ServerContext,
  input: { projectId: string; path: string; content: string; overwrite?: boolean },
): Promise<{ ok: true; summary: WriteSummary; notes?: string[] }> {
  const engine = await ctx.ot.get(input.projectId)
  const docId = engine.pathToDocId(input.path)
  if (docId === null) {
    throw new NotFoundError(`No doc at ${input.path} in project ${input.projectId}`)
  }
  // A whole-doc replace is built from what the agent last read. If that view
  // is missing or stale, writing it would silently revert a collaborator's
  // work — the same reason coding agents refuse to overwrite a file that
  // changed on disk since they read it. The check runs against the live text
  // at the instant the op is emitted.
  const result = await engine.updateDoc(docId, (text) => {
    if (!input.overwrite) {
      if (engine.hasUnseenExternalChanges(docId)) {
        throw new DocChangedExternallyError(
          `${input.path} was edited by a collaborator after you last read it. Nothing was written.`,
          { path: input.path },
        )
      }
      if (!engine.hasSeen(docId) && text !== '') {
        throw new DocNotReadError(
          `${input.path} has content you have not read in this session. Nothing was written.`,
          { path: input.path },
        )
      }
    }
    return input.content
  })
  return {
    ok: true,
    summary: {
      versionBefore: result.versionBefore,
      versionAfter: result.versionAfter,
      charsBefore: result.textBefore.length,
      charsAfter: result.textAfter.length,
      charsDelta: result.textAfter.length - result.textBefore.length,
      opsApplied: result.ops.length === 0 ? 0 : 1,
    },
    ...(result.unstorableCodeUnits > 0 ? { notes: [unstorableNote(result.unstorableCodeUnits)] } : {}),
  }
}
