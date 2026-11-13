import { readFileSync, existsSync, writeFileSync, mkdirSync, chmodSync, renameSync, rmSync, rmdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, posix, win32 } from 'node:path'
import { InvalidConfigError } from './errors.js'

export interface Config {
  url: string
  sessionCookie: string
  extraHeaders: Record<string, string>
  debug: boolean
}

/** One Overleaf instance the server can talk to. */
export interface HostConfig extends Config {
  /** Short name agents pass as `host` (defaults to the URL's hostname, minus `www.`). */
  name: string
}

export interface HostsConfig {
  hosts: HostConfig[]
  /** Name of the host used when a tool call doesn't say which. */
  defaultHost: string
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
  credentialsPath?: string
  /** Pick a specific host instead of the default (loadConfig only). */
  host?: string
}

interface StoredHost {
  url?: string
  session_cookie?: string
  extra_headers?: Record<string, string>
}

/**
 * On-disk credentials. v2 keeps any number of named hosts; the flat v1 shape
 * (`{url, session_cookie, extra_headers}`) is still read and is upgraded the
 * next time `login` writes the file.
 */
interface CredentialsFile extends StoredHost {
  default?: string
  hosts?: Record<string, StoredHost>
}

const APP_DIR = 'overleaf-mcp-rt'
const CREDENTIALS_FILE = 'credentials.json'

export interface PlatformInfo {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
  platform?: NodeJS.Platform
  home?: string
}

/**
 * Where the credentials file lives when nothing overrides it, following each
 * platform's convention:
 *
 * - `$XDG_CONFIG_HOME/overleaf-mcp-rt/` whenever that variable holds an absolute
 *   path (on any platform: setting it is an explicit request)
 * - Windows: `%APPDATA%\overleaf-mcp-rt\`
 * - macOS: `~/Library/Application Support/overleaf-mcp-rt/`
 * - elsewhere: `~/.config/overleaf-mcp-rt/` (the XDG default)
 */
export function defaultCredentialsPath(info: PlatformInfo = {}): string {
  const env = info.env ?? process.env
  const platform = info.platform ?? process.platform
  const home = info.home ?? homedir()
  const p = platform === 'win32' ? win32 : posix
  const xdg = env.XDG_CONFIG_HOME
  // The XDG spec says a relative path here is invalid and must be ignored.
  if (xdg && p.isAbsolute(xdg)) return p.join(xdg, APP_DIR, CREDENTIALS_FILE)
  if (platform === 'win32') {
    return p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), APP_DIR, CREDENTIALS_FILE)
  }
  if (platform === 'darwin') {
    return p.join(home, 'Library', 'Application Support', APP_DIR, CREDENTIALS_FILE)
  }
  return p.join(home, '.config', APP_DIR, CREDENTIALS_FILE)
}

/** Before 2.3 the file was at `~/.config/overleaf-mcp-rt/` on every platform. */
export function legacyCredentialsPath(info: PlatformInfo = {}): string {
  const p = (info.platform ?? process.platform) === 'win32' ? win32 : posix
  return p.join(info.home ?? homedir(), '.config', APP_DIR, CREDENTIALS_FILE)
}

interface CredentialsLocation {
  /** Where the file is written, and read from if it exists. */
  path: string
  /** The pre-2.3 location, when it differs: read as a fallback, removed once `path` is written. */
  legacy?: string
  /** True when `path` is our own per-user directory, whose permissions we manage. */
  managed: boolean
}

/**
 * An explicit path (an option, or `OVERLEAF_CREDENTIALS_FILE` — for tests,
 * sandboxes, separate profiles) is used as given, with no fallback.
 */
function locateCredentials(explicit?: string): CredentialsLocation {
  const override = explicit ?? process.env.OVERLEAF_CREDENTIALS_FILE
  if (override) return { path: override, managed: false }
  const path = defaultCredentialsPath()
  const legacy = legacyCredentialsPath()
  return { path, legacy: legacy === path ? undefined : legacy, managed: true }
}

/** The file to read: the current location, or the pre-2.3 one if only that exists. */
function readablePath(loc: CredentialsLocation): string {
  return !existsSync(loc.path) && loc.legacy && existsSync(loc.legacy) ? loc.legacy : loc.path
}

/** `https://www.overleaf.com` → `overleaf.com`; `https://tex.example.org:8443/x` → `tex.example.org`. */
export function hostNameForUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function readCredentialsFile(path: string): CredentialsFile {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as CredentialsFile
  } catch (err) {
    throw new InvalidConfigError(`Cannot parse credentials file ${path}`, { cause: String(err) })
  }
}

function storedHosts(file: CredentialsFile): Record<string, StoredHost> {
  const hosts: Record<string, StoredHost> = { ...(file.hosts ?? {}) }
  if (file.url && !Object.values(hosts).some((h) => h.url === file.url)) {
    hosts[hostNameForUrl(file.url)] = {
      url: file.url,
      session_cookie: file.session_cookie,
      extra_headers: file.extra_headers,
    }
  }
  return hosts
}

function normalizeUrl(url: string | undefined): string {
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
  return parsed.origin + parsed.pathname.replace(/\/+$/, '')
}

/**
 * Every configured host. Hosts come from the credentials file; if
 * OVERLEAF_URL is set, the environment defines (or overrides) a host for that
 * URL and makes it the default, so single-host env setups behave as before.
 */
export function loadHosts(opts: LoadConfigOptions = {}): HostsConfig {
  const env = opts.env ?? process.env
  const file = readCredentialsFile(readablePath(locateCredentials(opts.credentialsPath)))
  const debug = env.OVERLEAF_DEBUG === '1' || env.OVERLEAF_DEBUG === 'true'

  let envHeaders: Record<string, string> | undefined
  if (env.OVERLEAF_EXTRA_HEADERS) {
    try {
      envHeaders = JSON.parse(env.OVERLEAF_EXTRA_HEADERS) as Record<string, string>
    } catch (err) {
      throw new InvalidConfigError('OVERLEAF_EXTRA_HEADERS is not valid JSON', { cause: String(err) })
    }
  }

  const stored = storedHosts(file)
  const names = Object.keys(stored)
  let defaultHost = file.default && stored[file.default] ? file.default : names[0]

  // Environment: targets OVERLEAF_URL's host, or the default host when only a
  // cookie/headers are given.
  const envUrl = env.OVERLEAF_URL
  const envTarget = envUrl
    ? names.find((n) => sameUrl(stored[n]!.url, envUrl)) ?? hostNameForUrl(envUrl)
    : defaultHost
  if (envUrl || env.OVERLEAF_SESSION_COOKIE || envHeaders) {
    const name = envTarget ?? 'default'
    const base = stored[name] ?? {}
    stored[name] = {
      url: envUrl ?? base.url,
      session_cookie: env.OVERLEAF_SESSION_COOKIE ?? base.session_cookie,
      extra_headers: envHeaders ?? base.extra_headers,
    }
    if (envUrl || !defaultHost) defaultHost = name
  }

  if (Object.keys(stored).length === 0) normalizeUrl(undefined) // throws the "URL is required" error

  const hosts = Object.entries(stored).map(([name, h]): HostConfig => {
    const url = normalizeUrl(h.url)
    if (!h.session_cookie) {
      throw new InvalidConfigError(
        'OVERLEAF_SESSION_COOKIE is required (paste from devtools or run `overleaf-mcp-rt login`).',
        { host: name },
      )
    }
    return { name, url, sessionCookie: h.session_cookie, extraHeaders: h.extra_headers ?? {}, debug }
  })
  return { hosts, defaultHost: defaultHost! }
}

function sameUrl(a: string | undefined, b: string): boolean {
  try {
    return !!a && normalizeUrl(a) === normalizeUrl(b)
  } catch {
    return false
  }
}

/** The default host (or `opts.host`) as a single-host config. */
export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const { hosts, defaultHost } = loadHosts(opts)
  const wanted = opts.host ?? defaultHost
  const host = hosts.find((h) => h.name === wanted)
  if (!host) {
    throw new InvalidConfigError(
      `No configured Overleaf host named "${wanted}". Known hosts: ${hosts.map((h) => h.name).join(', ')}`,
    )
  }
  const { name: _name, ...config } = host
  return config
}

/**
 * Add or replace one host in the credentials file, upgrading a v1 file to v2
 * and moving a file from the pre-2.3 location to the platform's own.
 *
 * The file holds session cookies, so it is never visible to other users, not
 * even briefly: it is created with mode 0600 under a temporary name and renamed
 * into place, which also means a crash can't leave a half-written file.
 */
export function saveHost(
  host: { name: string; url: string; sessionCookie: string; extraHeaders: Record<string, string> },
  opts: { credentialsPath?: string; makeDefault?: boolean } = {},
): { path: string; isDefault: boolean; movedFrom?: string } {
  const loc = locateCredentials(opts.credentialsPath)
  const source = readablePath(loc)
  const file = readCredentialsFile(source)
  const hosts = storedHosts(file)
  hosts[host.name] = {
    url: host.url,
    session_cookie: host.sessionCookie,
    extra_headers: host.extraHeaders,
  }
  const previousDefault = file.default && hosts[file.default] ? file.default : Object.keys(storedHosts(file))[0]
  const defaultName = opts.makeDefault || !previousDefault ? host.name : previousDefault

  const dir = dirname(loc.path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // mkdir's mode only applies to directories it creates; tighten our own if it predates this.
  if (loc.managed) chmodSync(dir, 0o700)
  const tmp = `${loc.path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify({ default: defaultName, hosts }, null, 2), { mode: 0o600, flag: 'wx' })
    renameSync(tmp, loc.path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }

  let movedFrom: string | undefined
  if (source !== loc.path) {
    // Don't leave a second, soon-to-be-stale copy of the cookies behind.
    rmSync(source, { force: true })
    try {
      rmdirSync(dirname(source)) // only succeeds if now empty
    } catch {
      /* other files there, or already gone */
    }
    movedFrom = source
  }
  return { path: loc.path, isDefault: defaultName === host.name, movedFrom }
}
