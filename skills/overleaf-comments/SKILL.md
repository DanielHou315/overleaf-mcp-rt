---
name: overleaf-comments
description: Reading, writing, answering and resolving Overleaf review-panel comments via overleaf_list_comments, overleaf_add_comment, overleaf_reply_comment and overleaf_resolve_comment, including the mandatory "Co-authored by" signature. Use when the user asks you to review a document, leave feedback or questions, respond to comments a collaborator left, or when you would otherwise change a passage whose meaning is the author's call.
---

# Overleaf comments

A comment attaches a discussion thread to a span of text **without changing the text**.

## Comment or edit?

- **Edit** when the user asked for the change, or it is mechanical (typo, broken reference, compile error).
- **Comment** when it is the author's decision: claims, numbers, framing, tone, cuts, anything in a co-author's section. Also for questions ("which dataset is this?") and for explaining a non-obvious edit you made.
- When reviewing a document, default to comments, and say in your reply how many you left and where.

## Signature — required

Comments are posted through the logged-in Overleaf account, which is usually **the user's own**, so Overleaf shows *them* as the author. To keep it honest, every comment you write must end with:

```
Co-authored by <your agent name>
```

Pass `agentName` — the name you, the assistant, go by — to `overleaf_add_comment` / `overleaf_reply_comment` and the server appends that line for you — do not also write it in `content`. Set `omitSignature: true` **only if the user has explicitly told you not to sign comments**; if they did, that instruction holds for the rest of the session.

## Using the tools

- `overleaf_list_comments { projectId, path }` — threads on a doc: `threadId`, `line`, `anchorText`, `resolved`, and each message with its author. Add `includeResolved: true` for history. Check this before revising a file someone has reviewed.
- `overleaf_add_comment { projectId, path, anchorText, content, agentName }` — `anchorText` must match exactly one place, like `old_string`. Anchor to the specific phrase you mean, not a whole paragraph. One point per comment; be concrete and propose wording where you can.
- `overleaf_reply_comment { projectId, threadId, content, agentName }` — answer in the thread that raised the point rather than opening a new one. When a comment asked for a change and you made it, reply saying what you changed.
- `overleaf_resolve_comment { projectId, path, threadId }` — resolve a thread **you** opened once it is dealt with. Leave threads opened by people for them to resolve, unless the user asked you to tidy up. `resolved: false` reopens.

## Where comments don't exist

Comments need Overleaf's review panel: overleaf.com and Server Pro have it, stock **Community Edition does not**. There the tools return `COMMENTS_UNSUPPORTED` and change nothing. Fall back to a LaTeX comment next to the passage — `% NOTE(<your agent name>): …` — and list those notes for the user, since nothing in the UI will surface them.
