# Configuration and login

Everything about connecting the server to an Overleaf instance: logging in, where credentials live, several hosts, reverse proxies, checking the connection, and notes specific to overleaf.com.

- [Logging in](#logging-in)
- [Credentials file and environment variables](#credentials-file-and-environment-variables)
- [Multiple hosts](#multiple-hosts)
- [Behind a reverse proxy](#behind-a-reverse-proxy)
- [Checking the connection: `diagnose`](#checking-the-connection-diagnose)
- [overleaf.com](#overleafcom)
- [Overleaf's newer document format (history-OT)](#overleafs-newer-document-format-history-ot)

## Logging in

Overleaf has no OAuth or device flow for third-party clients, so the server uses your session cookie. `login` gets one in three ways:

| Method | Command | When to use |
|---|---|---|
| Browser | `login --url <url> --browser` | The default. Works everywhere, including with CAPTCHA, SSO and 2FA. |
| Pasted cookie | `login --url <url> --cookie <cookie>` | Headless machines. |
| Email + password | `login --url <url> --email <email>` | Self-hosted instances with a plain password form. Not overleaf.com (CAPTCHA). |

**Browser login** launches your installed Chrome, Chromium, Edge or Brave with a throwaway profile — your everyday profile is never touched — and opens the instance's login page. Once you are signed in it reads the session cookie over the DevTools protocol, validates it, saves it, closes the window and deletes the profile. With `--url` and `--browser` both given there are no prompts, so it also works from non-interactive runners. `OVERLEAF_BROWSER=/path/to/browser` picks a specific binary.

**Pasting a cookie:** in your browser's devtools open Application → Cookies → your Overleaf site and copy the session cookie. `login` accepts the bare value or `name=value`, and works out whether the instance wants `overleaf_session2` (overleaf.com), `overleaf.sid` (CE ≥ 5) or `sharelatex.sid` (older CE). Whatever you paste is validated before it is saved.

When a session expires, tools fail with `OVERLEAF_AUTH_FAILED`. Run `login` again with the same host name to refresh it; the MCP server picks up the new cookie without a restart.

## Credentials file and environment variables

Credentials live in `~/.config/overleaf-mcp-rt/credentials.json` (mode 0600):

```json
{
  "default": "<name>",
  "hosts": {
    "<name>": { "url": "…", "session_cookie": "…", "extra_headers": {} }
  }
}
```

The single-host file written by earlier versions is still read, and the next `login` upgrades it in place.

| Variable | Purpose |
|---|---|
| `OVERLEAF_CREDENTIALS_FILE` | Use a different credentials file. |
| `OVERLEAF_URL`, `OVERLEAF_SESSION_COOKIE` | Define (or override) the host for that URL and make it the default — an alternative to `login`. |
| `OVERLEAF_EXTRA_HEADERS` | JSON object of headers for a reverse proxy (see below). |
| `OVERLEAF_BROWSER` | Browser binary for `login --browser`. |
| `OVERLEAF_HISTORY_OT_WRITES` | `1` enables editing documents on Overleaf's newer format (see below). |

## Multiple hosts

Run `login` once per instance. The first host becomes the default; `--default` switches it.

```bash
npx overleaf-mcp-rt login --url https://tex.example.org --browser
npx overleaf-mcp-rt login --url https://www.overleaf.com --name overleaf.com --browser
npx overleaf-mcp-rt hosts                          # names + URLs, never secrets
npx overleaf-mcp-rt diagnose --host overleaf.com
```

- A host's name defaults to its hostname without `www.`; `--name` overrides it.
- Every MCP tool takes an optional `host` argument, and `overleaf_list_hosts` tells the agent what exists. The host is chosen per call rather than with a "current host" switch, so parallel tool calls can't race each other onto the wrong instance.
- Project ids only mean something on the host they came from.
- Each host has its own session, OT connections and external-change tracking. Hosts are authenticated on first use, and the credentials file is re-read on every call, so you can add or refresh a host while the MCP server is running.

## Behind a reverse proxy

If your Overleaf sits behind an authentication proxy (Cloudflare Access, Authelia, oauth2-proxy, HTTP Basic Auth, …), give the server the headers the proxy expects. They are sent with every REST request and with the Socket.IO handshake.

```bash
npx overleaf-mcp-rt login --url https://tex.example.org --browser \
  --header CF-Access-Client-Id=… --header CF-Access-Client-Secret=…
```

or, in the MCP client config, `OVERLEAF_EXTRA_HEADERS` as a JSON object. A missing or wrong header shows up as `PROXY_AUTH_FAILED`.

## Checking the connection: `diagnose`

```bash
npx overleaf-mcp-rt diagnose [--host <name>]
```

```
✓ config — URL https://overleaf.example.com
✓ REST handshake — cookie valid, CSRF scraped
✓ project listing — 3 project(s) accessible
✓ OT handshake — publicId P.abc...
```

A `✗` prints the error code (`OVERLEAF_AUTH_FAILED`, `PROXY_AUTH_FAILED`, `PROJECT_ACCESS_DENIED`) so you know which layer to fix. If a failure looks like an authentication proxy (a redirect to a sign-in page that isn't Overleaf's, or a 401/403) and no extra headers are configured, the report says so.

## overleaf.com

- Log in with `--browser`; the password form is CAPTCHA-protected. If you paste a cookie instead and devtools shows two `overleaf_session2` cookies, use the one for the `.overleaf.com` domain.
- The server fetches overleaf.com's load-balancer stickiness cookie (`GCLB`) itself, so the Socket.IO handshake and the websocket reach the same backend.
- You are automating your own account on a shared production service: keep edit rates humane. This project is not affiliated with Overleaf.

## Overleaf's newer document format (history-OT)

Overleaf is migrating projects from the ShareJS text type to the operation format of its history system (`otMigrationStage` > 0, visible as `<meta name="ol-otMigrationStage">` on the editor page). The server detects the format per document.

- **Reading always works** — reads, `<external-changes>` and following collaborators live.
- **Editing is opt-in.** By default a write fails with `HISTORY_OT_WRITES_DISABLED` and nothing is sent. Start the MCP server with `OVERLEAF_HISTORY_OT_WRITES=1` to enable it, and try a scratch file first, ideally with nobody else in it.
- **Why opt-in:** the format is verified against Community Edition 6.0 and 6.3, including concurrent editing, but no migrated project on overleaf.com was available to verify against, and a write the server rejects disconnects everyone in that document.
- **Safety net:** the first write to each such document is compared with a fresh snapshot from the server. If they differ the tool reports `HISTORY_OT_MISMATCH` and refuses further writes for the session.
- `overleaf_add_comment` is not supported on these documents yet.

If you try it on overleaf.com, please [open an issue](https://github.com/DanielHou315/overleaf-mcp-rt/issues) with the result either way.
