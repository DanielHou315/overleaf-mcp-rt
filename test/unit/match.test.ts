import { describe, it, expect } from 'vitest'
import { closestRegion, findMatches } from '../../src/mcp/tools/match.js'

const DOC = [
  '\\section{Results}',
  'Results are superb (agent edit 1).',
  'Typed by the human in the browser.',
].join('\n')

describe('closestRegion', () => {
  it('finds the line when a word in the middle changed (seen live: excellent → superb)', () => {
    expect(closestRegion(DOC, 'Results are excellent (agent edit 1).')).toEqual({
      startLine: 2, endLine: 2, text: 'Results are superb (agent edit 1).',
    })
  })

  it('returns null when nothing in the doc resembles the needle', () => {
    expect(closestRegion(DOC, 'completely unrelated words here')).toBeNull()
  })
})

describe('findMatches', () => {
  it('prefers exact matches and reports every occurrence', () => {
    expect(findMatches('ab ab', 'ab')).toEqual({
      strategy: 'exact', spans: [{ start: 0, end: 2 }, { start: 3, end: 5 }],
    })
  })

  it('falls back to trailing-whitespace-insensitive line matching', () => {
    const r = findMatches('foo  \nbar\n', 'foo\nbar')
    expect(r.strategy).toBe('ignoring-trailing-whitespace')
    expect(r.spans).toEqual([{ start: 0, end: 9 }])
  })

  it('returns no spans rather than guessing from a single token', () => {
    expect(findMatches('alpha beta', 'gamma').spans).toEqual([])
  })
})
