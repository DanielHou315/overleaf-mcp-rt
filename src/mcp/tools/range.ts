import type { ServerContext } from '../server.js'
import { NotFoundError, OverleafError } from '../../errors.js'

export interface ReadDocRangeInput {
  projectId: string
  path: string
  startLine?: number
  endLine?: number
  startOffset?: number
  length?: number
}

export interface ReadDocRangeOutput {
  content: string
  startLine?: number
  endLine?: number
  startOffset?: number
  length?: number
  totalLines: number
  totalChars: number
}

export async function handleReadDocRange(
  ctx: ServerContext,
  input: ReadDocRangeInput,
): Promise<ReadDocRangeOutput> {
  const engine = await ctx.ot.get(input.projectId)
  const docId = engine.pathToDocId(input.path)
  if (docId === null) {
    throw new NotFoundError(`No doc at ${input.path} in project ${input.projectId}`)
  }
  const baseline = await engine.joinDoc(docId)
  const text = baseline.text
  const lines = text.split('\n')
  const totalLines = lines.length
  const totalChars = text.length

  if (input.startOffset !== undefined && input.startLine !== undefined) {
    throw new OverleafError(
      'OVERLEAF_GENERIC',
      'read_doc_range accepts startLine OR startOffset, not both',
    )
  }

  if (input.startOffset !== undefined) {
    const start = Math.max(0, input.startOffset)
    const len = input.length ?? totalChars - start
    const end = Math.min(totalChars, start + Math.max(0, len))
    return {
      content: text.slice(start, end),
      startOffset: start,
      length: end - start,
      totalLines,
      totalChars,
    }
  }

  if (input.startLine !== undefined) {
    const start = Math.max(1, input.startLine)
    const end = Math.min(totalLines, input.endLine ?? start)
    if (input.endLine !== undefined && input.endLine < input.startLine) {
      throw new OverleafError(
        'OVERLEAF_GENERIC',
        `read_doc_range: endLine (${input.endLine}) is before startLine (${input.startLine})`,
      )
    }
    // 1-indexed inclusive; lines[start-1..end-1] joined by \n
    const slice = lines.slice(start - 1, end).join('\n')
    return {
      content: slice,
      startLine: start,
      endLine: end,
      totalLines,
      totalChars,
    }
  }

  throw new OverleafError(
    'OVERLEAF_GENERIC',
    'read_doc_range requires either startLine (with optional endLine) or startOffset (with optional length)',
  )
}
