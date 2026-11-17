---
name: overleaf-editing
description: How to read and edit Overleaf documents through the overleaf_* MCP tools without disrupting people who have the project open, including suggesting edits as tracked changes for a person to accept or reject. Use whenever you are about to read, edit, create, move or delete files in an Overleaf project, when the user wants to approve your edits first, or when a tool result contains an <external-changes> block, EDIT_NO_MATCH, EDIT_AMBIGUOUS, DOC_CHANGED_EXTERNALLY, DOC_NOT_READ, TRACK_CHANGES_UNSUPPORTED or TRACK_CHANGES_LIMIT.
---

# Editing Overleaf documents

These are **live, shared documents**. A person may be typing in the same file right now, and your edits appear in their editor within about a tenth of a second, as if a co-author typed them.

## The loop

1. `overleaf_list_projects` → `overleaf_get_project_tree` to find paths. With several Overleaf instances, pass `host` on every call (`overleaf_list_hosts`); project ids belong to one host.
2. `overleaf_read_doc` once per file you will touch. For a big file you only need part of, `overleaf_read_doc_range`.
3. Change text with **`overleaf_edit_doc`**: `edits: [{ old_string, new_string }]`.
4. Check the `diff` in the result. Do not re-read the file to verify.

## Rules for `overleaf_edit_doc`

- `old_string` must match **exactly one** place. Copy it from the doc and include enough surrounding text to be unique. `EDIT_AMBIGUOUS` lists the matching lines — widen the string. Use `replace_all: true` only when you mean every occurrence.
- Make the **smallest edit that does the job**. Replace the sentence, not the section: small edits merge cleanly with what others are typing and keep their cursor where it was.
- Several edits to one file go in **one call**. They apply in order, each seeing the previous result, and atomically — if one fails, none apply.
- Insert by repeating an anchor: `old_string: "\\section{Results}"`, `new_string: "\\section{Results}\nNew paragraph."`. Delete with `new_string: ""`.
- JSON needs LaTeX backslashes doubled: `\\cite{x}`.
- Overleaf cannot store emoji or other characters outside the Basic Multilingual Plane; they are stored as `\uFFFD` and the result's `notes` says so. Use a LaTeX command instead.

## Suggesting instead of editing: `trackChanges`

When the user wants to approve your edits before they take effect (they ask for suggestions or tracked changes, or to review what you change), pass `trackChanges: true` to `overleaf_edit_doc` (or `overleaf_write_doc`). Each insertion and deletion then waits in the review panel for them to accept or reject, and the result says `tracked: true`.

- The doc text already shows your suggestions: insertions are in it, deleted text is gone. Do not apply them again. If someone rejects one, the restored text arrives in `<external-changes>`; do not redo it.
- Leave other people's pending suggestions alone unless asked: deleting text someone suggested rejects their suggestion.
- Suggestions appear under the logged-in account, usually the user's own, and cannot be signed. Say in your reply which suggestions are yours.
- If results say `tracked: true` without you asking, the session tracks by default; pass `trackChanges: false` only when the user wants a direct edit.
- `TRACK_CHANGES_UNSUPPORTED`: nobody could review tracked changes here (no review panel, the owner's plan, or the newer document format). Nothing was changed. If the message says a direct edit is possible, ask whether to make it; otherwise describe the change in your reply.
- `TRACK_CHANGES_LIMIT`: the document has too many pending changes, or too much pending text. Nothing was sent. Ask the user to accept or reject some first; an untracked edit is no way around it.

## `<external-changes>` — read it every time

A tool result may end with an `<external-changes>` block: a diff of what collaborators changed since your previous call, with who and when. It replaces re-reading. Treat it as ground truth:

- Your memory of those lines is stale; use the new text in later `old_string`s.
- **Never revert a human's change** because it differs from what you wrote or expected. If it conflicts with your task, say so and ask.
- `EDIT_NO_MATCH` right after someone edited the same spot is normal: take the current text from the diff (or `context.closest`) and retry. Nothing was written.

## Avoid `overleaf_write_doc`

It replaces the whole file from your possibly stale copy. It is refused if you have not read the doc (`DOC_NOT_READ`) or someone edited it since (`DOC_CHANGED_EXTERNALLY`). Those refusals are protecting someone's work: switch to `overleaf_edit_doc`. Only pass `overwrite: true` if the user explicitly asked to replace the file wholesale. It is fine for a new or empty file.

## Files and folders

`overleaf_create_doc` (with `content`), `overleaf_create_folder`, `overleaf_upload_file` (base64, for images and PDFs), `overleaf_rename`, `overleaf_move`, `overleaf_delete_entity`. `parentPath: ""` is the project root. Deleting is immediate and shared — confirm with the user before deleting anything you did not create in this session. After a rename or move, update the `\input`, `\include`, `\includegraphics` and `\bibliography` lines that point at the old path.
