import { describe, it, expect } from 'vitest'
import { formatBinaryFile } from '../../src/mcp/tools/index.js'

describe('read_file as=base64', () => {
  it('returns a {contentBase64, mimeType} envelope for image MIMEs when as=base64', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const result = formatBinaryFile(
      { bytes: png, contentType: 'image/png' },
      'p1', 'figs/x.png',
      'base64',
    )
    const c = result.content[0] as { type: string; text: string }
    expect(c.type).toBe('text')
    const parsed = JSON.parse(c.text)
    expect(parsed.contentBase64).toBe(png.toString('base64'))
    expect(parsed.mimeType).toBe('image/png')
  })

  it('still returns native image content when as is omitted', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const result = formatBinaryFile(
      { bytes: png, contentType: 'image/png' },
      'p1', 'figs/x.png',
    )
    const c = result.content[0] as { type: string }
    expect(c.type).toBe('image')
  })
})
