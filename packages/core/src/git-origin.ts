import { existsSync } from 'fs'
import { dirname } from 'path'
import { spawnSync } from 'child_process'

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

// scp-like: [user@]host:path — must not start with a scheme, must have ':', must not be a Windows drive
const SCP_RE = /^(?:[^/@:]+@)?([^/:@]+):([^/\\][^?#]*?)(?:\.git)?\/?$/

function parseScpUrl(url: string): ParsedRemote | null {
  // scp-like has no ://; reject anything with a scheme
  if (url.includes('://')) return null
  const m = url.match(SCP_RE)
  if (!m) return null
  const host = m[1].toLowerCase()
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
  let current = dir
  while (true) {
    if (existsSync(`${current}/.git`)) return current
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
    return { kind: 'error', detail: 'git timed out reading remote.origin.url' }
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
