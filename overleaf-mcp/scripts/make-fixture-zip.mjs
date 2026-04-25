import archiver from 'archiver'
import { createWriteStream, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'test', 'fixtures', 'project.zip')
mkdirSync(dirname(out), { recursive: true })

const stream = createWriteStream(out)
const archive = archiver('zip', { zlib: { level: 0 } }) // store-only, deterministic

archive.pipe(stream)
archive.append('\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n', {
  name: 'main.tex',
})
archive.append('@article{x, title={Y}, year={2026}}\n', { name: 'refs.bib' })
archive.append(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
  name: 'figures/img.png',
})

await new Promise((resolve, reject) => {
  stream.on('close', resolve)
  archive.on('error', reject)
  archive.finalize()
})

console.log(`wrote ${out}, ${archive.pointer()} bytes`)
