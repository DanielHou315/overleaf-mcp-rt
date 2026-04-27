#!/usr/bin/env node
// Build pipeline:
//   1. Apply patches/socket.io-client+0.9.17-overleaf-5.patch via patch-package
//      to our local node_modules/socket.io-client.
//   2. Vendor socket.io-client (and its runtime deps ws/xmlhttprequest/options/
//      ultron) into dist/vendor/node_modules/ as plain CJS files.
//   3. Bundle src/cli.ts → dist/cli.js with esbuild, redirecting the
//      `socket.io-client` import to the vendored copy via a relative path.
//
// Why we vendor instead of bundling socket.io-client:
//   The Overleaf 0.9 fork uses an old UMD-ish wrapper that depends on
//   `module.parent.exports` to share an `io` namespace across files. esbuild
//   concatenates each CJS module into a wrapper that severs the
//   `module.parent` chain, so bundled socket.io-client throws
//   `Cannot read properties of undefined (reading 'exports')`. Keeping it as
//   real CJS files at runtime (loaded by Node's native loader) preserves
//   `module.parent` and Just Works.
//
// Why this build exists at all:
//   The previous design ran `patch-package` as a postinstall on the consumer
//   machine. Under `npx -y`, npm's temp prefix has no package.json at lifecycle-
//   script time, so patch-package's getAppRootPath() throws and the package
//   silently fails to install. Moving the patch step to publish time + shipping
//   the patched code means consumers run zero install hooks.

import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { chmodSync, rmSync, mkdirSync, cpSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outdir = resolve(root, 'dist')
const vendorNm = resolve(outdir, 'vendor', 'node_modules')

const VENDORED_PKGS = ['socket.io-client', 'ws', 'xmlhttprequest', 'options', 'ultron']

console.log('[build] applying patches via patch-package…')
const patch = spawnSync(
  process.execPath,
  [resolve(root, 'node_modules/patch-package/index.js')],
  { cwd: root, stdio: 'inherit' },
)
if (patch.status !== 0) {
  console.error('[build] patch-package failed')
  process.exit(patch.status ?? 1)
}

rmSync(outdir, { recursive: true, force: true })
mkdirSync(vendorNm, { recursive: true })

console.log('[build] vendoring socket.io-client and runtime deps…')
for (const pkg of VENDORED_PKGS) {
  const src = resolve(root, 'node_modules', pkg)
  if (!existsSync(src)) {
    console.error(`[build] expected dep "${pkg}" not in node_modules — run npm install first`)
    process.exit(1)
  }
  const dst = resolve(vendorNm, pkg)
  cpSync(src, dst, {
    recursive: true,
    // Drop nested node_modules; sub-deps are flattened at vendorNm so Node's
    // walk-up resolution finds them.
    filter: (p) => !p.includes(`/node_modules/${pkg}/node_modules`),
  })
}

console.log('[build] bundling src/cli.ts → dist/cli.js…')
await build({
  entryPoints: [resolve(root, 'src/cli.ts')],
  outfile: resolve(outdir, 'cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  legalComments: 'inline',
  // socket.io-client stays as real CJS files at runtime (loaded by Node's
  // native CJS loader, which preserves the `module.parent` chain its old UMD
  // wrapper depends on). The plugin rewrites the import to a path relative to
  // dist/cli.js and marks it external so esbuild doesn't try to inline it.
  plugins: [
    {
      name: 'redirect-socket-io-to-vendor',
      setup(b) {
        b.onResolve({ filter: /^socket\.io-client$/ }, () => ({
          path: './vendor/node_modules/socket.io-client/lib/io.js',
          external: true,
        }))
      },
    },
  ],
  // CJS deps that get bundled (e.g., node-html-parser) sometimes call
  // require() at runtime; provide a createRequire shim. Shebang comes from
  // src/cli.ts itself — esbuild preserves the entry's shebang on line 1.
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  loader: { '.json': 'json' },
  // Don't honor tsconfig `paths` at bundle time (we map socket.io-client →
  // a .d.ts file purely for typecheck).
  tsconfigRaw: '{}',
  logLevel: 'info',
})

chmodSync(resolve(outdir, 'cli.js'), 0o755)
console.log('[build] done — dist/cli.js + dist/vendor are self-contained.')
