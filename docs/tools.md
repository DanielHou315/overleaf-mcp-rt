# Tool reference

The [README](../README.md#tools) lists every tool. This page covers the details: how edits are matched, what comes back, how collaborators' changes are reported, the comment signature, and the error envelope.

- [Editing with `overleaf_edit_doc`](#editing-with-overleaf_edit_doc)
- [Whole-document writes](#whole-document-writes)
- [Reading files](#reading-files)
- [Working alongside humans: `<external-changes>`](#working-alongside-humans-external-changes)
- [Comments and the signature rule](#comments-and-the-signature-rule)
- [Error envelope](#error-envelope)

All tools are prefixed `overleaf_` so they stay unambiguous in clients that don't namespace by server, and all take an optional `host` (see [Multiple hosts](configuration.md#multiple-hosts)).

## Editing with `overleaf_edit_doc`

Exact string replacement, the way coding agents edit files:

```json
{ "projectId": "…", "path": "main.tex", "edits": [
  { "old_string": "Results are good.", "new_string": "Results are excellent." },
  { "old_string": "\\cite{old}", "new_string": "\\cite{new}", "replace_all": true }
] }
```

It returns a write summary plus a unified `diff` of what changed.

- `old_string` must identify **exactly one** place in the doc. Otherwise the call fails with `EDIT_AMBIGUOUS` and the matching line numbers — add surrounding text, or set `replace_all`.
- Edits apply **in order**, each to the result of the previous one, and **atomically**: if any edit fails, nothing is sent.
- Text is addressed by content, never by offset, and matched against the **live** doc at the instant the op is sent. An agent edit therefore composes with whatever a person is typing elsewhere in the file. If the person changed the very text being targeted, the call fails with `EDIT_NO_MATCH`, reports the closest region, and the attached `<external-changes>` block shows their edit.
- If `old_string` isn't found verbatim, a match that differs only in trailing whitespace, indentation or line wrapping is accepted when it is unambiguous (reported in `notes`). The replaced span is always the doc's real text.
- The op sent to Overleaf is the minimal character diff, so collaborators' cursors and selections outside the changed characters are undisturbed.
- To insert, use an anchor as `old_string` and repeat it in `new_string`. To delete, pass `new_string: ""`.
- `dryRun: true` returns the diff and the resolved OT ops without sending anything.

Legacy v1.1 edits carrying a `mode` field (`replace`, `insert_before`, `insert_after`, `replace_lines`, `unified_diff`, `raw_ops`) are still accepted. `replace_lines` and `raw_ops` address the doc by position, so they are refused with `DOC_CHANGED_EXTERNALLY` if a collaborator edited the doc since the agent last saw it.

## Whole-document writes

`overleaf_write_doc` replaces a whole doc; only the differing characters are sent. It is refused if the agent hasn't read the doc this session (`DOC_NOT_READ`) or a collaborator edited it since (`DOC_CHANGED_EXTERNALLY`), unless `overwrite: true`. Prefer `overleaf_edit_doc`.

## Reading files

- `overleaf_read_doc` returns the live text: it reflects collaborators' keystrokes up to the instant of the call.
- `overleaf_read_doc_range` returns part of a doc, by 1-indexed inclusive line range (`startLine`, `endLine`) or by character `startOffset` / `length`, along with `totalLines` and `totalChars`. Use it to check a small region after an edit instead of re-fetching the doc.
- `overleaf_read_file` reads a binary file. With the default `as: "auto"` it returns native MCP image content for images, text for text types, a resource for PDFs, and a base64 envelope otherwise. `as: "base64"` forces the `{contentBase64, mimeType}` envelope for any type, which is what `overleaf_upload_file` takes.

## Working alongside humans: `<external-changes>`

The server keeps a live, server-confirmed copy of every doc the agent has opened, applying each collaborator's op as it arrives, so the agent always edits the current version. It also remembers what the agent has *been shown*. Whenever the two differ, the next tool result for that project — success or error — gets an extra text block:

```
<external-changes>
Collaborators changed this project since your last tool call. …

main.tex — edited by Ada Lovelace, 12s ago (v41 → v45)
@@ -1,3 +1,3 @@
 \section{Introduction}
-We study the problem of widgets.
+We study the problem of gadgets.

File tree:
- created doc appendix.tex by Ada Lovelace
</external-changes>
```

This is the Overleaf analogue of a coding agent noticing that a file changed on disk: the agent stays current without re-reading, and each change is reported once. Only docs the agent has read are reported; the agent's own edits never are. `overleaf_check_changes` returns the same report on demand, for polling.

## Comments and the signature rule

The comment tools work on overleaf.com and Server Pro. Stock Community Edition has no review panel, so there they fail up front with `COMMENTS_UNSUPPORTED` and change nothing.

- `overleaf_list_comments` returns each thread's id, line, anchored text, resolved state and messages with their authors. Anchors follow the text live as people edit.
- `overleaf_add_comment` attaches a comment to a span of text without changing it. `anchorText` must match exactly one place (same matching rules as `old_string`); a bad anchor creates nothing.
- `overleaf_reply_comment` refuses unknown thread ids rather than creating an orphan thread.
- `overleaf_resolve_comment` resolves a thread, or reopens it with `resolved: false`.

**Signature.** Comments are posted through the logged-in Overleaf account — on overleaf.com usually the person's own — so Overleaf shows that person as the author. To keep the agent's words distinguishable from theirs, every agent comment ends with `Co-authored by <agent name>`. The server enforces this: `agentName` is required and the line is appended for the agent (never doubled). `omitSignature: true` is for when the user has explicitly asked for unsigned comments.

## Error envelope

Every tool error is JSON inside an MCP `text` content block, with `isError: true`:

```json
{
  "code": "OT_DELETE_MISMATCH",
  "message": "Delete op #0 at position 0 expected \"FOO\" but doc has \"BAR\"",
  "context": { "p": 0, "expected": "FOO", "actual": "BAR", "opIndex": 0 },
  "retryable": false,
  "hint": "The d-string did not match the doc at position p. Re-read the doc to get the current text, then recompute offsets."
}
```

`retryable: true` marks transient failures an agent may retry. `hint` gives a one-line next step for the common ones.

| Code | Meaning |
|---|---|
| `OVERLEAF_GENERIC` | Validation and other untyped errors (out-of-bounds line range, mixed-mode `edit_doc`, …). |
| `OVERLEAF_AUTH_FAILED` | Session cookie invalid or expired. Run `overleaf-mcp-rt login` again. |
| `PROXY_AUTH_FAILED` | A reverse proxy blocked the request — configure [extra headers](configuration.md#behind-a-reverse-proxy). |
| `PROJECT_ACCESS_DENIED` | The session can't reach the requested project. |
| `NOT_FOUND` | No doc, file or folder at the given path. |
| `NETWORK_ERROR` | Transport-level failure (`retryable: true`). |
| `INVALID_CONFIG` | Missing or malformed URL, cookie or extra headers. |
| `EDIT_NO_MATCH` | `old_string` (or a `unified_diff`'s context) isn't in the live doc. `context.closest` holds the most similar region. |
| `EDIT_AMBIGUOUS` | `old_string` matches more than one place; `context.lines` lists them. |
| `DOC_CHANGED_EXTERNALLY` | A collaborator edited the doc after the agent last saw it, and the operation (`overleaf_write_doc`, `replace_lines`, `raw_ops`) depends on that stale view. Nothing was written. |
| `DOC_NOT_READ` | `overleaf_write_doc` on a non-empty doc the agent never read. |
| `OT_DELETE_MISMATCH` | A `d`-string in `raw_ops` mode didn't match the doc at `p`. Checked before anything is sent. |
| `COMMENTS_UNSUPPORTED` | The instance has no comment threads (stock Community Edition). Nothing was changed. |
| `HISTORY_OT_WRITES_DISABLED` | The document uses [Overleaf's newer format](configuration.md#overleafs-newer-document-format-history-ot); reading works, writing needs `OVERLEAF_HISTORY_OT_WRITES=1`. Nothing was sent. |
| `HISTORY_OT_MISMATCH` | After a write to such a document, Overleaf's copy differed from what was predicted. Further history-OT writes are refused for the session; please report it. |
