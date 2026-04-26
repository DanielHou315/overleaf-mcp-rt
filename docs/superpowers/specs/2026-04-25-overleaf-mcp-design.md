# Design: `overleaf-mcp` — an MCP server for Overleaf Community Edition without git

**Date:** 2026-04-25
**Status:** Draft, pending user review
**License of resulting work:** AGPL-3.0-or-later (inherited from ported Overleaf-Workshop code; consistent with Overleaf CE itself)

## Summary

A Model Context Protocol (MCP) server that exposes an Overleaf Community Edition project to AI coding agents (Claude Desktop, Claude Code, Codex via MCP, Cursor, etc.) **without** requiring a git intermediary. The server speaks Overleaf's native realtime operational-transform (OT) protocol so that agent edits flow through the editor as live collaborator operations rather than triggering "file changed externally" toasts.

The server runs as a stdio subprocess of the AI client, on the user's local machine. **No modifications to the Overleaf CE deployment are required.** It works against any stock CE instance (3.x → 5.x) and against `overleaf.com`.

## Goals

1. Read, write, and manage files in an Overleaf CE project from an MCP-speaking AI agent.
2. Trigger compiles and read compile logs / output PDFs.
3. Edits do not trigger "file changed externally" — they appear in the editor as live edits from a collaborator.
4. Run against stock Overleaf CE without any server-side modifications.
5. Support deployments fronted by reverse-proxy auth (Cloudflare Access, basic auth, Authelia, etc.) via configurable HTTP headers.
6. Easy install: a single `npx overleaf-mcp` line in the AI client's MCP config.

## Non-goals

- Modifying Overleaf CE's Docker image or any of its services.
- Building a web UI (terminal panel, browser extension, NGINX-injected iframe). Those plans are explicitly shelved.
- Sandboxing the AI agent. The agent runs in the AI client's own host process.
- Multi-tenant hosting of the MCP server. v1 is single-user, stdio-only.
- Server Pro features (SAML, LDAP, native git-bridge integration).
- Replacing the existing git-based Overleaf MCP servers — this complements them by serving deployments where git-bridge isn't available.

## Architecture

```
[ AI client: Claude Code / Claude Desktop / Codex / etc. ]
         │
         │  stdio MCP transport
         ▼
[ overleaf-mcp (Node.js, AGPL-3.0) ]
   ├── Configuration  (env vars / login subcommand / credentials file)
   ├── Auth          (cookie paste OR passport login)
   ├── HTTP client   (cookie + CSRF + user-supplied extra headers)
   ├── REST adapter  (project list, file read, tree mutations, compile)
   ├── OT adapter    (Socket.IO v0, ported from Overleaf-Workshop)
   │     ├── joinProject / joinDoc per touched file
   │     ├── applyOtUpdate emit                  (writes)
   │     ├── otUpdateApplied receive             (baseline upkeep)
   │     ├── recive{NewDoc,NewFile,NewFolder,EntityRename,EntityMove}, removeEntity
   │     └── clientTracking.updatePosition       (suppressed; no ghost cursor)
   ├── fs-to-ot translator  (text diff → ops)
   └── MCP tool dispatcher
         │
         │  HTTPS to Overleaf CE (through user's reverse proxy if any)
         ▼
[ Overleaf CE — unchanged ]
```

The server holds a single Overleaf session for its lifetime, scoped to a dedicated **service account** — typically a user named `ai-agent@local` — added as a collaborator on each project the user wants the agent to touch. This gives clean attribution (the user can see which edits came from the agent in track-changes / by cursor color) and granular access control (revoke the agent from a project to lock it out).

## Authentication

Stock Overleaf CE supports exactly one API auth mechanism: a session cookie (`overleaf_session2`, signed with `OVERLEAF_SESSION_SECRET`, backed by Redis). There is no PAT, no OAuth, no API key. Every external integration — Workshop, olcli, overleaf-sync, the git-bridges — works around this with cookie-based auth.

### Two supported flows

**Cookie paste (default).** User logs into the CE instance in a browser, opens devtools, copies the `overleaf_session2=...` value, and configures it via env var or `overleaf-mcp login --cookie`. On first use the server fetches `GET /project` and scrapes `<meta name="ol-csrfToken">` for write operations. Works against any deployment, including SSO flows behind a reverse-proxy auth gate.

**Passport login (interactive).** `overleaf-mcp login --url <url> --email <email>` performs `GET /login` (scrapes the `_csrf` form field) → `POST /login` with `{email, password, _csrf}`. The resulting `Set-Cookie` is persisted at `~/.config/overleaf-mcp/credentials.json`. Equivalent to `olcli auth` minus the devtools paste. Does not work against deployments fronted by an SSO IdP that intercepts `/login`.

### Auth pass-through headers

Configure `OVERLEAF_EXTRA_HEADERS` (a JSON object) or pass `--header KEY=VALUE` repeatedly. These headers are merged into:

1. Every REST `fetch(url, { headers })` request.
2. The Socket.IO handshake's `extraHeaders` option (Workshop's v0 client already supports this — same field).

Both surfaces matter: if extra headers are only attached to REST and not to the WebSocket handshake, OT silently fails behind CF Access with no useful error.

Common use cases:

| Setup | Required headers |
|---|---|
| Cloudflare Access service token | `CF-Access-Client-Id`, `CF-Access-Client-Secret` |
| HTTP basic auth in front of Overleaf | `Authorization: Basic <base64(user:pass)>` |
| Authelia / oauth2-proxy / forward-auth | varies (e.g., `Remote-User`, `X-Forwarded-User`) |
| Tailscale / VPN | none — handled at the network layer |

### Error taxonomy

The server distinguishes auth-failure types and surfaces them as MCP errors with stable codes:

| Code | Meaning | Heuristic |
|---|---|---|
| `OVERLEAF_AUTH_FAILED` | Session cookie expired / invalid | 302 to `/login` or 401 from Overleaf |
| `PROXY_AUTH_FAILED` | Upstream proxy rejected the request | 403 with `Cf-Ray` / `Cf-Mitigated` header, or response body matching `/cloudflare/i`, or HTML body before reaching JSON-emitting endpoint |
| `PROJECT_ACCESS_DENIED` | Service account is not a collaborator on the requested project | 403 from a project endpoint with valid session |
| `OT_VERSION_CONFLICT` | OT update rejected; resync attempted and failed twice | `applyOtUpdate` ack carries version error |

## MCP tool surface

### Read

| Tool | Purpose | Backed by |
|---|---|---|
| `list_projects()` | List projects accessible to the configured account | REST: `GET /project` (HTML scrape) |
| `get_project_tree(projectId)` | Folder + file tree | OT: `joinProjectResponse.project` |
| `read_doc(projectId, path)` | Text content of a doc | OT: `joinDoc` (lazy) |
| `read_file(projectId, path)` | Bytes of a binary file (returned base64) | REST: `GET /project/:id/file/:fileId` |
| `read_compile_log(projectId)` | Latest compile log + parsed errors | REST: output URL from last compile |
| `download_pdf(projectId)` | Bytes of latest `output.pdf` | REST |

### Write

| Tool | Purpose | Backed by |
|---|---|---|
| `write_doc(projectId, path, content)` | Replace a text doc; edits flow as OT ops, no toast | OT: diff → `applyOtUpdate` |
| `apply_patch(projectId, path, ops[])` | (Advanced) emit raw OT ops directly | OT |
| `create_doc(projectId, parentPath, name, content?)` | New text doc | REST: `POST /project/:id/doc` |
| `create_folder(projectId, parentPath, name)` | New folder | REST: `POST /project/:id/folder` |
| `upload_file(projectId, parentPath, name, contentB64)` | Upload binary | REST: `POST /project/:id/upload` |
| `rename(projectId, path, newName)` | Rename | REST |
| `move(projectId, path, newParent)` | Move | REST |
| `delete_entity(projectId, path)` | Delete | REST: `DELETE /project/:id/{doc,file,folder}/:id` |

### Action

| Tool | Purpose | Backed by |
|---|---|---|
| `compile(projectId, draft?, stopOnFirstError?)` | Trigger compile, return log + output file list | REST: `POST /project/:id/compile?auto_compile=true` |

### Deferred (v2+)

- `subscribe_changes(projectId)` as an MCP resource that streams remote OT events to the agent for "agent watches user typing" workflows.
- `compile_and_wait` with synctex sync.
- A `pdf_for_line(projectId, path, line)` tool using `/project/:id/sync/code`.

## File sync details (OT engine)

Ported from Overleaf-Workshop's `src/api/socketio.ts` and the relevant slice of `src/api/base.ts`. AGPL-3.0 with attribution.

### Connection lifecycle

1. On the first `read_doc` / `write_doc` for a project, open Socket.IO connection to `<origin>?projectId=<id>` with `extraHeaders: { Cookie, Origin, ...userExtraHeaders }`.
2. Wait for `joinProjectResponse` (the v2 server-driven handshake). Cache the project tree, the agent's `publicId`, and the `protocolVersion`.
3. For each touched doc, `joinDoc(docId, { encodeRanges: true })` lazily; cache `{text, version}` baseline. Decode lines with `Buffer.from(line, 'latin1').toString('utf-8')` (Overleaf packs UTF-8 through ASCII for the Socket.IO transport).
4. Subscribe to `otUpdateApplied`, `reciveNewDoc`, `reciveNewFile`, `reciveNewFolder`, `reciveEntityRename`, `reciveEntityMove`, `removeEntity`. (Note: the misspelled event names are canonical upstream — do not "fix" them.)
5. Persist the connection for the MCP server's lifetime. On `forceDisconnect` or network drop, reconnect with exponential backoff. On `reconnectGracefully`, follow the v1↔v2 handshake fallback Workshop already implements.

### Write path

1. `write_doc(projectId, path, newContent)` looks up cached baseline `{oldContent, version, docId}`.
2. If no baseline exists, `joinDoc` first.
3. Compute diff with `fast-diff`; convert to `[{p, i?, d?}]` ops where `p` is character offset in the flattened doc and `i` / `d` are insert / delete strings. A delete op must contain the exact bytes being removed (server validates).
4. Emit `applyOtUpdate { doc: docId, op, v: version }` with ack callback.
5. On `cb(null)` success, on receipt of our own `otUpdateApplied` (matched by `meta.source === publicId`), update baseline to `newContent` and `version + 1`.
6. On `cb(err)` with version mismatch: re-`joinDoc` to resync, retry once. On second failure, surface `OT_VERSION_CONFLICT`.

### Read path

`read_doc` returns the cached baseline if `joinDoc` was already done; otherwise `joinDoc` first. Latin1-packed UTF-8 lines decoded as above.

### Cursor presence

The server **never** emits `clientTracking.updatePosition`. The agent appears as a connected user (presence dot in the share panel) but with no visible cursor jumping around the editor.

### Tree mutations

Tree changes go through REST endpoints, not OT. Workshop does the same. Other clients receive `recive*` / `removeEntity` events and update their UI; no "file changed externally" toast is triggered for tree ops.

### Concurrent edits

If the user types while the agent is writing, OT merges correctly upstream — the agent's diff baseline lags but `otUpdateApplied` events on the agent's connection bring it forward. A version-mismatch ack triggers a resync. This is the same path the official Overleaf editor uses internally.

## Configuration reference

### Environment variables

```
OVERLEAF_URL=https://overleaf.example.com
OVERLEAF_SESSION_COOKIE="overleaf_session2=s%3A..."   # mutually exclusive with OVERLEAF_EMAIL
OVERLEAF_EMAIL=ai-agent@local                          # used by `overleaf-mcp login` only
OVERLEAF_PASSWORD_FILE=/run/secrets/overleaf-agent-pw  # used by `login` only
OVERLEAF_EXTRA_HEADERS={"CF-Access-Client-Id":"...","CF-Access-Client-Secret":"..."}
OVERLEAF_DEBUG=1                                       # verbose stderr logging
```

### Credentials file

`~/.config/overleaf-mcp/credentials.json`:

```json
{
  "url": "https://overleaf.example.com",
  "session_cookie": "overleaf_session2=s%3A...",
  "extra_headers": {
    "CF-Access-Client-Id": "abc.access",
    "CF-Access-Client-Secret": "..."
  }
}
```

Mode `0600`. Resolution order: env vars > credentials file > error.

### MCP config example

```jsonc
{
  "mcpServers": {
    "overleaf": {
      "command": "npx",
      "args": ["-y", "overleaf-mcp@latest"],
      "env": {
        "OVERLEAF_URL": "https://overleaf.example.com",
        "OVERLEAF_SESSION_COOKIE": "overleaf_session2=s%3A...",
        "OVERLEAF_EXTRA_HEADERS": "{\"CF-Access-Client-Id\":\"abc.access\",\"CF-Access-Client-Secret\":\"...\"}"
      }
    }
  }
}
```

### CLI subcommands

| Command | Purpose |
|---|---|
| `overleaf-mcp` | Default: run as MCP stdio server, picking up env vars / credentials file |
| `overleaf-mcp login` | Interactive: passport flow OR cookie paste; persists to credentials file |
| `overleaf-mcp ls` | Smoke-test: list accessible projects |
| `overleaf-mcp diagnose` | Connectivity check: TLS, CF Access headers, cookie validity, OT handshake |

## Module structure

```
overleaf-mcp/
├── package.json                (AGPL-3.0)
├── README.md                   (config examples for CF Access, basic auth, Tailscale)
├── src/
│   ├── cli.ts                  entry; dispatches subcommands
│   ├── config.ts               env + file-based config loading
│   ├── mcp/
│   │   ├── server.ts           MCP server bootstrap (stdio)
│   │   └── tools/              one file per tool group: docs, files, projects, compile
│   ├── overleaf/
│   │   ├── auth.ts             passport + cookie-paste flows
│   │   ├── http.ts             fetch wrapper with extra-header threading
│   │   ├── rest.ts             REST endpoints (port of Workshop's base.ts)
│   │   ├── ot.ts               OT engine (port of Workshop's socketio.ts)
│   │   ├── tree.ts             path ↔ docId mapping
│   │   └── diff.ts             fs-to-ot translator (fast-diff → {p,i,d}[])
│   └── errors.ts               OVERLEAF_AUTH_FAILED, PROXY_AUTH_FAILED, etc.
└── test/
    ├── unit/                   auth, diff, tree mapping
    └── integration/            against a docker-compose CE fixture
```

## Phased delivery

### v0.1 — Read-only MVP via project zip (~3 days)

- Auth (both flows + extra headers).
- Tools: `list_projects`, `get_project_tree`, `read_doc`, `read_file`, `read_compile_log`, `download_pdf`, `compile`.
- Read implementation strategy: Overleaf has no REST endpoint that returns a text doc's body directly — text docs live in MongoDB and are normally streamed via OT `joinDoc`. v0.1 satisfies reads by `GET /project/:id/download/zip`, unpacking into an in-memory cache, and serving `read_doc` / `read_file` / `get_project_tree` from there. Cache is invalidated and re-fetched on TTL or on user request. This is the same pattern olcli and overleaf-sync use; it scales fine for project-sized zips.
- No write tools yet.
- Acceptance: an AI agent can list projects, read files, trigger compile, fetch logs/PDF.

### v0.2 — OT writes and live reads (~2 weeks) — shipped

- Port `socketio.ts` from Overleaf-Workshop.
- Implement `write_doc` and `apply_patch` via OT.
- Replace v0.1's zip-cache reads with OT-backed reads (`joinProjectResponse` for tree, `joinDoc` for content) so that reads reflect live state without needing a re-zip.
- Tree event listeners maintain cache coherence (handle other clients renaming / creating / deleting docs out from under us).
- Acceptance: agent edits a file and the change appears in the editor live, no toast. Tested against CE 5.x.

### v0.3 — Tree mutations (~3 days) — shipped

- `create_doc`, `create_folder`, `upload_file`, `rename`, `move`, `delete_entity` — all REST.
- Acceptance: full CRUD on project structure.

### v0.4 — Polish (~3 days) — shipped

- `diagnose` subcommand.
- Improved error mapping (CF Access vs. Overleaf 401).
- Reconnect / backoff hardening.
- README config examples.

### v1.0 — release

Publish to npm under AGPL-3.0 with attribution to Overleaf-Workshop.

### Deferred

- HTTP / SSE transport for multi-user shared deployment.
- `subscribe_changes` MCP resource for live notifications.
- Python rewrite (Node port is the path of least resistance from Workshop's TypeScript).

## Risks and open questions

1. **OT protocol churn.** Overleaf could bump their realtime protocol. Mitigation: Workshop has tracked Overleaf 3 → 5 successfully across one v1↔v2 handshake bump; pin to known-good Overleaf versions in CI; carry the same fallback logic.
2. **socket.io fork dependency.** We pull `github:overleaf/socket.io-client#0.9.17-overleaf-5` directly. Mitigation: vendor the relevant transport bits if upstream goes dark. The fork was pushed as recently as 2025-05-16 on the server side, so this is stable for now.
3. **CSRF token expiry.** `<meta name="ol-csrfToken">` is per-session; we refresh on a 403 by re-fetching `/project`.
4. **Concurrent edit conflicts.** Handled by OT itself plus version-mismatch resync (Workshop's playbook).
5. **`list_projects` HTML scrape brittleness.** If `/project` HTML changes, listing breaks. Mitigation: also try the JSON dashboard endpoint where present; allow the user to specify a project ID directly so listing isn't a prerequisite.
6. **Service-account creation.** v1 leaves it as a manual setup step in the README. Could be automated via REST (`POST /admin/register` is admin-only and CE-specific) in a later revision.
7. **AGPL contagion.** AGPL is fine for self-hosted addon use but precludes use inside proprietary closed-source AI products.

## Out of scope

- Web terminal panel plans (Plan A REST-snapshot and Plan B OT-live web UIs from earlier brainstorming) are explicitly shelved. If revived, they would build on top of this MCP's `overleaf` adapter library.
- Multi-tenant hosting / shared MCP service.
- AI-agent API key handling — that's the AI client's concern.

## Attribution

Significant portions of `src/overleaf/rest.ts` and `src/overleaf/ot.ts` are ports of code from [Overleaf-Workshop](https://github.com/iamhyc/Overleaf-Workshop) by iamhyc and contributors, AGPL-3.0. Specifically `src/api/base.ts` and `src/api/socketio.ts`.
