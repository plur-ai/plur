import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { spawnSync } from 'child_process'
import yaml from 'js-yaml'
import { isSafeHost, normalizeEndpointUrl } from './store/remote-store.js'
import type { DiscoveryStatus } from './server-discovery.js'

export interface ParsedRemote {
  protocol: 'https' | 'http' | 'ssh' | 'scp'
  host: string
  port?: number
  path: string
}

export type OriginRead =
  | { kind: 'not-git' }
  | { kind: 'no-remote' }
  | { kind: 'url'; url: string }
  | { kind: 'error'; detail: string }

export type GitRunner = (
  args: string[],
  cwd: string,
) => { status: number | null; stdout: string; error?: NodeJS.ErrnoException }

// ── parseGitRemoteUrl ──────────────────────────────────────────────────────

function normalisePath(raw: string): string {
  // Remove leading/trailing slashes and strip .git suffix
  let p = raw.replace(/^\/+|\/+$/g, '')
  if (p.endsWith('.git')) p = p.slice(0, -4)
  return p
}

function parseSchemeUrl(url: string): ParsedRemote | null {
  // Normalise git+ssh → ssh scheme so the URL constructor accepts it
  const normalised = url.startsWith('git+ssh://') ? url.slice(4) : url // 'git+ssh://' → 'ssh://'

  let parsed: URL
  try {
    parsed = new URL(normalised)
  } catch {
    return null
  }

  const scheme = parsed.protocol.slice(0, -1).toLowerCase() // strip trailing ':'
  if (scheme !== 'https' && scheme !== 'http' && scheme !== 'ssh') return null

  const host = parsed.hostname.toLowerCase()
  if (!host) return null

  // pathname already stripped of userinfo by URL parser
  const path = normalisePath(parsed.pathname)
  if (!path) return null

  const result: ParsedRemote = {
    protocol: scheme as 'https' | 'http' | 'ssh',
    host,
    path,
  }
  if (parsed.port) result.port = parseInt(parsed.port, 10)
  return result
}

// scp-like: [user@]host:path — must not start with a scheme, must have ':', must not be a Windows drive.
// The host is a name or a bracketed IPv6 literal (`git@[2001:db8::1]:team/backend.git`).
// The path may be absolute on the host (`git@host:/srv/repo.git`); its leading '/' is dropped.
const SCP_RE = /^(?:[^/@:[\]]+@)?(\[[^\]/@]*\]|[^/:@[\]]+):(?!\\)([^?#]*?)(?:\.git)?\/?$/

function parseScpUrl(url: string): ParsedRemote | null {
  // scp-like has no ://; reject anything with a scheme
  if (url.includes('://')) return null
  const m = url.match(SCP_RE)
  if (!m) return null
  let host = m[1].toLowerCase()
  if (host.startsWith('[')) {
    // Canonical form, as URL.hostname prints it for an https/ssh remote, so
    // both spellings of one address compare equal; not an address → null.
    try {
      host = new URL(`ssh://${host}/`).hostname
    } catch {
      return null
    }
    if (!host.startsWith('[')) return null
  }
  const path = normalisePath(m[2])
  if (!path) return null
  return { protocol: 'scp', host, path }
}

export function parseGitRemoteUrl(url: string): ParsedRemote | null {
  if (!url) return null

  // Reject file:// and absolute local paths and Windows paths
  if (
    url.startsWith('file://') ||
    url.startsWith('/') ||
    /^[A-Za-z]:[/\\]/.test(url)
  ) {
    return null
  }

  // Try scheme-based parsing first (https, http, ssh, git+ssh)
  if (url.includes('://')) {
    return parseSchemeUrl(url)
  }

  // Try scp-like
  return parseScpUrl(url)
}

// ── readGitOrigin ──────────────────────────────────────────────────────────

function findGitRoot(dir: string): string | null {
  // Resolve first: a lexical walk up a relative path stops at '.', which would
  // report the caller's cwd repo for a folder that is in no repo at all.
  let current = resolve(dir)
  while (true) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function defaultRunner(args: string[], cwd: string) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 2000,
    windowsHide: true,
  }) as { status: number | null; stdout: string; error?: NodeJS.ErrnoException }
}

export function readGitOrigin(dir: string, run?: GitRunner): OriginRead {
  const gitRoot = findGitRoot(dir)
  if (!gitRoot) return { kind: 'not-git' }

  const runner = run ?? defaultRunner
  // `git config --get remote.origin.url` reads the stored value and does NOT
  // apply url.<base>.insteadOf rewrites (those only fire when git resolves a
  // remote for fetch/push).
  const result = runner(['config', '--get', 'remote.origin.url'], gitRoot)

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return { kind: 'error', detail: 'git is not installed or not on PATH' }
    }
    if (code === 'ETIMEDOUT') {
      return { kind: 'error', detail: 'git timed out reading remote.origin.url' }
    }
    return { kind: 'error', detail: `git could not run${code ? ` (${code})` : ''}` }
  }

  // exit 1 = config key not found (no origin configured)
  if (result.status === 1) return { kind: 'no-remote' }

  if (result.status !== 0) {
    return { kind: 'error', detail: `git config exited with status ${result.status}` }
  }

  const url = result.stdout.trim()
  if (!url) return { kind: 'no-remote' }

  return { kind: 'url', url }
}

// ── gitDefaultScope (#1632) ────────────────────────────────────────────────
//
// Model: spec/formal/PlurSpec/GitScope.lean (theorems and the counterexamples
// for the host, listing, path and freshness rules).

/** What one company server last told this machine, read from its config.yaml server entry. */
export interface GitScopeSource {
  /** The server's canonical endpoint identity (normalizeEndpointUrl): no userinfo, no token. */
  server: string
  gitlab_host: string | null
  project_paths: Record<string, string>
  /** The scopes the server listed (`scopes`), never `pinned_scopes`. */
  scopes: string[]
  status: DiscoveryStatus | 'never'
  discovered_at?: string
}

export type LocalReason = 'no-remote' | 'not-company-gitlab' | 'no-scope-for-project'
export type UnknownReason = 'git-unreadable' | 'scopes-unavailable' | 'cache-stale' | 'ambiguous-mapping'
export type GitScopeOutcome =
  | { kind: 'scope'; scope: string; server: string }
  | { kind: 'local'; reason: LocalReason }
  | { kind: 'unknown'; reason: UnknownReason }
  | { kind: 'not-git' }

/** A discovery cache older than this is stale (the same limit `plur doctor` uses). */
export const DISCOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** Clock skew tolerated for a `discovered_at` in the future. */
const DISCOVERY_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000

const DEFAULT_PORT: Record<ParsedRemote['protocol'], number | undefined> = { https: 443, http: 80, ssh: undefined, scp: undefined }

/**
 * Host and optional port of a `gitlab_host`, or null when it fails the
 * server-string host grammar (`isSafeHost`: a lower-case name or IPv4
 * address, or a canonical bracketed IPv6 literal, with an optional port).
 * The hostname is returned in the form `URL.hostname` prints, so it compares
 * by string equality with a parsed remote's host.
 */
function gitlabHostParts(h: string): { host: string; port?: number } | null {
  if (!isSafeHost(h)) return null
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(h)
  if (!m) return null
  if (m[2] === undefined) return { host: m[1] }
  // The host grammar allows any 1-5 digits; a port outside 1-65535 names no server.
  const port = Number(m[2])
  return port >= 1 && port <= 65535 ? { host: m[1], port } : null
}

/**
 * Same GitLab: the hostname exactly (both lower-case); the port only when the
 * remote is http(s) and `gitlab_host` names one — a remote without a port is
 * on its scheme's default port. An ssh remote's port is never compared: it is
 * GitLab's ssh port, not the web port `gitlab_host` carries.
 */
function sameGitlab(remote: ParsedRemote, gitlabHost: string | null): boolean {
  if (gitlabHost === null) return false
  const g = gitlabHostParts(gitlabHost)
  if (!g || g.host !== remote.host) return false
  if (g.port === undefined || (remote.protocol !== 'https' && remote.protocol !== 'http')) return true
  return (remote.port ?? DEFAULT_PORT[remote.protocol]) === g.port
}

/** Why a matching source's cache cannot be used, or null when it is fresh. */
function cacheProblem(src: GitScopeSource, now: number): UnknownReason | null {
  if (src.discovered_at === undefined) return 'scopes-unavailable'
  const t = Date.parse(src.discovered_at)
  if (Number.isNaN(t) || now - t > DISCOVERY_MAX_AGE_MS || t - now > DISCOVERY_FUTURE_SKEW_MS) return 'cache-stale'
  return null
}

/**
 * The default scope of the git repo at `dir`, from its `origin` remote and the
 * company servers' cached project mapping. Pure apart from `read` (default:
 * readGitOrigin, which runs git without a shell); no network.
 *
 * A `scope` outcome is always a scope that a fresh, host-matching source
 * listed in `scopes` AND mapped to exactly this project path; it is the only
 * such (scope, server) pair. Any doubt — git unreadable, a matching server
 * with no cache or a stale one, two candidates — is `unknown`, never a guess.
 */
export function gitDefaultScope(
  dir: string,
  sources: readonly GitScopeSource[],
  opts?: { now?: number; read?: (dir: string) => OriginRead },
): GitScopeOutcome {
  const origin = (opts?.read ?? readGitOrigin)(dir)
  if (origin.kind === 'not-git') return { kind: 'not-git' }
  if (origin.kind === 'error') return { kind: 'unknown', reason: 'git-unreadable' }
  if (origin.kind === 'no-remote') return { kind: 'local', reason: 'no-remote' }
  const remote = parseGitRemoteUrl(origin.url)
  if (!remote) return { kind: 'local', reason: 'not-company-gitlab' }

  const matching = sources.filter(s => sameGitlab(remote, s.gitlab_host))
  if (matching.length === 0) return { kind: 'local', reason: 'not-company-gitlab' }

  const now = opts?.now ?? Date.now()
  for (const s of matching) {
    const problem = cacheProblem(s, now)
    if (problem) return { kind: 'unknown', reason: problem }
  }

  const path = remote.path.toLowerCase()
  const found: { scope: string; server: string }[] = []
  for (const s of matching) {
    for (const scope of s.scopes) {
      const mapped = Object.prototype.hasOwnProperty.call(s.project_paths, scope) ? s.project_paths[scope] : undefined
      if (typeof mapped !== 'string' || mapped.toLowerCase() !== path) continue
      if (!found.some(f => f.scope === scope && f.server === s.server)) found.push({ scope, server: s.server })
    }
  }
  if (found.length === 0) return { kind: 'local', reason: 'no-scope-for-project' }
  if (found.length > 1) return { kind: 'unknown', reason: 'ambiguous-mapping' }
  return { kind: 'scope', scope: found[0].scope, server: found[0].server }
}

// ── loadGitScopeSources ────────────────────────────────────────────────────

const DISCOVERY_STATUSES: readonly string[] = ['ok', 'not_synced', 'failed', 'auth_failed', 'degraded'] satisfies DiscoveryStatus[]

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** The canonical identity of an http(s) endpoint url, or null for anything
 *  else (normalizeEndpointUrl returns other strings as written, userinfo included). */
function httpEndpoint(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  } catch {
    return null
  }
  return normalizeEndpointUrl(url)
}

/**
 * The git scope sources in `<plurRoot>/config.yaml`: one per company server
 * entry (C6: a string `url` and an `enterprise` object — the entries discovery
 * writes). Reads the file only; no network, never throws. Fields come from the
 * entry's `discovery` cache; a field of the wrong shape is dropped (a
 * `gitlab_host` outside the host grammar becomes null, an unknown status
 * becomes 'never', a `scopes` value that is not a list becomes []), never the
 * entry: a malformed entry still takes part in the freshness check, so its
 * stale cache cannot be skipped. A `url` that is not a valid http(s) url gives
 * `server: ''` and no scopes: it can only make the answer `unknown`, never a
 * scope. The token and the url's userinfo never reach a source.
 */
export function loadGitScopeSources(plurRoot: string): GitScopeSource[] {
  let raw: unknown
  try {
    raw = yaml.load(readFileSync(join(plurRoot, 'config.yaml'), 'utf8'))
  } catch {
    return []
  }
  if (!isPlainObject(raw) || !Array.isArray(raw.stores)) return []
  const out: GitScopeSource[] = []
  for (const e of raw.stores) {
    if (!isPlainObject(e) || typeof e.url !== 'string' || !isPlainObject(e.enterprise)) continue
    const server = httpEndpoint(e.url)
    const d = isPlainObject(e.discovery) ? e.discovery : {}
    const project_paths: Record<string, string> = {}
    if (isPlainObject(d.project_paths)) {
      for (const [k, v] of Object.entries(d.project_paths)) if (typeof v === 'string') project_paths[k] = v
    }
    const src: GitScopeSource = {
      server: server ?? '',
      gitlab_host: typeof d.gitlab_host === 'string' && isSafeHost(d.gitlab_host) ? d.gitlab_host : null,
      status: typeof d.status === 'string' && DISCOVERY_STATUSES.includes(d.status) ? d.status as DiscoveryStatus : 'never',
      scopes: server !== null && Array.isArray(e.scopes) ? e.scopes.filter((x): x is string => typeof x === 'string') : [],
      project_paths,
    }
    if (typeof d.discovered_at === 'string') src.discovered_at = d.discovered_at
    out.push(src)
  }
  return out
}
