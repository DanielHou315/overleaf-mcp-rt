---
name: overleaf-login
description: Log in to an Overleaf instance (or refresh an expired session) through a browser window
argument-hint: "[overleaf-url] [host-name]"
---

Help the user log in to Overleaf for the `overleaf-mcp-rt` MCP server. Follow the `overleaf-setup` skill.

Arguments: `$ARGUMENTS` — an optional Overleaf URL (default: ask; `https://www.overleaf.com` for hosted Overleaf) and an optional short host name.

1. Call `overleaf_list_hosts` to see what is already configured. If the URL is already a host, this is a session refresh: reuse its name.
2. Give the user this exact command to run themselves, filling in the URL and name. Logging in is theirs to do — never ask for a password or cookie in the chat:

   ```
   npx -y overleaf-mcp-rt login --url <URL> --name <NAME> --browser
   ```

   A browser window opens with a throwaway profile; they sign in as usual and the window closes by itself.
3. When they say it's done, call `overleaf_list_projects` for that host to confirm, and report how many projects are visible.
