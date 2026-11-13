# overleaf-mcp-rt

Guidance for anyone — human or AI agent — working on this repository.

An MCP server that connects AI coding agents to Overleaf (self-hosted Community Edition / Server Pro, and overleaf.com) without git-bridge. The repository is also an installable agent plugin: MCP wiring, skills and commands for several harnesses.

Agent edits travel as live operational-transform (OT) ops from a logged-in account, so people with the project open see a co-author typing and their own typing is never disturbed.

## Where things are written down

| File | Contents |
|---|---|
| `README.md` | What a new user needs: install, quick start, the tool list, supported servers. Keep it short. |
| `docs/configuration.md` | Login methods, credentials file, env vars, multiple hosts, proxies, `diagnose`, overleaf.com, history-OT. |
| `docs/tools.md` | Tool behaviour in detail, `<external-changes>`, the comment signature, error codes. |
| `docs/development.md` | Build, plugin layout, testing the plugin from a checkout. |
| `test/live/README.md` | The live suite and the CE version matrix. |
| `CHANGELOG.md` | What changed per version. |
| This file | Constraints, architecture and process. |

`docs/superpowers/` is gitignored (local design notes). Don't reference it from tracked files.

## Hard constraints

- **No fork of `sharelatex/sharelatex`.** Anything that needs a modified Overleaf image is out of scope.
- **AGPL-3.0-or-later**, because the auth and OT client are ported from [Overleaf-Workshop](https://github.com/iamhyc/Overleaf-Workshop). `src/overleaf/text-ot.ts` is a port of Overleaf's ShareJS `text` type (MIT upstream). Keep the attribution headers.
- **Stock Overleaf CE 4.x – 6.x** (6.x is the primary target) plus overleaf.com. The supported range is what the live matrix (`test/live/versions.conf`) passes on. Features that only exist in Server Pro / overleaf.com (comments) must detect their absence and fail cleanly on CE before changing anything.
- **Reverse-proxy auth pass-through** via configurable HTTP headers, applied to both REST and the Socket.IO handshake.
- **Never disturb a human's editing session.** Overleaf answers a rejected op by disconnecting *every* client on that doc. Any change to the OT path needs a test in `test/unit/ot.live-sync.test.ts` and, ideally, a live run with a browser open.
- **Credentials are the user's.** Never log, print or read back session cookies. Login flows are run by the user.
- **Model- and vendor-neutral.** Skills, tool descriptions, docs and examples must work for any agent: no model names, and harness names only where an instruction is genuinely harness-specific (install commands, manifest paths). `test/unit/skills.test.ts` checks the skills.

## Architecture

The repo root is both the npm package and the plugin root. Everything is bundled by esbuild into `dist/cli.js`, so runtime dependencies are `devDependencies`. Node.js ≥ 20, TypeScript, vitest.

```
.claude-plugin/  .cursor-plugin/   plugin + marketplace manifests, one pair per harness
.codex-plugin/                     Codex manifest + its MCP config (Codex reads .claude-plugin/marketplace.json as the catalog)
mcp.json                           MCP config for Cursor (Claude Code's is inline in its plugin.json)
skills/  commands/                 shared plugin components; skills also ship in the npm package
docs/                              user and contributor docs beyond the README
patches/                           patch-package patch for the vendored socket.io-client
scripts/                           build.mjs, mcp-launch.mjs (plugin entry point: local dist/ if built,
                                   else the matching npm release), release-prep.mjs, live-test helpers
src/cli.ts                  CLI: MCP stdio server (default), login, hosts, ls, diagnose, skills
src/config.ts               Credentials file v2 (named hosts) + env vars
src/errors.ts               Error codes, envelope and hints
src/skills.ts               Lists / installs the bundled skills
src/mcp/server.ts           HostRegistry (one lazily-built context per host), MCP server + instructions
src/mcp/changes.ts          Renders the <external-changes> block
src/mcp/tools/              Tool schemas + dispatcher (index.ts) and handlers; latex-log.ts reads
                            errors / warnings out of output.log for the compile result
src/overleaf/ot.ts          OtEngine: live snapshot per doc, in-flight transform, confirmation,
                            external-change tracking, comment anchors, reconnect
src/overleaf/text-ot.ts     Port of the server's ShareJS text type (apply + transform)
src/overleaf/history-ot.ts  Overleaf's newer doc type: wire codec + port of editor-core's TextOperation transform
src/overleaf/socket.ts      Socket.IO 0.9 client wrapper (Overleaf's fork, patched for extraHeaders)
src/overleaf/rest.ts, http.ts, auth.ts, browser-login.ts   REST client, cookies, login
test/unit/                  vitest; fake-overleaf.ts is a protocol-faithful fake server
test/live/                  the built server against real Overleaf (CE version matrix, or a configured host)
```

Do **not** add a `.mcp.json` at the root: the plugin host would load it both as this project's config and as the plugin's (see `docs/development.md`).

## Protocol facts

Read these before touching `src/overleaf/ot.ts` or the compile request. All were verified against the Overleaf 6.0.0 source; the authoritative reference is the running server's own code (`docker exec <container> ls /overleaf/services/{real-time,document-updater,web}`).

- The `applyOtUpdate` ack means "queued", not "applied". Confirmation is a later `otUpdateApplied {doc, v}` with no `op`; rejection is `otUpdateError`.
- Remote ops arrive as `otUpdateApplied` with `op`; `v` is the version the op was applied *at*.
- The server transforms a stale-version op with `transform(op, other, 'left')`; `text-ot.ts` must stay byte-compatible with that.
- `joinDoc` RPCs must not overlap on one socket, and updates can arrive before the join response.
- A doc is either `sharejs-text-ot` or `history-ot` (projects with `otMigrationStage` > 0). The engine learns which from the joinDoc snapshot and must send `supportsHistoryOT: true` to get one at all. It keeps text and ops in ShareJS components for both and converts at the socket (`history-ot.ts`).
- The two types use **different transform algorithms that disagree on some overlaps** (our insert inside a range someone replaced). Predict the in-flight op with the algorithm of the doc's type: `text-ot.ts` for ShareJS, `TextOperation.transform` for history-ot. `history-ot.test.ts` pins the counter-example.
- For history-ot docs, document-updater (6.0 – 6.3) does **not** restamp a transformed update: broadcasts and acks carry the version the sender *submitted* at. The engine therefore sequences history-ot updates by arrival order (`inSequence` in `ot.ts`), relies on the text operation's length check to turn a missed update into a rejoin, and re-joins when an update crossing a join can't be placed.
- history-ot **writes are opt-in** (`OVERLEAF_HISTORY_OT_WRITES=1`), because the format is unverified on overleaf.com. The first write per doc is verified against a fresh snapshot (`HISTORY_OT_MISMATCH` stops further writes). Flip the default only after a verified run on a migrated overleaf.com project.
- The compile request must name the root document the way the editor does (`rootDoc_id` + `rootResourcePath`, both from the live project state), or neither. Current web compiles a `rootResourcePath` exactly as given — a hardcoded `main.tex` once broke every project built from another file — while older releases read only `rootDoc_id`. TeX runs in the root document's folder (`latexmk -cd`), so file names in `output.log` are relative to it.

## Testing

```bash
npm run typecheck && npm test && npm run build
```

- Tool tests run the **real engine** against `FakeOverleaf`, which transforms, confirms and rejects like the real server and can play a second collaborator. Prefer that to hand-rolled mocks.
- `mcp-live-collab.test.ts` and `multi-host.test.ts` drive the real dispatcher through an in-memory MCP client: they assert what an agent actually sees.
- `skills.test.ts` enforces the plugin packaging invariants: manifests, catalogs and `package.json` agree, and skills only mention tools that exist.
- Randomized tests must use `test/unit/prng.ts` and assert that the scenario they generate contains what they claim (stale ops, races). A one-line LCG overflows double precision in JavaScript and once left the core interleaving test almost empty.
- The real-browser login test launches a headless browser locally and is skipped on CI.
- **Manual live checks:** `npm run build`, then `node scripts/agent-session.mjs` (a long-lived MCP client you drive with `curl`) while editing in a browser. `scripts/latency-probe.mjs` times agent edits; `scripts/smoke-stdio.mjs` checks the bundle starts. Use a scratch file, keep edit rates humane on overleaf.com, and clean up.
- **Live suite** (`test/live/`, not part of `npm test` or CI): `test/live/run-matrix.sh [versions…]` starts a throw-away CE per version in `versions.conf` on a Docker host and runs the suite against it; `LIVE_HOST=<name> npm run test:live` points the same suite at a configured host. Run the matrix for changes to `src/overleaf/` and before a release, and add new Overleaf releases to `versions.conf`. Details in `test/live/README.md`.
- The matrix may share a machine with a production Overleaf. Its isolation rules are not negotiable and `test/unit/live-matrix.test.ts` enforces them: **no published ports, an `internal` network, no fixed container names, nothing built, no `docker … prune`, remove only what the run created** (including only the images it pulled).

## Workflow

- One theme per PR, each in its own branch. PRs are squash-merged, with conventional-commit subjects (`fix(ot): …`, `feat: …`, `docs: …`).
- Retarget a stacked PR to `main` (and rebase) as soon as the PR beneath it merges. Otherwise it lands on the feature branch, not on `main`.
- Behaviour changes to tools, the CLI or the credentials file need a `CHANGELOG.md` entry under `## [Unreleased]` and a docs update in the same PR: the README's tool list, `docs/`, and the skills under `skills/` that describe the tool to agents.

## Releasing

`package.json` is the single source of the version. The build injects it into the CLI and the MCP handshake, and the five plugin manifests must match it (a test enforces that). Versioning is semver over the public surface: MCP tool names, arguments, results and error codes, the CLI, and the credentials file format.

1. Release PR: `node scripts/release-prep.mjs <x.y.z>` sets `package.json`, the lockfile and the manifests, and turns the changelog's `## [Unreleased]` into `## [x.y.z] — <date>`. Review the section; for a major version, lead with a *Breaking changes — migrating* list.
2. After it merges: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The `Release` workflow (triggered only by that tag push) checks the tag against `package.json`, runs typecheck, tests and build, publishes to npm, and creates the GitHub release from the changelog section.

Publishing uses npm **trusted publishing** (OIDC); there is no npm token. The trusted publisher on npmjs.com is matched exactly against repository `DanielHou315/overleaf-mcp-rt`, workflow `release.yml` and environment `npm`, so **renaming `release.yml` or the job's `environment: npm` breaks publishing** until the trusted publisher is recreated. Release protection (tag restriction, required reviewer) lives in the `npm` GitHub environment. The release job needs Node ≥ 22.14 / npm ≥ 11.5.1, which is why it runs a newer Node than the package's minimum.
