import type { ServerContext } from '../server.js'
import { OverleafError } from '../../errors.js'
import type { DownloadedBytes, OutputLocation } from '../../overleaf/rest.js'

interface CompileResult {
  status: string
  pdfUrl: string | null
  logUrl: string | null
  pdfDownloadDomain?: string
}

/** Compile result plus what is needed to fetch its files; the latter is not shown to the agent. */
interface LocatedCompile extends CompileResult {
  where: OutputLocation
}

async function compileAndCache(
  ctx: ServerContext,
  projectId: string,
  opts: { draft?: boolean; stopOnFirstError?: boolean } = {},
): Promise<LocatedCompile> {
  const res = await ctx.rest.compile(projectId, opts)
  const pdf = res.outputFiles.find((f) => f.type === 'pdf' || f.path === 'output.pdf')
  const log = res.outputFiles.find((f) => f.type === 'log' || f.path === 'output.log')
  return {
    status: res.status,
    pdfUrl: pdf?.url ?? null,
    logUrl: log?.url ?? null,
    pdfDownloadDomain: res.pdfDownloadDomain,
    where: { pdfDownloadDomain: res.pdfDownloadDomain, compileGroup: res.compileGroup, clsiServerId: res.clsiServerId },
  }
}

export async function handleCompile(
  ctx: ServerContext,
  input: { projectId: string; draft?: boolean; stopOnFirstError?: boolean },
): Promise<CompileResult> {
  const { where: _where, ...result } = await compileAndCache(ctx, input.projectId, {
    draft: input.draft,
    stopOnFirstError: input.stopOnFirstError,
  })
  return result
}

export async function handleReadCompileLog(
  ctx: ServerContext,
  input: { projectId: string },
): Promise<{ log: string }> {
  const result = await compileAndCache(ctx, input.projectId)
  if (!result.logUrl) {
    throw new OverleafError(
      'NOT_FOUND',
      `The compile of project ${input.projectId} produced no log (compile status: ${result.status})`,
      { status: result.status },
    )
  }
  const { bytes } = await ctx.rest.downloadOutputFile(result.logUrl, result.where)
  return { log: bytes.toString('utf-8') }
}

export interface DownloadPdfResult extends DownloadedBytes {
  status: string
}

export async function handleDownloadPdf(
  ctx: ServerContext,
  input: { projectId: string },
): Promise<DownloadPdfResult> {
  const result = await compileAndCache(ctx, input.projectId)
  if (!result.pdfUrl) {
    throw new OverleafError(
      'NOT_FOUND',
      `No PDF produced for project ${input.projectId} (compile status: ${result.status})`,
    )
  }
  const { bytes, contentType } = await ctx.rest.downloadOutputFile(result.pdfUrl, result.where)
  return { bytes, contentType, status: result.status }
}
