import { describe, it, expect } from 'vitest'
import { summarizeLatexLog } from '../../src/mcp/tools/latex-log.js'

describe('summarizeLatexLog', () => {
  it('reports an error with the project file TeX was reading, the line and the offending text', () => {
    const log = [
      'This is pdfTeX, Version 3.141592653-2.6-1.40.26 (TeX Live 2024)',
      '**paper.tex',
      '(./paper.tex',
      'LaTeX2e <2023-11-01>',
      '(/usr/local/texlive/2024/texmf-dist/tex/latex/base/article.cls',
      'Document Class: article 2023/05/17 v1.4n Standard LaTeX document class',
      ') (./sections/intro.tex',
      '! Undefined control sequence.',
      'l.7 some \\undefinedmacro',
      '                         text',
      'The control sequence at the end of the top line',
      ') (./sections/method.tex)',
      '! Missing $ inserted.',
      '<inserted text> ',
      '                $',
      'l.42 a_b',
      ')',
    ].join('\n')
    const { errors, errorCount } = summarizeLatexLog(log)
    expect(errorCount).toBe(2)
    expect(errors[0]).toEqual({ file: 'sections/intro.tex', line: 7, message: 'Undefined control sequence.', context: 'some \\undefinedmacro' })
    // method.tex was opened and closed again: the second error is back in paper.tex.
    expect(errors[1]).toEqual({ file: 'paper.tex', line: 42, message: 'Missing $ inserted.', context: 'a_b' })
  })

  it('reads -file-line-error style errors', () => {
    const { errors } = summarizeLatexLog('(./main.tex\n./chapters/one.tex:12: Undefined control sequence.\nl.12 \\foo\n')
    expect(errors).toEqual([{ file: 'chapters/one.tex', line: 12, message: 'Undefined control sequence.', context: '\\foo' }])
  })

  it('attributes an error raised inside a package to the project file that was being read', () => {
    const log = '(./main.tex (/usr/local/texlive/2024/texmf-dist/tex/latex/foo/foo.sty\n! Package foo Error: bad option.\n\nl.3 \\usepackage[bad]{foo}\n'
    expect(summarizeLatexLog(log).errors[0]).toMatchObject({ file: 'main.tex', line: 3, message: 'Package foo Error: bad option.' })
  })

  it('collects warnings with their continuation lines and input line, and ignores box noise', () => {
    const log = [
      '(./main.tex',
      "LaTeX Warning: Citation `knuth84' on page 1 undefined on input line 15.",
      '',
      'Overfull \\hbox (12.0pt too wide) in paragraph at lines 20--21',
      'Package hyperref Warning: Token not allowed in a PDF string (Unicode):',
      "(hyperref)                removing `math shift' on input line 30.",
      '',
      'LaTeX Font Warning: Font shape `OT1/cmr/m/sc\' undefined',
      '(Font)              using `OT1/cmr/m/n\' instead on input line 9.',
      '',
      'LaTeX Warning: There were undefined references.',
    ].join('\n')
    const { warnings, warningCount, errorCount } = summarizeLatexLog(log)
    expect(errorCount).toBe(0)
    expect(warningCount).toBe(4)
    expect(warnings[0]).toEqual({ file: 'main.tex', line: 15, message: "Citation `knuth84' on page 1 undefined on input line 15." })
    expect(warnings[1]).toMatchObject({ line: 30, message: "Token not allowed in a PDF string (Unicode): removing `math shift' on input line 30." })
    expect(warnings[2]).toMatchObject({ line: 9 })
    expect(warnings[3]!.message).toBe('There were undefined references.')
  })

  it('rejoins a file name TeX wrapped at its 79-column line width', () => {
    const open = '(./a-rather-long-directory-name/another-long-directory/yet-another/chapter-one'
    expect(open.length).toBeLessThan(79)
    const first = (open + '-with-a-long-file-name.tex').slice(0, 79)
    const rest = (open + '-with-a-long-file-name.tex').slice(79)
    expect(rest.length).toBeGreaterThan(0)
    const { errors } = summarizeLatexLog([first, rest, '! Undefined control sequence.', 'l.2 \\x', ''].join('\n'))
    expect(errors[0]!.file).toBe('a-rather-long-directory-name/another-long-directory/yet-another/chapter-one-with-a-long-file-name.tex')
  })

  it('resolves file names against the folder of the compiled document, where Overleaf runs TeX', () => {
    const log = '(./slides.tex (./parts/one.tex\n! Undefined control sequence.\nl.4 \\x\n) (../shared/macros.tex\n! Undefined control sequence.\nl.9 \\y\n) (../../outside.tex\n! Undefined control sequence.\nl.1 \\z\n)'
    const { errors } = summarizeLatexLog(log, 'talks/slides.tex')
    expect(errors.map((e) => e.file)).toEqual(['talks/parts/one.tex', 'shared/macros.tex', 'talks/slides.tex'])
    // A root document at the top of the project: paths are already project paths.
    expect(summarizeLatexLog(log, 'slides.tex').errors[0]!.file).toBe('parts/one.tex')
  })

  it('caps the lists but keeps the totals', () => {
    const log = Array.from({ length: 65 }, (_, i) => `! Undefined control sequence.\nl.${i + 1} \\x`).join('\n')
    const { errors, errorCount } = summarizeLatexLog(log)
    expect(errorCount).toBe(65)
    expect(errors).toHaveLength(20)
    expect(errors[19]!.line).toBe(20)
  })
})
