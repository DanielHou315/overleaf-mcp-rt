// package.json is the only place the version is written down. scripts/build.mjs
// injects it here at bundle time; unbundled runs (vitest, tsx) see 'dev'.
declare const __OVERLEAF_MCP_VERSION__: string | undefined

export const VERSION: string =
  typeof __OVERLEAF_MCP_VERSION__ === 'string' ? __OVERLEAF_MCP_VERSION__ : 'dev'
