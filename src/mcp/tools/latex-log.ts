/**
 * A small reader for TeX's output.log: the errors and warnings, each with the
 * file and line it points at. An agent fixing a build needs those few lines,
 * not the tens of kilobytes of package banners and font lists around them.
 *
 * It is deliberately modest. TeX's log has no grammar; the file a message
 * belongs to is only recoverable by following the parentheses TeX prints as
 * it opens and closes files, which is what this does (as Overleaf's own log
 * panel does). When that goes wrong the message is still reported, without
 * a file.
 */

export interface LogEntry {
  /** Project-relative path, when the log says which file TeX was reading. */
  file?: string
  line?: number
  message: string
  /** For errors: the source text TeX stopped at. */
  context?: string
}

export interface LogSummary {
  errors: LogEntry[]
  warnings: LogEntry[]
  /** Totals; the lists above are capped. */
  errorCount: number
  warningCount: number
}

const MAX_ENTRIES = 20
/** TeX breaks log lines at this width, mid-word, with no marker. */
const WRAP = 79

const FILE_LINE_ERROR = /^(\.{0,2}\/?[^\s:()]+\.[A-Za-z0-9]+):(\d+): (.+)$/
const WARNING = /^(?:LaTeX|(?:Package|Class) \S+) (?:\S+ )?Warning: (.*)$/
const INPUT_LINE = /on input line (\d+)/

/**
 * @param rootDoc Project path of the compiled document. Overleaf runs TeX
 *   from that document's folder (latexmk -cd), so the log's `./x.tex` is
 *   relative to it, not to the project root.
 */
export function summarizeLatexLog(log: string, rootDoc?: string | null): LogSummary {
  const baseDir = rootDoc?.includes('/') ? rootDoc.slice(0, rootDoc.lastIndexOf('/')) : ''
  const projectPath = (path: string): string | null => toProjectPath(path, baseDir)
  const lines = unwrap(log.split(/\r?\n/))
  const errors: LogEntry[] = []
  const warnings: LogEntry[] = []
  const files: Array<string | null> = []
  const currentFile = (): string | undefined => {
    for (let i = files.length - 1; i >= 0; i--) if (files[i]) return files[i]!
    return undefined
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    const fileLine = FILE_LINE_ERROR.exec(line)
    if (line.startsWith('! ') || fileLine) {
      const entry: LogEntry = fileLine
        ? { file: projectPath(fileLine[1]!) ?? undefined, line: Number(fileLine[2]), message: fileLine[3]! }
        : { file: currentFile(), message: line.slice(2) }
      // The source position follows a few lines down as `l.<n> <text so far>`.
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
        const next = lines[j]!
        if (next.startsWith('! ') || FILE_LINE_ERROR.test(next)) break
        const at = /^l\.(\d+) ?(.*)$/.exec(next)
        if (at) {
          entry.line ??= Number(at[1])
          if (at[2]!.trim()) entry.context = at[2]!.trim()
          i = j
          break
        }
      }
      if (!entry.file) delete entry.file
      errors.push(entry)
      continue
    }

    const warning = WARNING.exec(line)
    if (warning) {
      // Continuation lines are indented or carry the package's "(name)" prefix.
      let message = warning[1]!
      while (i + 1 < lines.length && /^(\s{2,}|\(\S+\)\s+)\S/.test(lines[i + 1]!)) {
        message += ' ' + lines[++i]!.replace(/^\(\S+\)\s+/, '').trim()
      }
      const entry: LogEntry = { file: currentFile(), message: message.trim() }
      const at = INPUT_LINE.exec(message)
      if (at) entry.line = Number(at[1])
      if (!entry.file) delete entry.file
      warnings.push(entry)
      continue
    }

    trackFiles(line, files, projectPath)
  }

  return {
    errors: errors.slice(0, MAX_ENTRIES),
    warnings: warnings.slice(0, MAX_ENTRIES),
    errorCount: errors.length,
    warningCount: warnings.length,
  }
}

/** Rejoin lines TeX broke at exactly its line width. */
function unwrap(raw: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i]!
    while (raw[i]!.length === WRAP && i + 1 < raw.length) line += raw[++i]!
    out.push(line)
  }
  return out
}

/**
 * Follow `(./chapter.tex ... )` nesting. A "(" not followed by a path is
 * ordinary text; it is pushed as null so its ")" closes it and not a file.
 */
function trackFiles(line: string, files: Array<string | null>, projectPath: (path: string) => string | null): void {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '(') {
      const path = /^(?:\.{1,2}\/|\/)[^\s()]+/.exec(line.slice(i + 1))
      if (path) {
        files.push(projectPath(path[0]))
        i += path[0].length
      } else {
        files.push(null)
      }
    } else if (ch === ')') {
      files.pop()
    }
  }
}

/**
 * `./sections/intro.tex`, seen from `baseDir`, as a project path. TeX Live's
 * own files (absolute paths) and anything above the project are not the project's.
 */
function toProjectPath(path: string, baseDir: string): string | null {
  if (path.startsWith('/')) return null
  const parts = baseDir ? baseDir.split('/') : []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  return parts.join('/')
}
