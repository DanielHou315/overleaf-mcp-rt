# overleaf-ot-mcp

A Model Context Protocol (MCP) server that connects AI coding agents (Claude Code, Claude Desktop, Codex, Cursor, …) to a self-hosted **Overleaf Community Edition** instance — without a git-bridge intermediary.

The eventual goal: an agent edits files in a project and changes appear in the Overleaf editor as live operational-transform updates from a designated collaborator account, not as "file changed externally" toasts.

## Source of truth

- **Spec:** `docs/superpowers/specs/2026-04-25-overleaf-mcp-design.md` — full design, auth model, MCP tool surface, phasing, risks.
- **v0.1 plan:** `docs/superpowers/plans/2026-04-25-overleaf-mcp-v0.1-read-only.md` — TDD-driven tasks for the read-only MVP.

When making decisions, defer to the spec; if the spec is silent, raise it for discussion before deviating.

## Status

- v0.1 (read-only via REST + project-zip cache) — superseded by v0.2
- v0.2 (OT-live reads + writes via ported Overleaf-Workshop Socket.IO client) — superseded by v0.3
- v0.3 (REST tree mutations: create_doc, create_folder, upload_file, rename, move, delete_entity) — superseded by v0.4
- v0.4 (polish: error mapping, per-doc write serialization, reconnect jitter, diagnose subcommand, pdfDownloadDomain, README auth examples) — shipped
- v1.0 (npm publish under AGPL-3.0 with Workshop attribution) — not yet started
- Implementation lives at the repo root (`src/`, `test/`, `scripts/`, `package.json`, …)

## Hard constraints

- **No fork of `sharelatex/sharelatex`.** Anything that requires modifying the Overleaf image is out of scope; we want clean upstream upgrades.
- **AGPL-3.0-or-later** for everything we ship. Required because we port code from [Overleaf-Workshop](https://github.com/iamhyc/Overleaf-Workshop) (AGPL-3.0).
- **Stock Overleaf CE 3.x – 5.x compatibility.** No Server Pro features.
- **Reverse-proxy auth pass-through** (Cloudflare Access, basic auth, etc.) via configurable HTTP headers, applied to both REST and Socket.IO handshake.

## Tech stack

Node.js ≥ 20, TypeScript 5, `@modelcontextprotocol/sdk`, `vitest` + `msw` for tests, `unzipper` for project-zip parsing, `node-html-parser` for CSRF/project-list scrape. Distribution via `npx`.

## Repo layout

```
src/                   The MCP server source (cli, config, errors, mcp/, overleaf/)
test/                  Unit + integration tests; HTML/zip fixtures
scripts/               Build-time helpers (e.g., make-fixture-zip.mjs)
docs/superpowers/      Specs and plans (source of truth)
overleaf/              Local clone of overleaf/overleaf for research; gitignored
```
