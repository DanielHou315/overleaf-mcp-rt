# overleaf-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) server for **Overleaf Community Edition** that lets AI coding agents (Claude Code, Claude Desktop, Codex via MCP, Cursor, …) read, navigate, and compile LaTeX projects in your self-hosted Overleaf instance — **without** git-bridge or Server Pro.

**v0.2 (current):** read + write via Overleaf's native realtime OT pipeline. The agent's edits appear in the editor as live operations from a connected collaborator — no "file changed externally" toast.

Design docs (source of truth) live in `docs/superpowers/`:
- Spec: `docs/superpowers/specs/2026-04-25-overleaf-mcp-design.md`
- v0.1 plan: `docs/superpowers/plans/2026-04-25-overleaf-mcp-v0.1-read-only.md`

## Install

```bash
npx overleaf-mcp@latest --help
```

## Quick start

```bash
# 1. Get a session cookie (paste from devtools or use --email/--password)
npx overleaf-mcp login --url https://overleaf.example.com

# 2. Smoke test
npx overleaf-mcp ls
```

## MCP client config

```jsonc
{
  "mcpServers": {
    "overleaf": {
      "command": "npx",
      "args": ["-y", "overleaf-mcp@latest"],
      "env": {
        "OVERLEAF_URL": "https://overleaf.example.com",
        "OVERLEAF_SESSION_COOKIE": "overleaf_session2=s%3A..."
      }
    }
  }
}
```

## Reverse-proxy auth (Cloudflare Access, basic auth, …)

```jsonc
"env": {
  "OVERLEAF_URL": "https://overleaf.example.com",
  "OVERLEAF_SESSION_COOKIE": "overleaf_session2=s%3A...",
  "OVERLEAF_EXTRA_HEADERS": "{\"CF-Access-Client-Id\":\"abc.access\",\"CF-Access-Client-Secret\":\"...\"}"
}
```

The headers in `OVERLEAF_EXTRA_HEADERS` are merged into both REST requests **and** the WebSocket handshake (when OT mode lands in v0.2).

## Tools (v0.2)

| Tool | Purpose |
|---|---|
| `list_projects` | List accessible projects |
| `get_project_tree(projectId)` | Folder + file tree (live, OT-backed) |
| `read_doc(projectId, path)` | Text doc content (live, OT-backed) |
| `read_file(projectId, path)` | Binary file (base64; REST by fileId) |
| `write_doc(projectId, path, content)` | Replace a text doc; flows as OT ops, no toast |
| `apply_patch(projectId, path, ops[])` | Advanced: emit raw `[{p,i?,d?}]` OT ops |
| `compile(projectId, draft?, stopOnFirstError?)` | Trigger compile, return URLs |
| `read_compile_log(projectId)` | Compile and return log text |
| `download_pdf(projectId)` | Compile and return PDF bytes (base64) |

## License

AGPL-3.0-or-later.

## Acknowledgements

This project ports significant portions of the auth and (in v0.2) OT code from
[**Overleaf-Workshop**](https://github.com/iamhyc/Overleaf-Workshop) by iamhyc and contributors. Used under AGPL-3.0.
