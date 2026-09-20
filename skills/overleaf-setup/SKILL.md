---
name: overleaf-setup
description: Install, log in to, and troubleshoot the overleaf-mcp-rt MCP server. Use when Overleaf tools are missing or failing (OVERLEAF_AUTH_FAILED, INVALID_CONFIG, PROXY_AUTH_FAILED, "connection closed"), when the user wants to connect a new Overleaf instance or overleaf.com, or when a session cookie has expired.
---

# Setting up overleaf-mcp-rt

The server needs one thing per Overleaf instance ("host"): a logged-in session cookie. Only the user can log in — you prepare the command, they run it.

## Log in (or refresh an expired session)

Ask the user to run this. It opens a browser window with a throwaway profile; they sign in as usual (CAPTCHA, SSO and 2FA all work) and the session is captured automatically:

```bash
npx -y overleaf-mcp-rt login --url https://overleaf.example.com --browser
npx -y overleaf-mcp-rt login --url https://www.overleaf.com --name overleaf.com --browser   # hosted Overleaf
```

- No prompts are asked when `--url` and `--browser` are both given, so it also runs from a non-interactive shell (for instance a harness's "run this command for me" prefix).
- The first host becomes the default; add `--default` to change it.
- Headless machine? `login --url … --cookie '<value>'` with the `overleaf_session2` (overleaf.com), `overleaf.sid` or `sharelatex.sid` cookie copied from browser devtools. Self-hosted instances without CAPTCHA also accept `--email`.
- **Never ask the user to paste a password or cookie into the chat**, and never read `~/.config/overleaf-mcp-rt/credentials.json` yourself.

A running MCP server picks up a new or refreshed login on the next tool call — no restart needed.

## Check it works

```bash
npx -y overleaf-mcp-rt hosts                    # configured hosts (names and URLs only)
npx -y overleaf-mcp-rt diagnose [--host NAME]   # config → REST → projects → load balancer → OT handshake
```

`diagnose` names the failing layer. Then call `overleaf_list_hosts` and `overleaf_list_projects`.

## Register the server with an MCP client

If this skill came from the `overleaf-mcp-rt` plugin, the server is already registered. Otherwise add a stdio server to the client's MCP config:

```json
{ "mcpServers": { "overleaf": { "command": "npx", "args": ["-y", "overleaf-mcp-rt"] } } }
```

Most harnesses also have a one-liner, e.g. `claude mcp add overleaf -- npx -y overleaf-mcp-rt` or `codex mcp add overleaf -- npx -y overleaf-mcp-rt`. Behind an auth proxy (Cloudflare Access, basic auth), set `OVERLEAF_EXTRA_HEADERS` to a JSON object of headers, or pass `--header KEY=VALUE` to `login`.

## Reading errors

| Code | Meaning | Fix |
|---|---|---|
| `OVERLEAF_AUTH_FAILED` | Session expired or invalid | User re-runs `login … --browser` |
| `INVALID_CONFIG` | No such host / nothing configured | `hosts`, then `login` |
| `PROXY_AUTH_FAILED` | A reverse proxy blocked the request | `OVERLEAF_EXTRA_HEADERS` |
| `PROJECT_ACCESS_DENIED` | This account isn't a collaborator | User shares the project with it |
| `COMMENTS_UNSUPPORTED` | Stock Community Edition has no review panel | Not fixable on that host |
| joinDoc refused: "history-ot" | overleaf.com project on Overleaf's newer OT format | Doc reads/edits unsupported for that project; compile and file tools still work |
