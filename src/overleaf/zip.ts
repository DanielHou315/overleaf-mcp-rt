import unzipper from 'unzipper'

export type ProjectEntry =
  | { kind: 'text'; path: string; content: string }
  | { kind: 'binary'; path: string; content: Buffer }

const TEXT_EXTENSIONS = new Set([
  '.tex',
  '.bib',
  '.cls',
  '.sty',
  '.bst',
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.tsv',
  '.r',
  '.py',
  '.html',
  '.css',
  '.js',
  '.ts',
])

function isText(path: string): boolean {
  const lastDot = path.lastIndexOf('.')
  if (lastDot < 0) return false
  return TEXT_EXTENSIONS.has(path.slice(lastDot).toLowerCase())
}

export async function parseProjectZip(bytes: Buffer | Uint8Array): Promise<ProjectEntry[]> {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const directory = await unzipper.Open.buffer(buf)
  const entries: ProjectEntry[] = []
  for (const file of directory.files) {
    if (file.type !== 'File') continue
    const content = await file.buffer()
    if (isText(file.path)) {
      entries.push({ kind: 'text', path: file.path, content: content.toString('utf-8') })
    } else {
      entries.push({ kind: 'binary', path: file.path, content })
    }
  }
  return entries
}
