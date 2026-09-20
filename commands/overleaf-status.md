---
name: overleaf-status
description: Check that the Overleaf MCP server is connected and logged in, and show the configured hosts
---

Report the state of the `overleaf-mcp-rt` connection, briefly.

1. Call `overleaf_list_hosts`. List each host with its URL and mark the default.
2. For each host, call `overleaf_list_projects` (pass `host`). Report the project count, or the error `code` and its `hint` if it fails.
3. If anything failed, say which single step fixes it, following the `overleaf-setup` skill (usually: the user re-runs `login … --browser` for that host). Offer `npx -y overleaf-mcp-rt diagnose --host <name>` for a layer-by-layer check.

Do not read the credentials file and do not print cookies.
