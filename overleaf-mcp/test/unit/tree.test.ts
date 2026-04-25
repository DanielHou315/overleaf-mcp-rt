import { describe, it, expect } from 'vitest'
import { ProjectTree, type ProjectEntry } from '../../src/overleaf/tree.js'

const entries: ProjectEntry[] = [
  { kind: 'text', path: 'main.tex', content: 'Hello' },
  { kind: 'text', path: 'chapters/intro.tex', content: 'Intro' },
  { kind: 'binary', path: 'figures/img.png', content: Buffer.from([0]) },
]

describe('ProjectTree', () => {
  it('returns text content by path', () => {
    const tree = new ProjectTree(entries)
    expect(tree.readDoc('main.tex')).toBe('Hello')
    expect(tree.readDoc('chapters/intro.tex')).toBe('Intro')
  })

  it('returns binary content by path', () => {
    const tree = new ProjectTree(entries)
    expect(tree.readFile('figures/img.png')!.length).toBe(1)
  })

  it('returns null for nonexistent paths', () => {
    const tree = new ProjectTree(entries)
    expect(tree.readDoc('missing.tex')).toBeNull()
    expect(tree.readFile('missing.png')).toBeNull()
  })

  it('throws when reading text as binary or vice versa', () => {
    const tree = new ProjectTree(entries)
    expect(() => tree.readDoc('figures/img.png')).toThrow(/binary/)
    expect(() => tree.readFile('main.tex')).toThrow(/text/)
  })

  it('lists the tree as folders + files', () => {
    const tree = new ProjectTree(entries)
    const json = tree.asTree()
    expect(json.files.sort()).toEqual(['main.tex'])
    expect(Object.keys(json.folders).sort()).toEqual(['chapters', 'figures'])
    expect(json.folders.chapters!.files).toEqual(['intro.tex'])
    expect(json.folders.figures!.files).toEqual(['img.png'])
  })
})
