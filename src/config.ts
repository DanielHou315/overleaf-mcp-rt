import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { InvalidConfigError } from './errors.js'

export interface Config {
  url: string
  sessionCookie: string
  extraHeaders: Record<string, string>
  debug: boolean
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
  credentialsPath?: string
}

interface CredentialsFile {
  url?: string
  session_cookie?: string
  extra_headers?: Record<string, string>
}

const DEFAULT_CREDENTIALS_PATH = join(homedir(), '.config', 'overleaf-mcp-rt', 'credentials.json')

export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const env = opts.env ?? process.env
  const credentialsPath = opts.credentialsPath ?? DEFAULT_CREDENTIALS_PATH

  let fileCfg: CredentialsFile = {}
  if (existsSync(credentialsPath)) {
    try {
      fileCfg = JSON.parse(readFileSync(credentialsPath, 'utf-8')) as CredentialsFile
    } catch (err) {
      throw new InvalidConfigError(`Cannot parse credentials file ${credentialsPath}`, {
        cause: String(err),
      })
    }
  }

  const url = env.OVERLEAF_URL ?? fileCfg.url
  const sessionCookie = env.OVERLEAF_SESSION_COOKIE ?? fileCfg.session_cookie

  if (!url) {
    throw new InvalidConfigError(
      'OVERLEAF_URL is required (set the env var or run `overleaf-mcp-rt login`).',
    )
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new InvalidConfigError(
      `OVERLEAF_URL is an invalid URL — must start with http:// or https:// (got: ${url})`,
    )
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new InvalidConfigError(`OVERLEAF_URL has no host or is not a valid URL: ${url}`)
  }
  if (!parsed.host) {
    throw new InvalidConfigError(`OVERLEAF_URL must have a host (got: ${url})`)
  }
  const normalizedUrl = parsed.origin + parsed.pathname.replace(/\/+$/, '')
  if (!sessionCookie) {
    throw new InvalidConfigError(
      'OVERLEAF_SESSION_COOKIE is required (paste from devtools or run `overleaf-mcp-rt login`).',
    )
  }

  let extraHeaders: Record<string, string> = fileCfg.extra_headers ?? {}
  if (env.OVERLEAF_EXTRA_HEADERS) {
    try {
      extraHeaders = JSON.parse(env.OVERLEAF_EXTRA_HEADERS) as Record<string, string>
    } catch (err) {
      throw new InvalidConfigError('OVERLEAF_EXTRA_HEADERS is not valid JSON', {
        cause: String(err),
      })
    }
  }

  return {
    url: normalizedUrl,
    sessionCookie,
    extraHeaders,
    debug: env.OVERLEAF_DEBUG === '1' || env.OVERLEAF_DEBUG === 'true',
  }
}
