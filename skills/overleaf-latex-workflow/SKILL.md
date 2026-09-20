---
name: overleaf-latex-workflow
description: Working practices for LaTeX projects on Overleaf - finding the root file, compiling, reading the log, fixing errors, and keeping a shared paper buildable. Use when asked to write or revise a paper, fix a compile error, add figures, tables, sections or citations, or check that an Overleaf project still builds.
---

# LaTeX workflow on Overleaf

Use the `overleaf-editing` skill for *how* to change text. This skill is about *what* to change and how to know it worked.

## Orient first

- `overleaf_get_project_tree`, then read the root file (usually `main.tex`; otherwise the one with `\documentclass`). Follow its `\input` / `\include` / `\subfile` lines to see which file holds which section. Edit the file that actually contains the text.
- Match the project's conventions before writing: its macros (`\newcommand`s in the preamble), citation command (`\cite` / `\citep` / `\autocite`), label scheme (`fig:`, `sec:`, `eq:`), quote style, and whether it writes one sentence per line.
- One sentence per line (where the project already does this) makes edits small and collaboration-friendly. Do **not** re-wrap or reformat paragraphs you were not asked to change — it rewrites lines other people are working on.

## Keep it building

1. Before a non-trivial change, note whether the project builds: `overleaf_compile`.
2. Make the change.
3. `overleaf_compile` again. On failure, `overleaf_read_compile_log` and read from the **first** error (`! …` with an `l.<line>` marker); later errors are usually fallout.
4. Fix, recompile, repeat. **Leave the project in a building state**, or tell the user exactly what is still broken. A person may need to export a PDF minutes from now.

Common first errors: `Undefined control sequence` (missing `\usepackage`, or a macro the project doesn't define), `Missing $ inserted` (unescaped `_`, `^`, `%`, `&`, `#` in text), `File … not found` (wrong relative path — paths are relative to the root file, not to the included file), unbalanced `\begin`/`\end` or braces, `Citation … undefined` (key missing from the `.bib`; may need a second compile).

`overleaf_compile` takes `draft: true` (faster, skips images) and `stopOnFirstError: true`. `overleaf_download_pdf` returns the PDF when you need to check layout.

## Adding content

- **Citations:** add the entry to the project's existing `.bib` file with `overleaf_edit_doc` (anchor on a neighbouring entry). Check the key is not already there. Never invent bibliographic details — if you cannot verify a reference, add a `% TODO` and tell the user.
- **Figures:** `overleaf_upload_file` into the project's figures folder, then `\includegraphics` with a path relative to the root file. Give every figure and table a `\caption` and a `\label` placed *after* the caption, and refer to it with `\ref` / `\cref`.
- **Packages:** add `\usepackage` lines to the preamble sparingly, next to the existing ones; some packages conflict or must load in a particular order (`hyperref` near the end, `cleveref` after it).
- **Drafts and alternatives:** put experimental text in a new file and `\input` it, or comment the old version out, rather than deleting a collaborator's paragraph.

## Talking to humans in the document

Prefer a review comment (`overleaf-comments` skill) for questions and suggestions. Where comments are unavailable (stock Community Edition), leave `% TODO(<your agent name>): …` next to the passage — never silent changes to meaning, numbers, claims or author lists.
