#!/usr/bin/env node
// Entry point used by the plugin's MCP config (.mcp.json / mcp.json).
//
// A plugin is installed from a git checkout, which has no build output, while
// the server is distributed through npm. So:
//   1. OVERLEAF_MCP_CLI=<path>   run that build (development escape hatch)
//   2. <plugin root>/dist/cli.js  run the local build, if someone built it
//   3. otherwise                  npx overleaf-mcp-rt@<this plugin's version>,
//      so the skills and the server they describe always match; if that exact
//      version isn't on npm (a checkout between releases), fall back to @latest.
//
// stdout belongs to the MCP protocol — everything we say goes to stderr.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const log = (msg) => process.stderr.write(`[overleaf-mcp-rt] ${msg}\n`)

function run(command, commandArgs, onFailedStart, cwd) {
  const child = spawn(command, commandArgs, { cwd, stdio: ['inherit', 'pipe', 'inherit'], shell: process.platform === 'win32' })
  let spoke = false
  child.stdout.on('data', (chunk) => {
    spoke = true
    process.stdout.write(chunk)
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  child.on('error', (err) => {
    log(`could not start ${command}: ${err.message}`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    // A server that never wrote to stdout never started; that is the only
    // case worth a second attempt.
    if (code !== 0 && !spoke && onFailedStart) return onFailedStart()
    process.exit(code ?? (signal ? 1 : 0))
  })
}

const override = process.env.OVERLEAF_MCP_CLI
const localBuild = resolve(root, 'dist', 'cli.js')
if (override) {
  run(process.execPath, [override, ...args])
} else if (existsSync(localBuild)) {
  run(process.execPath, [localBuild, ...args])
} else {
  const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'))
  // npx resolves a spec against the current directory's package.json first. Run
  // it from a neutral directory, or launching from inside a checkout of this
  // repo "satisfies" overleaf-mcp-rt@<version> with whatever is on PATH.
  const neutral = tmpdir()
  run('npx', ['-y', `overleaf-mcp-rt@${version}`, ...args], () => {
    log(`overleaf-mcp-rt@${version} is not available from npm; using the latest published version instead.`)
    run('npx', ['-y', 'overleaf-mcp-rt@latest', ...args], undefined, neutral)
  }, neutral)
}
