import type { ServerContext } from '../server.js'
import { NotFoundError, OverleafError } from '../../errors.js'
import type { TreeNode } from '../../overleaf/ot.js'
import type { CompileRoot, DownloadedBytes, OutputLocation } from '../../overleaf/rest.js'
import { summarizeLatexLog, type LogEntry } from './latex-log.js'

export interface CompileInput {
  projectId: string
  /** Path of the document to compile instead of the project's main document. */
  rootDoc?: string
  draft?: boolean
  stopOnFirstError?: boolean
}

interface CompileResult {
  status: string
  /** Why there is no PDF, for every status other than `success`. */
  message?: string
  /** The document that was compiled. Null only if the project has no main document and the build left no log to tell which one the server chose. */
  rootDoc: string | null
  compiler: string | null
  pdfUrl: string | null
  logUrl: string | null
  /** Names of everything the build produced (output.pdf, output.log, output.bbl, …). */
  outputFiles: string[]
  /** From output.log, capped; the counts are the totals. Absent when the build left no log. */
  errors?: LogEntry[]
  warnings?: LogEntry[]
  errorCount?: number
  warningCount?: number
  validationProblems?: Record<string, unknown>
  pdfDownloadDomain?: string
}

/** Compile result plus what is needed to fetch its files; the latter is not shown to the agent. */
interface LocatedCompile extends CompileResult {
  where: OutputLocation
}

/**
 * What to compile: the document the caller named, else the project's main
 * document as the project itself records it. Only when the project has none
 * is the choice left to the server (which then tries main.tex, or reports
 * `validation-problems`).
 */
async function resolveRoot(
  ctx: ServerContext,
  projectId: string,
  rootDoc: string | undefined,
): Promise<{ root: CompileRoot | undefined; compiler: string | null }> {
  const engine = await ctx.ot.get(projectId)
  const settings = engine.getProjectSettings()
  const path = rootDoc?.replace(/^\/+/, '') ?? settings.rootDoc
  if (path === null) return { root: undefined, compiler: settings.compiler }
  const rootDocId = engine.pathToDocId(path)
  if (rootDocId === null) {
    throw new NotFoundError(
      `rootDoc ${path} is not a text document in project ${projectId}` +
        (settings.rootDoc ? ` (the project's main document is ${settings.rootDoc})` : ''),
      { projectId, rootDoc: path },
    )
  }
  return { root: { rootDocId, rootResourcePath: path }, compiler: settings.compiler }
}

async function compileAndLocate(ctx: ServerContext, input: CompileInput): Promise<LocatedCompile> {
  const { root, compiler } = await resolveRoot(ctx, input.projectId, input.rootDoc)
  const res = await ctx.rest.compile(input.projectId, {
    draft: input.draft,
    stopOnFirstError: input.stopOnFirstError,
    root,
  })
  const outputFiles = res.outputFiles ?? []
  const pdf = outputFiles.find((f) => f.type === 'pdf' || f.path === 'output.pdf')
  const log = outputFiles.find((f) => f.type === 'log' || f.path === 'output.log')
  const message = describeStatus(res.status, res.validationProblems)
  return {
    status: res.status,
    ...(message ? { message } : {}),
    rootDoc: root?.rootResourcePath ?? null,
    compiler,
    pdfUrl: pdf?.url ?? null,
    logUrl: log?.url ?? null,
    outputFiles: outputFiles.map((f) => f.path),
    ...(res.validationProblems ? { validationProblems: res.validationProblems } : {}),
    pdfDownloadDomain: res.pdfDownloadDomain,
    where: { pdfDownloadDomain: res.pdfDownloadDomain, compileGroup: res.compileGroup, clsiServerId: res.clsiServerId },
  }
}

/** The statuses web's CompileManager / ClsiManager can answer with, in words an agent can act on. */
function describeStatus(status: string, problems?: Record<string, unknown>): string | undefined {
  switch (status) {
    case 'success':
      return undefined
    case 'failure':
      return 'LaTeX stopped on an error and produced no PDF. overleaf_compile lists the errors; overleaf_read_compile_log returns the full log.'
    case 'validation-problems':
      return problems && 'mainFile' in problems
        ? 'The project has no main document set and the server could not pick one. Pass rootDoc with the path of the file that has \\documentclass.'
        : 'The server refused to compile the project as it is; see validationProblems.'
    case 'timedout':
      return 'The compile ran into the time limit of this Overleaf account or instance.'
    case 'too-recently-compiled':
      return 'The project was compiled less than a second ago; try again.'
    case 'compile-in-progress':
      return 'Another compile of this project is still running (possibly in someone\'s editor); wait and try again.'
    case 'autocompile-backoff':
      return 'The server is throttling compiles; wait and try again.'
    case 'project-too-large':
      return 'The project is too large to compile.'
    case 'terminated':
      return 'The compile was stopped before it finished.'
    case 'exited':
      return 'The compiler exited abnormally and produced no PDF; see the log.'
    case 'clsi-maintenance':
    case 'unavailable':
      return 'The compile service is unavailable right now; try again later.'
    default:
      return `Compile ended with status "${status}".`
  }
}

async function readLog(ctx: ServerContext, result: LocatedCompile): Promise<string | null> {
  if (!result.logUrl) return null
  const { bytes } = await ctx.rest.downloadOutputFile(result.logUrl, result.where)
  return bytes.toString('utf-8')
}

/**
 * When the project has no main document the server picks one and does not
 * say which. TeX does: the log opens with `**<file it was started on>` — the
 * bare file name, since TeX runs in that file's folder. Reported only if
 * exactly one document of the project has that name.
 */
async function rootFromLog(ctx: ServerContext, projectId: string, log: string): Promise<string | null> {
  const name = /^\*\*(\S.*)$/m.exec(log.slice(0, 4000))?.[1]?.trim().replace(/^\.\//, '')
  if (!name) return null
  const engine = await ctx.ot.get(projectId)
  const matches = allPaths(engine.getTree()).filter((p) => p === name || p.endsWith('/' + name))
  return matches.length === 1 && engine.pathToDocId(matches[0]!) !== null ? matches[0]! : null
}

function allPaths(node: TreeNode, prefix = ''): string[] {
  return [
    ...node.files.map((f) => prefix + f),
    ...Object.entries(node.folders).flatMap(([name, child]) => allPaths(child, `${prefix}${name}/`)),
  ]
}

export async function handleCompile(ctx: ServerContext, input: CompileInput): Promise<CompileResult> {
  const located = await compileAndLocate(ctx, input)
  const { where: _where, ...result } = located
  // The summary is a convenience on top of a compile that already happened:
  // a log that cannot be fetched must not turn its result into an error.
  const log = await readLog(ctx, located).catch(() => null)
  if (log === null) return result
  const rootDoc = result.rootDoc ?? (await rootFromLog(ctx, input.projectId, log))
  return { ...result, rootDoc, ...summarizeLatexLog(log, rootDoc) }
}

export async function handleReadCompileLog(
  ctx: ServerContext,
  input: Pick<CompileInput, 'projectId' | 'rootDoc'>,
): Promise<{ status: string; rootDoc: string | null; log: string }> {
  const result = await compileAndLocate(ctx, input)
  const log = await readLog(ctx, result)
  if (log === null) {
    throw new OverleafError(
      'NOT_FOUND',
      `The compile of project ${input.projectId} produced no log (compile status: ${result.status}).` +
        (result.message ? ` ${result.message}` : ''),
      { status: result.status, ...(result.validationProblems ? { validationProblems: result.validationProblems } : {}) },
    )
  }
  return { status: result.status, rootDoc: result.rootDoc ?? (await rootFromLog(ctx, input.projectId, log)), log }
}

export interface DownloadPdfResult extends DownloadedBytes {
  status: string
}

export async function handleDownloadPdf(
  ctx: ServerContext,
  input: Pick<CompileInput, 'projectId' | 'rootDoc'>,
): Promise<DownloadPdfResult> {
  const result = await compileAndLocate(ctx, input)
  if (!result.pdfUrl) {
    throw new OverleafError(
      'NOT_FOUND',
      `No PDF produced for project ${input.projectId} (compile status: ${result.status}).` +
        (result.message ? ` ${result.message}` : ''),
      { status: result.status },
    )
  }
  const { bytes, contentType } = await ctx.rest.downloadOutputFile(result.pdfUrl, result.where)
  return { bytes, contentType, status: result.status }
}
