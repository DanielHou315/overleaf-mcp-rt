# Developing

[`AGENTS.md`](../AGENTS.md) holds the constraints, architecture, protocol notes and release process. This page is the practical part: building, testing, and trying the plugin from a checkout.

## Build and test

```bash
npm ci && npm run typecheck && npm test && npm run build
```

Live tests against real Overleaf servers are separate from `npm test` and described in [`test/live/README.md`](../test/live/README.md):

- `test/live/run-matrix.sh` runs the built server against a throw-away Community Edition of every supported major (4.x – 6.x) on a Docker host — no published ports, an internal network, everything removed afterwards.
- `LIVE_HOST=overleaf.com npm run test:live` runs the same suite against a host you are logged in to.

## Repository layout = plugin layout

The repo root is both the npm package and the plugin root, shared by every harness:

```
.claude-plugin/   plugin.json (declares the MCP server) + marketplace.json           → Claude Code
.cursor-plugin/   plugin.json + marketplace.json; mcp.json at the root               → Cursor
.codex-plugin/    plugin.json + mcp.json (catalog: .claude-plugin/marketplace.json)  → Codex
skills/  commands/                                                                   → shared components
scripts/mcp-launch.mjs   starts the server for the plugin: local dist/ if built,
                         else the npm release matching the plugin version
src/  test/  dist/       the MCP server itself (npm package `overleaf-mcp-rt`)
```

There is deliberately **no `.mcp.json` at the root**: Claude Code would load it both as this project's config and as the plugin's, and `${CLAUDE_PLUGIN_ROOT}` only exists in the second case. The server is declared inline in `.claude-plugin/plugin.json` instead. Codex does not expand that variable at all, which is why it has its own manifest: `.codex-plugin/mcp.json` starts the launcher by a relative path with `cwd` at the plugin root.

The three `plugin.json` files, both `marketplace.json` files and `package.json` must agree on name, version and description — `test/unit/skills.test.ts` enforces it.

## Testing the plugin from a checkout

This uses your local build; nothing needs publishing.

**Claude Code**

```bash
npm run build
claude plugin validate .
```
```
/plugin marketplace add /absolute/path/to/overleaf-mcp-rt
/plugin install overleaf-mcp-rt@overleaf-mcp-rt
```

`claude mcp list` should show `plugin:overleaf-mcp-rt:overleaf … ✔ Connected`. For a local install the plugin root is the checkout itself, so `npm run build` is picked up on the next session without reinstalling.

**Codex**, against a throwaway config so your real one is untouched:

```bash
export CODEX_HOME=$(mktemp -d)
codex plugin marketplace add /absolute/path/to/overleaf-mcp-rt
codex plugin add overleaf-mcp-rt@overleaf-mcp-rt
codex mcp list        # overleaf → node ./scripts/mcp-launch.mjs, cwd = the installed plugin root
```
