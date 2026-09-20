/**
 * Locating `old_string` in a doc.
 *
 * Exact match first. If that finds nothing, fall back to progressively more
 * whitespace-tolerant strategies — models routinely reproduce text with
 * trailing spaces dropped, different indentation, or a re-wrapped paragraph.
 * A tolerant strategy only counts when it identifies exactly one location, and
 * the span it returns is the doc's real text, so the replacement stays exact.
 */

export type MatchStrategy =
  | 'exact'
  | 'ignoring-trailing-whitespace'
  | 'ignoring-indentation'
  | 'ignoring-whitespace-differences'

export interface Span {
  start: number
  end: number
}

export interface MatchResult {
  strategy: MatchStrategy
  spans: Span[]
}

export function findMatches(text: string, needle: string): MatchResult {
  const exact = findExact(text, needle)
  if (exact.length > 0) return { strategy: 'exact', spans: exact }

  const tolerant: Array<[MatchStrategy, () => Span[]]> = [
    ['ignoring-trailing-whitespace', () => findByLines(text, needle, (l) => l.trimEnd())],
    ['ignoring-indentation', () => findByLines(text, needle, (l) => l.trim())],
    ['ignoring-whitespace-differences', () => findCollapsed(text, needle)],
  ]
  for (const [strategy, find] of tolerant) {
    const spans = find()
    if (spans.length > 0) return { strategy, spans }
  }
  return { strategy: 'exact', spans: [] }
}

function findExact(text: string, needle: string): Span[] {
  if (needle.length === 0) return []
  const out: Span[] = []
  let i = 0
  while ((i = text.indexOf(needle, i)) !== -1) {
    out.push({ start: i, end: i + needle.length })
    i += needle.length
  }
  return out
}

/** Match whole lines after normalizing each with `norm`. */
function findByLines(text: string, needle: string, norm: (line: string) => string): Span[] {
  const needleLines = needle.replace(/\r\n/g, '\n').split('\n')
  // A trailing newline in the needle yields an empty last element; whole-line
  // matching already implies the line break.
  if (needleLines.length > 1 && needleLines[needleLines.length - 1] === '') needleLines.pop()
  const wanted = needleLines.map(norm)
  if (wanted.every((l) => l === '')) return []

  const lines = text.split('\n')
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) {
    offsets.push(offset)
    offset += line.length + 1
  }

  const out: Span[] = []
  for (let i = 0; i + wanted.length <= lines.length; i++) {
    let ok = true
    for (let j = 0; j < wanted.length; j++) {
      if (norm(lines[i + j]!) !== wanted[j]) {
        ok = false
        break
      }
    }
    if (!ok) continue
    const last = i + wanted.length - 1
    out.push({ start: offsets[i]!, end: offsets[last]! + lines[last]!.length })
    i = last
  }
  return out
}

/** Match with every run of whitespace treated as equivalent (handles re-wrapped paragraphs). */
function findCollapsed(text: string, needle: string): Span[] {
  const tokens = needle.trim().split(/\s+/).filter(Boolean)
  if (tokens.length < 2) return []
  const pattern = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
  const out: Span[] = []
  for (const m of text.matchAll(new RegExp(pattern, 'g'))) {
    out.push({ start: m.index, end: m.index + m[0].length })
  }
  return out
}

export function lineOf(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/**
 * The region of the doc most similar to `needle`, to show the model what it
 * probably meant when nothing matched. Scores windows of the needle's height
 * by how many (trimmed) lines they share with it.
 */
export function closestRegion(
  text: string,
  needle: string,
): { startLine: number; endLine: number; text: string } | null {
  const wanted = needle.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  if (wanted.length === 0) return null
  const lines = text.split('\n')
  const height = Math.min(needle.split('\n').length, lines.length)
  const wantedSet = new Set(wanted)
  let best = { score: 0, at: -1 }
  for (let i = 0; i + height <= lines.length; i++) {
    let score = 0
    for (let j = 0; j < height; j++) {
      const line = lines[i + j]!.trim()
      if (line === '') continue
      if (wantedSet.has(line)) score += 2
      else if (wanted.some((w) => sharedPrefixRatio(w, line) > 0.6)) score += 1
    }
    if (score > best.score) best = { score, at: i }
  }
  if (best.at < 0) return null
  return {
    startLine: best.at + 1,
    endLine: best.at + height,
    text: lines.slice(best.at, best.at + height).join('\n'),
  }
}

function sharedPrefixRatio(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i / Math.max(a.length, b.length, 1)
}
