import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseProjectZip } from '../../src/overleaf/zip.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '..', 'fixtures')
const zipBytes = readFileSync(join(FIXTURES, 'project.zip'))

describe('parseProjectZip', () => {
  it('returns text and binary entries with paths', async () => {
    const entries = await parseProjectZip(zipBytes)
    const byPath = new Map(entries.map((e) => [e.path, e]))

    expect(byPath.has('main.tex')).toBe(true)
    expect(byPath.has('refs.bib')).toBe(true)
    expect(byPath.has('figures/img.png')).toBe(true)

    const tex = byPath.get('main.tex')!
    expect(tex.kind).toBe('text')
    expect((tex.content as string)).toContain('\\documentclass')

    const png = byPath.get('figures/img.png')!
    expect(png.kind).toBe('binary')
    expect(Buffer.isBuffer(png.content)).toBe(true)
  })

  it('returns empty entries for an empty zip', async () => {
    const empty = Buffer.from([
      0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ])
    const entries = await parseProjectZip(empty)
    expect(entries).toEqual([])
  })
})
