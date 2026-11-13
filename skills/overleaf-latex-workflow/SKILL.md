---
name: overleaf-latex-workflow
description: Working practices for LaTeX projects on Overleaf - finding the main document, compiling it or another file, reading the errors, fixing them, and keeping a shared paper buildable. Use when asked to write or revise a paper, fix a compile error, add figures, tables, sections or citations, or check that an Overleaf project still builds.
---

# LaTeX workflow on Overleaf

Use the `overleaf-editing` skill for *how* to change text. This skill is about *what* to change and how to know it worked.

## Orient first

- `overleaf_get_project_tree` returns the file tree and `rootDoc`: the project's main document, the file a compile starts from. It is whatever the project's owner set — do not assume `main.tex`. (If `rootDoc` is `null` the project has none set; look for the file with `\documentclass`.) Read it and follow its `\input` / `\include` / `\subfile` lines to see which file holds which section. Edit the file that actually contains the text.
- Match the project's conventions before writing: its macros (`\newcommand`s in the preamble), citation command (`\cite` / `\citep` / `\autocite`), label scheme (`fig:`, `sec:`, `eq:`), quote style, and whether it writes one sentence per line.
- One sentence per line (where the project already does this) makes edits small and collaboration-friendly. Do **not** re-wrap or reformat paragraphs you were not asked to change — it rewrites lines other people are working on.

## Keep it building

1. Before a non-trivial change, note whether the project builds: `overleaf_compile`.
2. Make the change.
3. `overleaf_compile` again and read its `errors`: each has the file, the line and the text TeX stopped at. Start from the **first** one; later errors are usually fallout. `status: "success"` only means a PDF came out — LaTeX recovers from many errors, so a clean build is `errorCount: 0`. Any other status comes with a `message` saying why there is no PDF. Reach for `overleaf_read_compile_log` (the whole log, often tens of kilobytes) only when the summary is not enough — an error is `! …` followed by an `l.<line>` marker.
4. Fix, recompile, repeat. **Leave the project in a building state**, or tell the user exactly what is still broken. A person may need to export a PDF minutes from now.

Common first errors: `Undefined control sequence` (missing `\usepackage`, or a macro the project doesn't define), `Missing $ inserted` (unescaped `_`, `^`, `%`, `&`, `#` in text), `File … not found` (wrong relative path — paths are relative to the root file, not to the included file), unbalanced `\begin`/`\end` or braces, `Citation … undefined` (key missing from the `.bib`; may need a second compile).

`overleaf_compile` takes `draft: true` (faster, skips images) and `stopOnFirstError: true`. `overleaf_download_pdf` returns the PDF when you need to check layout.

**Compiling a particular file.** A compile builds the project's main document. To build something else — slides or a cover letter kept in the same project, a chapter that stands on its own — pass its path as `rootDoc` to `overleaf_compile` (and to `overleaf_read_compile_log` / `overleaf_download_pdf`). That affects only that call; the project's main document, which is what the people in the editor compile, stays as it is. The file must have its own `\documentclass`: a section that is `\input` into the paper cannot be compiled by itself — compile the main document and look at the errors reported for that file. Every result names the `rootDoc` that was compiled; check it is the one you meant.

## Adding content

- **Citations:** add the entry to the project's existing `.bib` file with `overleaf_edit_doc` (anchor on a neighbouring entry). Check the key is not already there. Never invent bibliographic details — if you cannot verify a reference, add a `% TODO` and tell the user.
- **Figures:** `overleaf_upload_file` into the project's figures folder, then `\includegraphics` with a path relative to the root file. Give every figure and table a `\caption` and a `\label` placed *after* the caption, and refer to it with `\ref` / `\cref`.
- **Packages:** add `\usepackage` lines to the preamble sparingly, next to the existing ones; some packages conflict or must load in a particular order (`hyperref` near the end, `cleveref` after it).
- **Drafts and alternatives:** put experimental text in a new file and `\input` it, or comment the old version out, rather than deleting a collaborator's paragraph.

## Talking to humans in the document

Prefer a review comment (`overleaf-comments` skill) for questions and suggestions. Where comments are unavailable (stock Community Edition), leave `% TODO(<your agent name>): …` next to the passage — never silent changes to meaning, numbers, claims or author lists.
