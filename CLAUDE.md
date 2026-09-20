# overleaf-mcp-rt

Guidance for anyone — human or AI agent — working on this repository. `AGENTS.md` is a symlink to this file, so every agent harness reads the same instructions; edit `CLAUDE.md`.

A Model Context Protocol (MCP) server that connects AI coding agents to Overleaf — self-hosted **Community Edition / Server Pro** and **overleaf.com** — without a git-bridge intermediary. The repository is also an installable **agent plugin** (MCP wiring + skills + commands) for several harnesses.

Agent edits travel as live operational-transform (OT) ops from a logged-in account, so people with the project open see a co-author typing, not a "file changed externally" toast — and their own typing is never disturbed.

## Where things are written down

- **`README.md`** — user-facing docs: install, login, multiple hosts, every tool, error codes, FAQ, and a Developing section.
- **`CHANGELOG.md`** — what changed per version. Add to `## [Unreleased]` in the same PR as the change.
- **This file** — constraints, architecture and process for people and agents working on the code.
- `docs/superpowers/` is **gitignored**: local design notes and plans, not repository content. Don't reference it from tracked files.

## Hard constraints

- **No fork of `sharelatex/sharelatex`.** Anything that requires modifying the Overleaf image is out of scope; users must be able to upgrade Overleaf cleanly.
- **AGPL-3.0-or-later** for everything we ship, because the auth and OT client are ported from [Overleaf-Workshop](https://github.com/iamhyc/Overleaf-Workshop) (AGPL-3.0). `src/overleaf/text-ot.ts` is a port of Overleaf's ShareJS `text` type (MIT upstream); keep the attribution headers.
- **Stock Overleaf CE 4.x – 6.x**, with 6.x the primary target, plus overleaf.com. The supported range is what the live matrix (`test/live/versions.conf`) passes on; 3.x was dropped when the matrix showed it never worked (older real-time handshake). Features that only exist in Server Pro / overleaf.com (comments) must detect their absence and fail cleanly on CE before changing anything.
- **Reverse-proxy auth pass-through** (Cloudflare Access, basic auth, …) via configurable HTTP headers, applied to both REST and the Socket.IO handshake.
- **Never disturb a human's editing session.** Overleaf's real-time service answers a rejected op by disconnecting *every* client on that doc. Any change to the OT path needs a test in `test/unit/ot.live-sync.test.ts` and, ideally, a live run with a browser open (see Testing).
- **Credentials are the user's.** Never log, print or read back session cookies; login flows are run by the user.
- **Model- and vendor-neutral.** Skills, tool descriptions, docs and examples must work for any agent: no model names, and harness names only where an instruction is genuinely harness-specific (install commands, manifest paths). `test/unit/skills.test.ts` checks the skills.

## Architecture

The repo root is both the npm package and the plugin root.

```
.claude-plugin/  .cursor-plugin/   plugin + marketplace manifests, one pair per harness
.codex-plugin/                     Codex manifest + its MCP config (Codex reads .claude-plugin/marketplace.json as the catalog)
mcp.json                           MCP config for Cursor (Claude Code's is inline in its plugin.json)
skills/  commands/                 shared plugin components; skills also ship in the npm package
scripts/mcp-launch.mjs             plugin entry point: local dist/ if built, else the matching npm release
src/cli.ts                  CLI: MCP stdio server (default), login, hosts, ls, diagnose, skills
src/config.ts               Credentials file v2 (named hosts) + env vars
src/version.ts              VERSION, injected from package.json at build time
src/skills.ts               Lists / installs the bundled skills
src/mcp/server.ts           HostRegistry (one lazily-built context per host), MCP server + instructions
src/mcp/changes.ts          Renders the <external-changes> block
src/mcp/tools/              Tool schemas + dispatcher (index.ts) and handlers
  edit.ts, match.ts           old_string/new_string edits; matching cascade
  docs.ts, range.ts           reads, guarded whole-doc writes
  comments.ts                 review-panel comments + enforced signature
  tree.ts, compile.ts         REST-backed tools
src/overleaf/ot.ts          OtEngine: live snapshot per doc, in-flight transform, confirmation,
                            external-change tracking, comment anchors, reconnect
src/overleaf/text-ot.ts     Port of the server's ShareJS text type (apply + transform)
src/overleaf/history-ot.ts  Overleaf's newer doc type: wire codec + port of editor-core's TextOperation transform
src/overleaf/socket.ts      Socket.IO 0.9 client wrapper (Overleaf's fork, patched for extraHeaders)
src/overleaf/rest.ts, http.ts, auth.ts   REST client, cookie validation, LB stickiness cookie
src/overleaf/browser-login.ts            login --browser via the DevTools protocol
test/unit/                  vitest; fake-overleaf.ts is a protocol-faithful fake server
test/live/                  the built server against real Overleaf: throw-away CE version matrix, or a configured host
scripts/                    build.mjs, live-test helpers, changelog-section.mjs
```

Do **not** add a `.mcp.json` at the root: the plugin host loads it both as this project's config and as the plugin's, and the plugin-root variable only exists in the second case (details in README → Developing).

Protocol facts worth knowing before touching `ot.ts` (all verified against the Overleaf 6.0.0 source):

- The `applyOtUpdate` ack means "queued", not "applied". Confirmation is a later `otUpdateApplied {doc, v}` with no `op`; rejection is `otUpdateError`.
- Remote ops arrive as `otUpdateApplied` with `op`; `v` is the version the op was applied *at*.
- The server transforms a stale-version op with `transform(op, other, 'left')`; `text-ot.ts` must stay byte-compatible with that.
- `joinDoc` RPCs must not overlap on one socket, and updates can arrive before the join response.
- A doc is either `sharejs-text-ot` or `history-ot` (projects with `otMigrationStage` > 0); the engine learns which from the joinDoc snapshot and must send `supportsHistoryOT: true` to get one at all. It keeps text and ops in ShareJS components for both and converts at the socket (`history-ot.ts`).
- The two types use **different transform algorithms that disagree on some overlaps** (our insert inside a range someone replaced). The in-flight op must be predicted with the algorithm of the doc's type: `text-ot.ts` for ShareJS, `TextOperation.transform` for history-ot. `history-ot.test.ts` pins the counter-example.
- For history-ot docs document-updater (6.0 – 6.3) does **not** restamp a transformed update: broadcasts and acks carry the version the sender *submitted* at, not the one it was applied at. The engine therefore sequences history-ot updates by arrival order (`inSequence` in `ot.ts`), relies on the text operation's length check to turn a missed update into a rejoin, and re-joins when an update crossing a join can't be placed.
- Randomized tests must use `test/unit/prng.ts` and assert that the scenario they generate contains what they claim (stale ops, races): a one-line LCG overflows double precision in JavaScript and once left the core interleaving test almost empty.
- The authoritative reference is the running server's own source: `docker exec <container> ls /overleaf/services/{real-time,document-updater,web}`.

## Tech stack

Node.js ≥ 20, TypeScript 5, `@modelcontextprotocol/sdk`, `vitest` + `msw`, `socket.io-client` (Overleaf's 0.9 fork, vendored into `dist/` at build), `ws` (DevTools connection), `diff` / `fast-diff`, `node-html-parser`. Everything is bundled by esbuild into `dist/cli.js`, so runtime dependencies are `devDependencies`. Distribution via `npx` and as a plugin.

## Testing

```bash
npm run typecheck && npm test && npm run build
```

- Tool tests run the **real engine** against `FakeOverleaf`, which transforms, confirms and rejects like the real server and can play a second collaborator. Prefer that to hand-rolled mocks.
- `mcp-live-collab.test.ts` and `multi-host.test.ts` drive the real dispatcher through an in-memory MCP client: they assert what an agent actually sees.
- `skills.test.ts` enforces the plugin packaging invariants (manifests, catalogs and `package.json` agree; skills only mention tools that exist).
- The real-browser login test launches a headless browser locally and is skipped on CI.
- Live checks against a real instance: `npm run build`, then `node scripts/agent-session.mjs` (a long-lived MCP client you drive with `curl`) while editing in a browser; `scripts/latency-probe.mjs` times agent edits; `scripts/smoke-stdio.mjs` checks the bundle starts. Use a scratch file, keep edit rates humane on overleaf.com, and clean up.
- Plugin changes: validate and install from the checkout as described in README → Developing.
- **Live suite** (`test/live/`, not part of `npm test` or CI): `test/live/run-matrix.sh [versions…]` on a Docker host starts a throw-away CE per version in `versions.conf`, runs `live.test.ts` against it from inside its network, greps the server's own logs for OT errors, and removes everything. On releases that have it (`history-ot` column of `versions.conf`) the suite runs twice — once against a project the script switches to history-ot in the instance's Mongo between a bootstrap phase and the main run. `LIVE_HOST=<name> npm run test:live` points the same suite at a configured host such as overleaf.com (scratch folder in a scratch project, paced, cleaned up). Run the matrix for changes to `src/overleaf/` and before a release; add new Overleaf releases to `versions.conf`.
- The matrix may share a machine with a production Overleaf. Its isolation rules are not negotiable and `test/unit/live-matrix.test.ts` enforces them: **no published ports, an `internal` network, no fixed container names, nothing built, no `docker … prune`, remove only what the run created** (including only the images it pulled).

## Workflow conventions

- One theme per PR, each in its own branch (and, if you use them, a git worktree). PRs are squash-merged.
- A stacked PR must be retargeted to `main` (and rebased) as soon as the PR beneath it merges — merging it while it still points at a feature branch lands it on that branch, not on `main`.
- Conventional-commit style subjects (`fix(ot): …`, `feat: …`, `docs: …`).
- Behaviour changes to tools, the CLI or the credentials file need a `CHANGELOG.md` entry and README update in the same PR. Skills under `skills/` describe tool usage to agents: update them when tool behaviour changes.

## Releasing

`package.json` is the single source of the version: the build injects it into the CLI and MCP handshake, and the five plugin manifests (`plugin.json` and `marketplace.json` in `.claude-plugin/` and `.cursor-plugin/`, plus `.codex-plugin/plugin.json`) must match it — a test enforces that.

1. Release PR: `node scripts/release-prep.mjs <x.y.z>` sets `package.json`, the lockfile and the five plugin manifests, and turns the changelog's `## [Unreleased]` into `## [x.y.z] — <date>` (leaving a fresh empty `## [Unreleased]` above it). Review the section; for a major version, lead with a *Breaking changes — migrating* list.
2. After it merges: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The `Release` workflow (triggered only by that tag push) checks the tag against `package.json`, runs typecheck/tests/build, publishes to npm, and creates the GitHub release from the changelog section.

Publishing uses npm **trusted publishing** (OIDC) — there is no npm token or secret. npmjs.com → package Settings → Trusted Publisher is configured with repository `DanielHou315/overleaf-mcp-rt`, workflow `release.yml`, environment `npm`, and direct `npm publish` allowed. Those values are matched exactly against the running job, so **renaming `release.yml` or the job's `environment: npm` breaks publishing** until the trusted publisher is recreated to match. The `npm` GitHub environment (repo Settings → Environments) is where release protection lives: restrict it to `v*` tags, and add a required reviewer for a manual approval step. It needs Node ≥ 22.14 / npm ≥ 11.5.1, which is why the release job runs a newer Node than the package's minimum. Provenance is attached automatically.

Versioning is semver over the public surface: MCP tool names/arguments/results/error codes, the CLI, and the credentials file format.
