import { existsSync, readFileSync, realpathSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { homedir } from 'os'
import yaml from 'js-yaml'
import { atomicWrite, withLock } from './sync.js'

/**
 * Same #521 canonicalization as the CLI's `isPlurConfigured` guard:
 * `process.cwd()` is kernel-canonical (getcwd resolves symlinks) while
 * `homedir()` returns `$HOME` verbatim, so the same directory can spell two
 * ways when a path component is a symlink (macOS `/var` → `/private/var`).
 * The home-refusal below is a PRIVACY guard — a string-equality check that
 * misses on spelling silently fails OPEN, and a stray `~/.plur.yaml` then
 * intercepts every project (with `remote_url` set, that routes prompt text
 * off-box). Canonicalize before comparing; returned paths keep the caller's
 * spelling. (#778 — this mismatch also let the hook test's HOME==cwd setup
 * pass on macOS while failing on Linux CI, where /tmp has no symlink.)
 */
function canonicalize(p: string): string {
  try { return realpathSync(p) } catch { return resolve(p) }
}

/**
 * Project-level PLUR config (`.plur.yaml`) — read by both `hook-inject`
 * (CLI) and `plur_session_start` (MCP) so engrams from this project route
 * to the right scope/store automatically.
 *
 * Originally lived in `packages/cli/src/commands/hook-inject.ts` — moved to
 * core in #177 fix so the MCP session_start handler can apply project scope
 * automatically (the original bug: agents called session_start, project
 * config was ignored, everything got tagged `global`, context bled across
 * projects).
 */
export interface ProjectConfig {
  domain?: string
  scope?: string
  // Remote-Enterprise opt-in (per-project).
  // When set, hook-inject queries the remote /api/v1/inject before falling
  // back to local PLUR. Without these fields, the hook is local-only and
  // Enterprise never sees a query — personal/non-project prompts stay
  // private to the local engram store.
  remote_url?: string
  remote_token?: string
  remote_scopes?: string[]
}

/**
 * Walk upward from `startDir` looking for `.plur.yaml` — but stop at the
 * project boundary (`.git` directory) so we don't pick up an unrelated
 * config from a parent directory or from the user's HOME.
 *
 * Why the `.git` boundary: the original "walk to homedir" semantics meant
 * that a single `.plur.yaml` placed in HOME would silently route EVERY
 * project's prompts to whatever Enterprise URL it contained. That's a
 * privacy leak masquerading as ergonomics. The right boundary is the
 * project itself — defined by `.git`.
 *
 * Termination guarantees:
 *   - Stop at the first `.plur.yaml` we hit (success).
 *   - Stop at the `.git` boundary (project boundary).
 *   - Stop at HOME or filesystem root as a hard ceiling.
 *   - Refuse to consider a `.plur.yaml` that sits IN HOME itself.
 *
 * Paths are resolved (path.resolve) to normalize trailing slashes,
 * symlink components, and `..` segments.
 */
export function findProjectConfigPath(startDir: string = process.cwd()): string | null {
  const home = canonicalize(homedir())
  let dir = resolve(startDir)
  const MAX_DEPTH = 12  // hard ceiling — beyond ~12 dirs deep, give up
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    // Refuse to accept a .plur.yaml that lives directly in HOME.
    // That's the failure mode where a stray home-level config silently
    // intercepts every project the user opens. Canonical comparison so a
    // symlinked spelling of HOME cannot bypass the guard (see canonicalize).
    const atHome = canonicalize(dir) === home
    if (!atHome) {
      const candidate = join(dir, '.plur.yaml')
      if (existsSync(candidate)) return candidate
    }
    // Stop at .git boundary — never escape the current project.
    if (existsSync(join(dir, '.git'))) return null
    // Hard ceilings: home, root, current-dir sentinel.
    if (atHome || dir === '/' || dir === '.') return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/** Parse the full document so nested keys cannot become top-level routing
 * authority. Errors deliberately omit parser excerpts containing tokens. */
export function readProjectConfigDocument(path: string): Record<string, unknown> {
  let content: string
  try { content = readFileSync(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error('Cannot read project configuration')
  }
  try {
    const document = yaml.load(content)
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('mapping required')
    return document as Record<string, unknown>
  } catch { throw new Error('Invalid project configuration; expected a YAML mapping') }
}

/** Merge under one lock, retaining every unrelated key. Serialize values as
 * YAML scalars and replace privately/durably; never truncate the live file. */
export function updateProjectConfig(path: string, patch: Partial<ProjectConfig>): void {
  withLock(path, () => {
    const document = readProjectConfigDocument(path)
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete document[key]
      else document[key] = value
    }
    atomicWrite(path, yaml.dump(document, { lineWidth: 120, noRefs: true }), { mode: 0o600 })
  })
}

/** Read only top-level routing keys. Preserve legacy comma-separated and block
 * list scope forms, while refusing malformed existing configuration. */
export function readProjectConfig(startDir: string = process.cwd()): ProjectConfig {
  const path = findProjectConfigPath(startDir)
  if (!path) return {}
  const document = readProjectConfigDocument(path)
  const config: ProjectConfig = {}
  for (const key of ['domain', 'scope', 'remote_url', 'remote_token'] as const) {
    const value = document[key]
    if (value === undefined) continue
    if (typeof value !== 'string') throw new Error(`Invalid project configuration field: ${key}`)
    config[key] = value
  }
  const scopes = document.remote_scopes
  if (scopes !== undefined) {
    if (scopes === null) config.remote_scopes = []
    else if (Array.isArray(scopes) && scopes.every(scope => typeof scope === 'string')) config.remote_scopes = scopes
    else if (typeof scopes === 'string') config.remote_scopes = scopes.split(/[,\n]/).map(scope => scope.trim().replace(/^-\s+/, '')).filter(Boolean)
    else throw new Error('Invalid project configuration field: remote_scopes')
  }
  return config
}
