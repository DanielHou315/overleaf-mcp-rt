#!/usr/bin/env node
// patch-package looks for `node_modules/<pkg>` relative to its CWD. When
// overleaf-mcp-rt is installed as a *dependency* (e.g. via `npx -y` or as a
// transitive dep), npm hoists socket.io-client to a parent node_modules
// directory, so running patch-package from this package's own directory
// silently fails with "Patch file found for package socket.io-client which is
// not present at node_modules/socket.io-client". The published 1.0.1 hits
// exactly this — the WS upgrade then ships without our Cookie header and the
// realtime backend rejects the connection with `invalid session`.
//
// Resolve socket.io-client via Node's own algorithm (works for hoisted, nested,
// and pnpm layouts), then run patch-package from the dir that *contains* its
// node_modules so the patch path math lines up.

const { spawnSync } = require('node:child_process')
const { dirname, join, relative } = require('node:path')
const { existsSync } = require('node:fs')

const pkgDir = __dirname.replace(/[\\/]scripts$/, '')
const patchesDir = join(pkgDir, 'patches')

if (!existsSync(patchesDir)) {
  // Nothing to do — published tarball missing patches/ shouldn't happen, but
  // don't fail installs over it.
  process.exit(0)
}

let socketDir
try {
  // require.resolve gives us a file path inside socket.io-client. Walk up to
  // its package root, then up once more to the node_modules that *contains* it.
  const entry = require.resolve('socket.io-client', { paths: [pkgDir] })
  // entry: <root>/node_modules/socket.io-client/lib/io.js (or similar)
  let cur = dirname(entry)
  while (cur !== dirname(cur) && !existsSync(join(cur, 'package.json'))) {
    cur = dirname(cur)
  }
  // cur is now socket.io-client's own dir; its parent is the node_modules
  // that contains it.
  socketDir = dirname(dirname(cur))
} catch {
  // socket.io-client isn't installed — likely `npm install --production=false`
  // in CI without the dep, or someone running scripts before deps. Skip.
  process.exit(0)
}

if (!existsSync(join(socketDir, 'node_modules', 'socket.io-client'))) {
  // Defensive: if our walk-up landed somewhere unexpected, bail rather than
  // run patch-package with a wrong CWD.
  process.exit(0)
}

// patch-package rejects absolute --patch-dir; pass it relative to the CWD it
// will run in.
const relPatchDir = relative(socketDir, patchesDir) || '.'

const result = spawnSync(
  process.execPath,
  [require.resolve('patch-package/index.js'), '--patch-dir', relPatchDir],
  { cwd: socketDir, stdio: 'inherit' },
)
process.exit(result.status ?? 0)
