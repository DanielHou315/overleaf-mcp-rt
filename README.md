# overleaf-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) server for **Overleaf Community Edition** that lets AI coding agents (Claude Code, Claude Desktop, Codex via MCP, Cursor, …) read, navigate, and compile LaTeX projects in your self-hosted Overleaf instance — **without** git-bridge or Server Pro.

**v1.0 (current):** read + write + full tree CRUD via Overleaf's REST + native OT pipeline. Edits flow as live operations from a connected collaborator — no "file changed externally" toast.

Design docs (source of truth) live in the [GitHub repo](https://github.com/DanielHou315/overleaf-ot-mcp/tree/main/docs/superpowers).

## Install

Two ways to use it:

```bash
# A. Zero-install via npx (recommended for MCP clients)
npx overleaf-mcp@latest --help

# B. Global install for shell use
npm install -g overleaf-mcp
overleaf-mcp --help
```

Requires Node.js ≥ 20.

## Quick start

```bash
# 1. Get a session cookie (paste from devtools or use --email/--password)
npx overleaf-mcp login --url https://overleaf.example.com

# 2. Smoke test connectivity, auth, and OT handshake
npx overleaf-mcp diagnose

# 3. List projects
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

## Reverse-proxy auth (worked examples)

Many self-hosted Overleaf deployments are fronted by an authentication proxy. `OVERLEAF_EXTRA_HEADERS` is a JSON object whose keys/values are merged into every REST request **and** the Socket.IO upgrade — both layers see the same headers.

### Cloudflare Access (service token)

Generate a service token in the Zero Trust dashboard, then:

```jsonc
{
  "mcpServers": {
    "overleaf": {
      "command": "npx",
      "args": ["-y", "overleaf-mcp@latest"],
      "env": {
        "OVERLEAF_URL": "https://overleaf.corp.example",
        "OVERLEAF_SESSION_COOKIE": "overleaf.sid=s%3A...",
        "OVERLEAF_EXTRA_HEADERS": "{\"CF-Access-Client-Id\":\"abc.access\",\"CF-Access-Client-Secret\":\"...\"}"
      }
    }
  }
}
```

The pair `CF-Access-Client-Id` / `CF-Access-Client-Secret` is a CF service-token credential.

### HTTP Basic Auth in front of Overleaf

```jsonc
"env": {
  "OVERLEAF_URL": "https://overleaf.corp.example",
  "OVERLEAF_SESSION_COOKIE": "overleaf.sid=s%3A...",
  "OVERLEAF_EXTRA_HEADERS": "{\"Authorization\":\"Basic dXNlcjpwYXNzd29yZA==\"}"
}
```

The `Basic ...` value is `base64(user:password)`. Generate with `printf 'user:password' | base64` (don't include a trailing newline).

### Authelia / oauth2-proxy / forward-auth

These proxies typically inject `Remote-User` / `X-Forwarded-User` / `X-Forwarded-Email` after the user has already authenticated, but if you have a service-account flow that lets you skip the interactive auth, set those headers directly:

```jsonc
"env": {
  "OVERLEAF_URL": "https://overleaf.corp.example",
  "OVERLEAF_SESSION_COOKIE": "overleaf.sid=s%3A...",
  "OVERLEAF_EXTRA_HEADERS": "{\"Remote-User\":\"agent@local\",\"X-Forwarded-User\":\"agent@local\"}"
}
```

If your proxy expects a bearer token from a long-lived service account, send `Authorization: Bearer ...` instead. Run `overleaf-mcp diagnose` after configuring — a missing or wrong header surfaces as `OVERLEAF_AUTH_FAILED` on the REST step or `OT connectionRejected: invalid session` on the OT step.

### Tailscale / VPN (no extra headers)

If Overleaf is reachable only via a Tailscale node or a VPN, no headers are needed at the application layer — the network already authenticates. Just point `OVERLEAF_URL` at the internal hostname:

```jsonc
"env": {
  "OVERLEAF_URL": "http://overleaf.tail-scale.ts.net",
  "OVERLEAF_SESSION_COOKIE": "overleaf.sid=s%3A..."
}
```

### Sanity-check: `overleaf-mcp diagnose`

After wiring credentials, run from a shell:

```bash
overleaf-mcp diagnose
```

Output is a step-by-step report:

```
✓ config — URL https://overleaf.corp.example
✓ REST handshake — cookie valid, CSRF scraped
✓ reverse-proxy — CF detected, extraHeaders configured
✓ project listing — 3 project(s) accessible
✓ OT handshake — publicId P.abc...
```

A `✗` on any step prints the underlying error code (`OVERLEAF_AUTH_FAILED`, `PROXY_AUTH_FAILED`, `PROJECT_ACCESS_DENIED`) so you know which layer to fix.

## Tools (v1.0)

| Tool | Purpose |
|---|---|
| `list_projects` | List accessible projects |
| `get_project_tree(projectId)` | Folder + file tree (live, OT-backed) |
| `read_doc(projectId, path)` | Text doc content (live, OT-backed) |
| `read_file(projectId, path)` | Binary file (image / PDF / text / base64 by MIME) |
| `write_doc(projectId, path, content)` | Replace a text doc; flows as OT ops, no toast |
| `apply_patch(projectId, path, ops[])` | Advanced: emit raw `[{p,i?,d?}]` OT ops |
| `compile(projectId, draft?, stopOnFirstError?)` | Trigger compile, return URLs |
| `read_compile_log(projectId)` | Compile and return log text |
| `download_pdf(projectId)` | Compile and return PDF bytes (resource) |
| `create_doc(projectId, parentPath, name, content?)` | Create a doc; optional initial content |
| `create_folder(projectId, parentPath, name)` | Create a folder |
| `upload_file(projectId, parentPath, name, contentBase64, mimeType?)` | Upload a binary; mimeType inferred from extension when omitted; server may auto-promote text types to docs |
| `rename(projectId, path, newName)` | Rename a doc/file/folder |
| `move(projectId, path, newParentPath)` | Move a doc/file/folder |
| `delete_entity(projectId, path)` | Delete a doc/file/folder |

## License

AGPL-3.0-or-later.

## Acknowledgements

This project ports significant portions of the auth and (in v0.2) OT code from
[**Overleaf-Workshop**](https://github.com/iamhyc/Overleaf-Workshop) by iamhyc and contributors. Used under AGPL-3.0.
