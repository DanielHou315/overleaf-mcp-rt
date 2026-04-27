# Overleaf MCP

[![npm version](https://img.shields.io/npm/v/overleaf-mcp-rt.svg)](https://www.npmjs.com/package/overleaf-mcp-rt)
[![npm downloads](https://img.shields.io/npm/dm/overleaf-mcp-rt.svg)](https://www.npmjs.com/package/overleaf-mcp-rt)
[![license: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![Node ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org/)

> **A real-time [Model Context Protocol](https://modelcontextprotocol.io/) server for self-hosted Overleaf — no git-bridge, no Server Pro, no fork required.**

**Overleaf MCP** lets AI coding agents (Claude Code, Claude Desktop, Codex, Cursor, Continue, and any other MCP-compliant client) read, write, and compile LaTeX projects in any **personal or self-hosted Overleaf Community Edition** instance. Instead of relying on a git-bridge integration — a paid Server Pro feature that personal Overleaf installations don't have — it speaks Overleaf's **native operational-transform (OT) protocol over Socket.IO**, the same approach pioneered by [**Overleaf-Workshop**](https://github.com/iamhyc/Overleaf-Workshop). Edits flow live into the editor as collaborator operations, with no "file changed externally" toast and no extra infrastructure.

Distributed on npm as **[`overleaf-mcp-rt`](https://www.npmjs.com/package/overleaf-mcp-rt)** — the `rt` suffix marks this as the **r**eal-**t**ime / OT-backed flavor, distinct from git-bridge–style Overleaf MCP servers.

```bash
npx overleaf-mcp-rt@latest --help
```

## Table of contents

- [Why "real-time"? Native OT vs git-bridge](#why-real-time-native-ot-vs-git-bridge)
- [Install](#install)
- [Quick start](#quick-start)
- [MCP client config](#mcp-client-config)
- [Sanity-check: `diagnose`](#sanity-check-diagnose)
- [Tools](#tools)
  - [Discovery & read](#discovery--read)
  - [Edit](#edit)
  - [Project tree CRUD](#project-tree-crud)
  - [Compile](#compile)
  - [Error envelope](#error-envelope)
- [v1.1 release notes](#v11-release-notes)
- [v1.0 release notes](#v10-release-notes)
- [Roadmap](#roadmap)
- [FAQ](#faq)
- [Source of truth](#source-of-truth)
- [License](#license)
- [Acknowledgements](#acknowledgements)

## Why "real-time"? Native OT vs git-bridge

|  | **Overleaf MCP** (native OT) | git-bridge–style MCP servers |
|---|---|---|
| Works on personal / Community Edition Overleaf | ✅ | ❌ (Server Pro only) |
| Latency to editor | live (per patch) | minutes (git push + bridge sync) |
| Server requirements | stock Overleaf CE 3.x – 5.x | Overleaf Server Pro + git-bridge license |
| "File changed externally" toast | never — edits arrive as co-author OT ops | yes — every git sync triggers it |
| Auth model | session cookie | git over HTTPS / SSH |

If you run your own Overleaf Community Edition — in Docker, on a homelab, anywhere — and you want Claude Code or another AI agent to edit LaTeX in it with edits showing up live in the browser, this is the project for you.

## Install

```bash
# A. Zero-install via npx (recommended for MCP clients)
npx overleaf-mcp-rt@latest --help

# B. Global install for shell use
npm install -g overleaf-mcp-rt
overleaf-mcp-rt --help
```

Requires Node.js ≥ 20.

## Quick start

```bash
# 1. Get a session cookie (paste from devtools or use --email/--password)
npx overleaf-mcp-rt login --url https://overleaf.example.com

# 2. Smoke test connectivity, auth, and OT handshake
npx overleaf-mcp-rt diagnose

# 3. List your projects
npx overleaf-mcp-rt ls
```

## MCP client config

Works in Claude Code, Claude Desktop, Cursor, Codex (via MCP), Continue, and any MCP-compliant client.

```jsonc
{
  "mcpServers": {
    "overleaf": {
      "command": "npx",
      "args": ["-y", "overleaf-mcp-rt@latest"],
      "env": {
        "OVERLEAF_URL": "https://overleaf.example.com",
        "OVERLEAF_SESSION_COOKIE": "overleaf_session2=s%3A..."
      }
    }
  }
}
```

If your Overleaf is fronted by an authentication proxy (Cloudflare Access, Authelia, oauth2-proxy, HTTP Basic Auth, etc.), pass the proxy headers via the optional `OVERLEAF_EXTRA_HEADERS` env var as a JSON object — its keys/values are merged into every REST request and the Socket.IO upgrade. Run `diagnose` (next section) to verify both layers.

## Sanity-check: `diagnose`

After wiring credentials, run from a shell:

```bash
overleaf-mcp-rt diagnose
```

Output is a step-by-step report:

```
✓ config — URL https://overleaf.example.com
✓ REST handshake — cookie valid, CSRF scraped
✓ project listing — 3 project(s) accessible
✓ OT handshake — publicId P.abc...
```

A `✗` on any step prints the underlying error code (`OVERLEAF_AUTH_FAILED`, `PROXY_AUTH_FAILED`, `PROJECT_ACCESS_DENIED`) so you know which layer to fix.

## Tools

16 MCP tools, all prefixed `overleaf_*` so they remain unambiguous in hosts that don't auto-namespace by server name. Every tool's error responses use the [structured error envelope](#error-envelope).

### Discovery & read

| Tool | Purpose |
|---|---|
| `overleaf_list_projects` | List accessible projects. |
| `overleaf_get_project_tree(projectId)` | Folder + file tree (live, OT-backed). |
| `overleaf_read_doc(projectId, path)` | Full text doc content (live, OT-backed). |
| `overleaf_read_doc_range(projectId, path, startLine?, endLine?, startOffset?, length?)` | Substring of a doc by 1-indexed inclusive line range or by char offset/length. Returns `totalLines` / `totalChars`. Use this to verify a small region after an edit instead of re-fetching the whole doc. |
| `overleaf_read_file(projectId, path, as?)` | Binary file. Default `as=auto`: native MCP image content for image MIMEs, text content for text MIMEs, resource for PDFs, base64 envelope otherwise. Pass `as=base64` to force the `{contentBase64, mimeType}` envelope for any type — useful for programmatic copy via `overleaf_upload_file`. |

### Edit

| Tool | Purpose |
|---|---|
| **`overleaf_edit_doc(projectId, path, edits[], dryRun?)`** | **The recommended editing surface.** High-level text edits with six modes: `replace`, `insert_before`, `insert_after`, `replace_lines`, `unified_diff`, and `raw_ops`. All edits in a single call apply atomically (all or none). Pass `dryRun: true` to preview the resolved OT ops without applying. Returns a write summary. |
| `overleaf_write_doc(projectId, path, content)` | Replace a text doc; flows as OT ops, no toast. Returns a summary `{versionBefore, versionAfter, charsBefore, charsAfter, charsDelta, opsApplied}`. Use when you have the entire desired contents in hand. |

#### `overleaf_edit_doc` modes

| Mode | Use case |
|---|---|
| `replace` | Anchor-based find-and-replace. Default `occurrence: 'unique'` errors if the find-string appears 0 or >1 times; pass `'all'`, `'first'`, or an integer N to disambiguate. |
| `insert_before` / `insert_after` | Insert text immediately before / after a unique anchor. |
| `replace_lines` | Replace a 1-indexed inclusive line range with new text. |
| `unified_diff` | Apply a `diff -u`-style patch (the format LLMs emit fluently). Cannot be combined with anchor-based edits in the same call. |
| `raw_ops` | Caller-supplied OT ops `[{p, i?, d?}]`. Each op pre-validated against the local baseline; mismatched `d`-strings throw [`OT_DELETE_MISMATCH`](#error-envelope) before any server call. Cannot be combined with anchor-based edits. |

### Project tree CRUD

| Tool | Purpose |
|---|---|
| `overleaf_create_doc(projectId, parentPath, name, content?)` | Create a text doc; optional initial content is OT-written after creation. Use `parentPath: ""` for the project root. |
| `overleaf_create_folder(projectId, parentPath, name)` | Create a folder. |
| `overleaf_upload_file(projectId, parentPath, name, contentBase64, mimeType?)` | Upload a binary; mimeType inferred from extension when omitted. The server may auto-promote text MIME types to docs. |
| `overleaf_rename(projectId, path, newName)` | Rename a doc/file/folder. |
| `overleaf_move(projectId, path, newParentPath)` | Move a doc/file/folder. Use `newParentPath: ""` for the project root. |
| `overleaf_delete_entity(projectId, path)` | Delete a doc/file/folder. |

### Compile

| Tool | Purpose |
|---|---|
| `overleaf_compile(projectId, draft?, stopOnFirstError?)` | Trigger a LaTeX compile, return output URLs. |
| `overleaf_read_compile_log(projectId)` | Compile and return `output.log` text. |
| `overleaf_download_pdf(projectId)` | Compile and return the PDF as an MCP resource (`application/pdf`, base64 blob). |

### Error envelope

Every tool error serializes as JSON inside an MCP `text` content block (with `isError: true`):

```json
{
  "code": "OT_DELETE_MISMATCH",
  "message": "Delete op #0 at position 0 expected \"FOO\" but doc has \"BAR\"",
  "context": { "p": 0, "expected": "FOO", "actual": "BAR", "opIndex": 0 },
  "retryable": false,
  "hint": "The d-string did not match the doc at position p. Re-read the doc to get the current text, then recompute offsets."
}
```

| Code | Meaning |
|---|---|
| `OVERLEAF_GENERIC` | Validation or other non-typed errors (ambiguous anchor, out-of-bounds line range, mixed-mode `edit_doc`, etc.). |
| `OVERLEAF_AUTH_FAILED` | Session cookie invalid/expired. Re-run `overleaf-mcp-rt login`. |
| `PROXY_AUTH_FAILED` | A reverse proxy blocked the request — set `OVERLEAF_EXTRA_HEADERS`. |
| `PROJECT_ACCESS_DENIED` | The session can't reach the requested project. |
| `NOT_FOUND` | No such doc/file/folder at the given path. |
| `NETWORK_ERROR` | Transport-level failure (`retryable: true`). |
| `OT_DELETE_MISMATCH` | A `d`-string in `overleaf_edit_doc`'s `raw_ops` mode didn't match the doc at `p`. Pre-validated client-side, so you find out before the round-trip. |
| `OT_VERSION_DRIFT` | The doc moved under us during a write retry (`retryable: true`). |
| `INVALID_CONFIG` | Missing or malformed `OVERLEAF_URL` / cookie / extra headers. |

`retryable: true` is set for transient failures (`NETWORK_ERROR`, `OT_VERSION_DRIFT`); agents can use it to drive a retry loop. `hint` provides a one-line next step for the most common failures.

## v1.1 release notes

v1.1 adds the agent-ergonomics surface that the v1.0 raw OT-ops surface made painful to use, and renames every tool with an `overleaf_*` prefix:

- **All tools renamed `overleaf_*`** — `read_doc` → `overleaf_read_doc`, `compile` → `overleaf_compile`, etc. The prefix keeps tool names unambiguous in MCP hosts that don't auto-namespace by server (Cursor, Continue, custom stdio). Claude Code's `mcp__<server>__<tool>` namespacing still applies on top.
- **`overleaf_edit_doc` tool** — anchor-based `replace` (with `unique`/`first`/`all`/Nth occurrence semantics), `insert_before` / `insert_after`, line-range `replace_lines`, `unified_diff`, and `raw_ops` as an escape hatch. All edits in one call resolve against the same baseline and apply atomically; `dryRun: true` returns the resolved OT ops without emitting them. **This is the recommended editing surface** — `apply_patch` (the v1.0 raw-ops tool) was removed because `overleaf_edit_doc`'s `raw_ops` mode is a strict superset.
- **`overleaf_read_doc_range`** — fetch a substring of a doc by line range or offset/length, with `totalLines` / `totalChars` returned alongside. Saves an agent the round-trip cost of fetching a 50 KB doc just to verify a 200-byte edit.
- **`overleaf_read_file as=base64`** — opt into a `{contentBase64, mimeType}` envelope even for image MIMEs, so an agent can copy a binary asset between two project paths via `overleaf_upload_file` without losing access to the bytes.
- **Edit summaries** — `overleaf_write_doc` and `overleaf_edit_doc` both return `{versionBefore, versionAfter, charsBefore, charsAfter, charsDelta, opsApplied}`. Agents can sanity-check edits without re-reading the doc.
- **Structured error envelope** — tool errors serialize as `{code, message, context, retryable, hint?}` JSON instead of a flat string. New error codes: `OT_DELETE_MISMATCH` and `OT_VERSION_DRIFT`.
- **Wire-format change for errors:** error responses are now JSON inside `text` content; v1.0 emitted `${code}: ${message}` plain text. v1.0 clients that regex-parsed error strings will need to switch to JSON parsing.
- **Defensive validation** — `overleaf_edit_doc` pre-validates ops against the local baseline before emit, so a wrong offset surfaces immediately instead of via an opaque server reject (or, worse, silent no-op).
- **Removed: `apply_patch`** — replaced by `overleaf_edit_doc` with `mode: 'raw_ops'`. Migration: wrap your old `ops` array in `{edits: [{mode: 'raw_ops', ops: [...]}]}`.

## v1.0 release notes

This is the first stable release on npm. It bundles everything from the prior internal development phases (read-only, OT writes, tree mutations, polish) into a single shipping package:

- **Live OT reads & writes** — `read_doc`, `write_doc`, and a raw-OT `apply_patch` (later collapsed into `overleaf_edit_doc` in v1.1) flow through Overleaf's native operational-transform pipeline. Other connected browser sessions see edits as a co-author typing, not as a "file changed externally" toast.
- **Full tree CRUD over REST** — `create_doc`, `create_folder`, `upload_file`, `rename`, `move`, `delete_entity`.
- **Compile pipeline** — `compile`, `read_compile_log`, `download_pdf` (returned as a binary MCP resource).
- **`diagnose` CLI subcommand** — stepped report (config → REST → reverse-proxy → projects → OT) so failed setups surface the exact failing layer with a typed error code.
- **Reverse-proxy auth pass-through** — `OVERLEAF_EXTRA_HEADERS` is merged into both the REST client and the Socket.IO handshake.
- **Resilience** — per-doc write serialization (no baseline races), reconnect with jitter, OT-engine eviction signaling, WHATWG-URL normalization (subpath-safe), `pdfDownloadDomain` honored for overleaf.com REST flows.
- **Compatibility** — stock Overleaf CE 3.x – 5.x. **No fork** of `sharelatex/sharelatex` and no patched server image required, so you can keep upgrading Overleaf cleanly.
- **License** — AGPL-3.0-or-later (required because the OT/auth client is ported from Overleaf-Workshop).

Pre-1.0 development happened under internal v0.1–v0.4 milestones; those are now collapsed into v1.0 and per-phase notes are kept only in [`docs/superpowers/plans/`](docs/superpowers/) for historical context.

## Roadmap

### v1.x — full CLI parity + agent-facing skills

Today every tool listed above is reachable via MCP only; the bundled CLI just covers `login`, `ls`, and `diagnose`. Some agents (Codex CLI, Aider, terminal-only setups, anything that would rather shell out than pay tokens on an MCP envelope) are happier driving a normal command-line tool. Planned for v1.x:

- **CLI parity for every MCP tool** — one subcommand per tool, JSON output by default so agents can parse it, `--human` for tty-friendly tables. Sketch:
  - `overleaf-mcp-rt projects ls` / `tree <projectId>`
  - `overleaf-mcp-rt doc read <projectId> <path>` / `write <projectId> <path>` (stdin) / `edit <projectId> <path> <edits.json>` / `patch <projectId> <path> <ops.json>`
  - `overleaf-mcp-rt file read <projectId> <path>` / `upload <projectId> <parentPath> <name> <file>`
  - `overleaf-mcp-rt fs mkdir | mv | rm | rename`
  - `overleaf-mcp-rt compile <projectId> [--draft] [--stop-on-first-error]` / `log` / `pdf -o out.pdf`
- **Agent skills for the CLI** — a `skills/` directory shipped with the package, in [Claude Code skills](https://docs.claude.com/en/docs/claude-code/skills) format (also usable by other agents that ingest skill-style instructions). Each skill teaches the canonical Overleaf workflow on top of the CLI: edit-then-compile-then-read-log, upload-figure-and-cite, refactor-bibliography, recover-from-compile-error.
- **Same env, two surfaces** — `OVERLEAF_URL` / `OVERLEAF_SESSION_COOKIE` / `OVERLEAF_EXTRA_HEADERS` apply to both modes. The MCP server stays the default invocation for back-compat; the CLI is additive.

### Beyond v1.x

- Cursor rules and Continue tool definitions in a `recipes/` directory.
- `overleaf-mcp-rt watch` — mirror a local directory into a project as you edit it, for non-MCP workflows.
- Optional in-process snapshot history for project-level rollback.

Track or contribute via [GitHub issues](https://github.com/DanielHou315/overleaf-mcp-rt/issues).

## FAQ

**Does this require Overleaf Server Pro?**
No. It targets stock **Overleaf Community Edition** (3.x – 5.x). The whole point of this project is to give personal/self-hosted CE users the same agent-driven editing experience that Server Pro git-bridge users get.

**Does this require git-bridge?**
No. Edits are sent as live OT operations over Socket.IO — the same protocol Overleaf's web editor uses internally.

**Will edits show a "file changed externally" toast in the browser?**
No. The MCP server connects as a regular collaborator, so other browser sessions see edits as a co-author typing.

**Does it work with overleaf.com (the hosted SaaS)?**
REST-backed tools (`list_projects`, `compile`, `download_pdf`) work against overleaf.com when you supply a session cookie. OT-backed reads/writes are designed and tested against Community Edition; the SaaS may diverge in protocol details and is not a targeted platform.

**Does it work behind a reverse proxy?**
Yes. Pass any required headers (Cloudflare Access service token, Basic Auth, oauth2-proxy / Authelia forwarded-user, etc.) via `OVERLEAF_EXTRA_HEADERS` as a JSON object — they're merged into both REST and Socket.IO. Run `overleaf-mcp-rt diagnose` after configuring; a missing header surfaces as `OVERLEAF_AUTH_FAILED` on the REST step or `OT connectionRejected` on the OT step.

**How does this compare to [Overleaf-Workshop](https://github.com/iamhyc/Overleaf-Workshop)?**
Overleaf-Workshop is the VS Code extension that pioneered speaking Overleaf's native OT/Socket.IO protocol from outside the browser. This project ports significant portions of its auth and OT client into a Model Context Protocol server, so any MCP-compatible AI agent — not just a VS Code user — can edit Overleaf projects in real time. Both are AGPL-3.0.

**Why is the npm package `overleaf-mcp-rt` if the project is called "Overleaf MCP"?**
The `rt` suffix marks this as the **r**eal-**t**ime / OT-backed flavor, since other "overleaf-mcp"–style packages may use git-bridge or zip-snapshot approaches. The shorter "Overleaf MCP" is the human-readable project name.

## Source of truth

Design docs and per-phase plans live in [`docs/superpowers/`](docs/superpowers/). When in doubt, the design spec there is canonical.

## License

[**AGPL-3.0-or-later**](LICENSE). Required because this project ports significant portions of code from [Overleaf-Workshop](https://github.com/iamhyc/Overleaf-Workshop) (also AGPL-3.0).

## Acknowledgements

This project ports significant portions of the auth and OT code from [**Overleaf-Workshop**](https://github.com/iamhyc/Overleaf-Workshop) by iamhyc and contributors. Used under AGPL-3.0.

Built on the [Model Context Protocol](https://modelcontextprotocol.io/) by Anthropic.

---

**Keywords:** Overleaf · ShareLaTeX · MCP · Model Context Protocol · Claude Code · Claude Desktop · Codex · Cursor · Continue · LaTeX · self-hosted Overleaf · Overleaf Community Edition · operational transform · Socket.IO · git-bridge alternative · AI LaTeX agent · real-time collaborative editing
