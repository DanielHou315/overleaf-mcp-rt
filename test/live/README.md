# Live tests

The unit tests run the engine against a protocol-faithful fake. This directory checks the claims the fake can't: that the **built server** (`dist/cli.js`, spoken to over stdio exactly as an MCP client does) works against **real Overleaf servers** — every supported Community Edition major, and hosted instances such as overleaf.com.

`live.test.ts` is one suite with two ways to point it at a server.

## What it checks

| Scenario | What would break it |
|---|---|
| Starts, lists 22 tools, lists projects, reads the tree | login / cookie-name / CSRF / project-list scraping changes between versions |
| Create, rename, move, delete | REST route or tree-broadcast changes |
| String edits read back byte-for-byte by a fresh connection, with accents, CJK and symbols | OT position maths, the server's latin1-packed UTF-8, the whitespace-tolerant matcher |
| Emoji: stored as U+FFFD (Overleaf's rule), the agent is told, and a delete across them is accepted while a bystander stays connected | the server silently rewriting what we sent — this suite's first catch |
| **Agent edits while a second client types in the same doc — including the same line** | the bug this project exists to avoid: an op the server rejects disconnects *everyone* on the doc. Asserts no `otUpdateError`, no disconnect, all three views identical, nothing lost, and that the agent was shown `<external-changes>` |
| Two clients fire overlapping replacements at the same version, 40 rounds, and must end identical | predicting the server's transform of an in-flight op with the wrong algorithm — ShareJS and history-OT differ on some overlaps |
| `overleaf_write_doc` refuses to clobber unseen text, `overwrite: true` forces it | external-change tracking against real broadcasts |
| Binary upload and read-back | upload route / file-store differences |
| Compile, log, PDF | compile API and output-file URL changes |
| Comments: full lifecycle where a review panel exists, `COMMENTS_UNSUPPORTED` and an untouched doc where it doesn't | Server Pro / overleaf.com vs stock CE detection |

For the matrix, `run-matrix.sh` also greps the instance's own `real-time` and `document-updater` logs for OT errors and fails the version if there are any — the server's view, not just ours.

The "second client" is this project's OT engine on its own connection, not a browser. It proves the server accepted everything and both sides converged; it doesn't replace a look at a real browser tab when you change `src/overleaf/ot.ts` (see `CLAUDE.md` → Testing).

## 1. The version matrix (throw-away Community Edition instances)

```bash
test/live/run-matrix.sh                  # every version in versions.conf
test/live/run-matrix.sh 6.3.0 5.5.8      # just these
KEEP_IMAGES=1 test/live/run-matrix.sh    # keep pulled images for the next run
```

Run it **on the Docker host**, from a checkout (it mounts the checkout read-only). Needs Docker with Compose v2; nothing else — Node runs in a container. On a remote machine: `ssh <host> 'cd <checkout> && git pull && test/live/run-matrix.sh'`. Expect about five minutes per version, mostly image pull and Overleaf's first boot, and 2–3 GB of image per version while it runs.

**Both OT protocols.** Where the release has Overleaf's newer document format (`history-ot` column in `versions.conf`), every scenario runs twice: against a classic project, and against one switched to history-ot. CE has no route for that switch and a project can only change protocol while none of its docs is loaded, so the script runs a bootstrap phase that only creates the projects, sets `overleaf.history.otMigrationStage` in the instance's own Mongo, and then runs the suite. The co-editing scenario asserts which protocol the doc actually speaks, so a run can't pass on the wrong one.

For each version it starts Overleaf + Mongo + Redis (failing within seconds, with the instance's own output, if that version refuses the configuration), registers the first admin through the launchpad, logs in with a password, creates a project, runs the suite from a container on the same network, and removes everything.

**Isolation and clean-up — the rules, and where they're enforced**

- **No published ports.** The compose file has none (`test/unit/live-matrix.test.ts` and a pre-flight check in the script), and after start-up the script inspects the running containers and aborts if any port is published. The instance cannot be reached from outside the Docker host, so it can't be confused with, or interfere with, a production Overleaf on the same machine.
- **Internal network.** Overleaf, Mongo, Redis and the test runner share one Docker network created with `internal: true` — no route in or out — verified after start-up. Only the `prepare` step (`npm ci` + build) has egress, and it never joins that network.
- **Nothing persistent.** No bind mounts into the instance; all state is in anonymous volumes. Container names, networks and volumes are namespaced per run (`olmcp-live-<version>-<pid>`), never fixed names that could collide with a real deployment.
- **Always torn down.** An `EXIT` trap (success, failure, Ctrl-C, or a plain `kill` — long steps are run so that a signal is handled at once, not after the step's timeout) runs `docker compose down --volumes --remove-orphans`, then removes anything still carrying the run's project label, together with its anonymous volumes. The summary reports the host's dangling-volume count before and after, and fails the run if it grew.
- **Images:** every image the run had to pull is removed afterwards; images that were already on the host are never removed (and an image another container started using meanwhile is left alone). `KEEP_IMAGES=1` skips the removal.
- **No build cache.** Nothing is built — only stock images are run, and dependencies are installed into a volume that is deleted with the rest. The script compares the host's build-cache size before and after and says so. It never runs any `docker … prune`, which would touch things that aren't ours.
- The checkout is mounted **read-only**; the run writes nothing into it.

`versions.conf` lists the versions (newest patch of each supported major) with the Mongo/Redis each needs. Adding a release is one line. It is also the definition of "supported": 3.x was dropped from the project's claims when this matrix showed the real-time connection never completes against 3.5.13 (an older handshake).

## 2. A configured host (overleaf.com, or your own server)

```bash
npm run build
LIVE_HOST=overleaf.com LIVE_PROJECT="My scratch project" npm run test:live
```

`LIVE_HOST` is a name from `overleaf-mcp-rt hosts`; the session comes from your credentials file and is never printed. Here the suite is a guest: it never creates or deletes a project, works only inside a new folder `mcp-live-<stamp>` of the project named `LIVE_PROJECT` (required, no default — use a scratch project), paces its calls, and deletes the folder at the end. The compile step compiles the project as it is and only requires a PDF if the compile succeeds.

Without `LIVE_OVERLEAF_URL` or `LIVE_HOST` the suite skips itself, so `npm run test:live` is harmless by default. It is not part of `npm test` or CI: CI has no Overleaf to talk to.
