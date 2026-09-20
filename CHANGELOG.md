# Changelog

All notable changes to `overleaf-mcp-rt`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/). The "public API" for versioning purposes is the MCP tool surface (names, arguments, result shapes, error codes), the CLI, and the credentials file format.

## [Unreleased]

Everything since 1.1.1. (1.2.0 was prepared but never published; its changes are included here.)

The theme: the server is now safe to use **while a human edits the same document in the browser**, it works against **overleaf.com** as well as self-hosted instances, and editing works the way coding agents edit files.

### Fixed

- **Agent edits knocking browser sessions "out of sync".** The OT engine ignored collaborators' `otUpdateApplied` broadcasts, so once a human typed, the agent's next op was computed against stale text and submitted at a stale version. document-updater rejected it (`Delete component … does not match`), and Overleaf's real-time service answers a rejected op by sending `otUpdateError` to — and disconnecting — *every* client in the doc, discarding the human's unsaved keystrokes. The engine now applies every remote op to a live snapshot, transforms its own in-flight op past ops that beat it to the server (a port of the ShareJS `text` type document-updater itself runs, so both sides compute the same text), and evaluates edits against the live text in the same tick the op is emitted.
- **Write confirmation.** The `applyOtUpdate` ack only means the op was queued. The engine now waits for the real confirmation (`otUpdateApplied {doc, v}`) and surfaces `otUpdateError` rejections, which were previously invisible.
- **Parallel reads.** real-time fails a `joinDoc` that another join overtakes; joins are now serialized, time out instead of wedging the queue, and updates that arrive before a join's response are replayed onto the snapshot.
- **The server starts even when the session has expired.** Auth is checked on the first tool call and reported as `OVERLEAF_AUTH_FAILED` with a hint, instead of the process exiting before the MCP handshake (which hosts show as an unexplained "connection closed"). Logging in again fixes a running server without a restart.
- The version reported in the MCP handshake and `--help` was hard-coded (`1.0.0`); it now comes from `package.json`.

### Added

- **`overleaf_edit_doc` by exact string replacement** — `{old_string, new_string, replace_all?}`: `old_string` must match exactly one place, edits apply sequentially and atomically, a whitespace/indentation/re-wrap-tolerant fallback is accepted when unambiguous, the op sent is the minimal character diff (collaborators' cursors elsewhere are undisturbed), and the result includes a unified diff. Failures report the closest matching region.
- **External-change awareness** — every tool result (success or error) carries an `<external-changes>` block — diff, author, age, plus file-tree events — when collaborators changed something the agent has already seen. Reported once; the agent's own edits never are. New tool `overleaf_check_changes` for polling.
- **Multiple hosts** — one server can be logged in to several Overleaf instances. Every tool takes an optional `host`; new tool `overleaf_list_hosts`; new `hosts` CLI command; `--host` for `ls` and `diagnose`. Credentials file v2 (`{default, hosts}`); the v1 file is still read and is upgraded by the next `login`.
- **overleaf.com support** for projects on the classic OT pipeline, verified against production. The server fetches the load-balancer stickiness cookie (`GCLB`) so the Socket.IO handshake and websocket reach the same backend.
- **Browser login** — `login --browser` launches an installed Chromium-family browser with a throwaway profile, lets you sign in normally (CAPTCHA, SSO, 2FA), and captures the session over the DevTools protocol. No prompts when `--url` and `--browser` are both given. `OVERLEAF_BROWSER` picks the binary.
- **Friendlier cookie login** — accepts a bare value or `name=value` and detects `overleaf_session2` / `overleaf.sid` / `sharelatex.sid`.
- **Review-panel comments** (overleaf.com and Server Pro) — `overleaf_list_comments`, `overleaf_add_comment`, `overleaf_reply_comment`, `overleaf_resolve_comment`. Comments are posted through the logged-in account, so every agent comment ends with `Co-authored by <agent name>`; the server enforces this (`agentName` is required), with `omitSignature` for when the user explicitly opts out. Stock Community Edition has no review panel: these tools fail up front with `COMMENTS_UNSUPPORTED` and change nothing.
- **The repository is an installable agent plugin** for Claude Code, Cursor and Codex: dual manifests (`.claude-plugin/`, `.cursor-plugin/`), shared `skills/` and `commands/`, and the MCP server wired in. Four concise, model-neutral skills (`overleaf-setup`, `overleaf-editing`, `overleaf-latex-workflow`, `overleaf-comments`) and two commands (`/overleaf-login`, `/overleaf-status`). `overleaf-mcp-rt skills install [--target <dir>]` copies the skills for any other harness.
- MCP server `instructions`, giving every connecting agent the collaboration and signature rules.
- `overleaf_read_doc` returns the doc `version`. `--version` flag. CI and tag-driven release workflows. `OVERLEAF_CREDENTIALS_FILE` relocates the credentials file.
- New error codes: `EDIT_NO_MATCH`, `EDIT_AMBIGUOUS`, `DOC_CHANGED_EXTERNALLY`, `DOC_NOT_READ`, `COMMENTS_UNSUPPORTED`.
- **Overleaf CE 6.x is supported** and is now the primary target (3.x – 6.x declared).
- Live-testing helpers: `scripts/agent-session.mjs`, `scripts/latency-probe.mjs`, `scripts/smoke-stdio.mjs`.

### Changed

- **`overleaf_write_doc` refuses to clobber** a doc the agent has not read this session (`DOC_NOT_READ`) or that a collaborator edited since (`DOC_CHANGED_EXTERNALLY`). Pass `overwrite: true` for the old behaviour. It now sends only the differing characters.
- `unified_diff` edits no longer send "delete everything, insert everything". Positional edit modes (`replace_lines`, `raw_ops`) are refused if the doc shifted since the agent last saw it.
- Multiple edits in one `overleaf_edit_doc` call now apply **sequentially**, each to the result of the previous (they used to all resolve against the original text).
- v1.1 `mode`-based edits are still accepted but no longer advertised in the tool schema.

### Removed

- `OT_VERSION_DRIFT` is no longer emitted: version tracking makes the retry loop it reported on unnecessary. (The code remains in the type for compatibility.)

### Known limitations

- overleaf.com projects migrated to Overleaf's **history-OT** format (`otMigrationStage` > 0) cannot be read or edited yet; `joinDoc` is refused cleanly by the server. REST-backed tools still work.
- Comments are unavailable on stock Community Edition (the thread API ships only in Server Pro).

## [1.1.1]

- Bundle the CLI and vendor the patched `socket.io-client`, so `npx overleaf-mcp-rt` works without a postinstall patch step.
- Apply the `socket.io-client` patch correctly under hoisted `node_modules`.

## [1.1.0]

Agent-ergonomics release.

- **All tools renamed `overleaf_*`** so names stay unambiguous in MCP hosts that don't namespace by server.
- **`overleaf_edit_doc`** — anchor-based `replace`, `insert_before` / `insert_after`, `replace_lines`, `unified_diff`, and `raw_ops`; atomic; `dryRun`.
- **`overleaf_read_doc_range`**, **`overleaf_read_file as=base64`**, and edit summaries on write tools.
- **Structured error envelope** `{code, message, context, retryable, hint?}` (wire-format change: errors are JSON, not `code: message` text). New codes `OT_DELETE_MISMATCH`, `OT_VERSION_DRIFT`.
- **Removed `apply_patch`** — use `overleaf_edit_doc` with `mode: 'raw_ops'`.

## [1.0.0]

First stable release on npm, collapsing the internal v0.1 – v0.4 milestones.

- Live OT reads and writes through Overleaf's native operational-transform pipeline (ported from Overleaf-Workshop).
- Project tree CRUD over REST; compile, compile log and PDF download.
- `login`, `ls`, `diagnose` CLI commands; reverse-proxy auth pass-through via `OVERLEAF_EXTRA_HEADERS`.
- Per-doc write serialization, reconnect with jitter, subpath-safe URL handling.
- AGPL-3.0-or-later.
