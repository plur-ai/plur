import { existsSync, readFileSync, realpathSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { homedir } from 'os'

/**
 * Same canonicalization as the CLI's `isPlurConfigured` guard:
 * `process.cwd()` is kernel-canonical (getcwd resolves symlinks) while
 * `homedir()` returns `$HOME` verbatim, so the same directory can spell two
 * ways when a path component is a symlink (macOS `/var` → `/private/var`).
 * The home-refusal below is a PRIVACY guard — a string-equality check that
 * misses on spelling silently fails OPEN, and a stray `~/.plur.yaml` then
 * intercepts every project (with `remote_url` set, that routes prompt text
 * off-box). Canonicalize before comparing; returned paths keep the caller's
 * spelling.
 */
export function canonicalize(p: string): string {
  // `realpathSync.native` returns the ON-DISK letter case, so on a
  // case-insensitive filesystem (macOS APFS/HFS+, Windows NTFS) two spellings
  // that differ only in case, or in the Windows drive-letter case, fold to one.
  // The JavaScript `realpathSync` keeps the caller's case.
  return canonicalizeWith(p, realpathSync.native)
}

/**
 * Every canonical spelling of `p` a check that must fail CLOSED should accept:
 * the case-folded form above, plus the case-preserving form the JavaScript
 * `realpathSync` gives. A match
 * against either one is a match, so folding case can only make such a check
 * match MORE paths, never fewer. Used for the folder map's `off` entries.
 */
export function canonicalSpellings(p: string): string[] {
  return [...new Set([canonicalize(p), canonicalizeWith(p, realpathSync)])]
}

function canonicalizeWith(p: string, real: (p: string) => string): string {
  // `resolve` makes the path absolute and normalises `.` / `..` lexically.
  const abs = resolve(p)
  try { return real(abs) } catch {}
  // A path that does not exist yet (a fresh install's engrams.yaml, a
  // not-yet-created project dir) cannot be realpath'd, but its ancestors can:
  // resolve the deepest EXISTING ancestor and re-append the missing tail, so
  // `/var/…/missing` and `/private/var/…/missing` compare equal. The
  // missing tail keeps the caller's case: there is no on-disk name to fold to.
  const tail: string[] = []
  let cur = abs
  for (;;) {
    const parent = dirname(cur)
    if (parent === cur) return abs
    tail.unshift(basename(cur))
    cur = parent
    try { return join(real(cur), ...tail) } catch {}
  }
}

/**
 * Project-level PLUR config (`.plur.yaml`) — read by both `hook-inject`
 * (CLI) and `plur_session_start` (MCP) so engrams from this project route
 * to the right scope/store automatically.
 *
 * Without it, project engrams would be tagged `global` and context would
 * bleed across projects.
 */
export interface ProjectConfig {
  domain?: string
  scope?: string
  // Remote-Enterprise opt-in (per-project). When set, hook-inject queries the
  // remote /api/v1/inject before falling back to local PLUR. Without these
  // fields the hook is local-only, so personal/non-project prompts stay
  // private to the local engram store. Adopted only from a trusted directory
  // (see project-remote.ts).
  remote_url?: string
  remote_token?: string
  remote_scopes?: string[]
}

/**
 * Walk upward from `startDir` for `.plur.yaml`, bounded by the project (`.git`)
 * so a HOME-level file cannot silently route every project to its Enterprise URL.
 * Stops at the first `.plur.yaml`, the `.git` boundary, or HOME / filesystem
 * root; a `.plur.yaml` IN HOME itself is refused.
 * Inside a repository the walk follows the REAL path (as `findPlurMarker`
 * does), never above the repository root, and returns the caller's spelling
 * when it names the same folder. Outside a repository it uses `path.resolve`.
 */
export function findProjectConfigPath(startDir: string = process.cwd()): string | null {
  const home = canonicalize(homedir())
  const typed = resolve(startDir)
  const realRepo = realRepositoryRoot(typed)
  const found = realRepo !== null ? walkForConfig(canonicalize(typed), home) : walkForConfig(typed, home)
  if (found === null || realRepo === null) return found
  return typedSpelling(found, typed)
}

const MAX_DEPTH = 12  // hard ceiling — beyond ~12 dirs deep, give up

/** The `.plur.yaml` lookup proper: first one up from `start`, stopping at `.git`, HOME or the root. */
function walkForConfig(start: string, home: string): string | null {
  let dir = start
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

/**
 * `found` (a path on the real walk) in the spelling of `typed`: the first
 * ancestor of the typed path (itself included) that resolves to the same
 * folder as `found`'s folder. When none does (a symlink crossed on the way),
 * the real path is the only honest answer.
 */
function typedSpelling(found: string, typed: string): string {
  const realDir = dirname(found)
  let dir = typed
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (canonicalize(dir) === realDir) return join(dir, basename(found))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return found
}

/**
 * Strip balanced single or double quotes around a YAML scalar value.
 * Defensive: a user (or editor auto-format) may quote values.
 */
function unquoteYamlValue(v: string): string {
  return v.replace(/^(['"])(.*)\1$/, '$2')
}

/**
 * Read `.plur.yaml` from an already-resolved path. `null` (not found) short-
 * circuits to `{}` without touching the filesystem again.
 *
 * A caller that also needs the path (e.g. to check trust against the directory
 * the file lives in) should resolve it ONCE with `findProjectConfigPath` and
 * pass it here. Two independent walks are a TOCTOU: if the filesystem changes
 * between them (a symlink swapped, a `.plur.yaml` created/removed), trust
 * could be checked against a different file from the one that was read.
 */
export function readProjectConfigFromPath(configPath: string | null): ProjectConfig {
  if (!configPath) return {}
  try {
    // Strip UTF-8 BOM — some Windows editors prepend it and the first
    // key would otherwise be read as `﻿domain` and silently dropped.
    const content = readFileSync(configPath, 'utf8').replace(/^﻿/, '')
    const config: ProjectConfig = {}
    let inListKey: 'remote_scopes' | null = null
    let listAcc: string[] = []
    const finishList = () => {
      if (inListKey === 'remote_scopes') {
        // Always commit — even an empty list is a valid user intent
        // (the difference between "no whitelist" and "explicitly empty"
        // is downstream's problem, not ours).
        config.remote_scopes = listAcc
      }
      inListKey = null
      listAcc = []
    }

    for (const rawLine of content.split('\n')) {
      const line = rawLine.replace(/\r$/, '')
      const trimmed = line.trim()
      if (trimmed.startsWith('#') || !trimmed) continue

      // List continuation: ONLY active while we're inside remote_scopes.
      // A `- foo` value on an unrelated key like remote_token would
      // otherwise be silently swallowed into listAcc.
      if (inListKey === 'remote_scopes' && trimmed.startsWith('-')) {
        listAcc.push(unquoteYamlValue(trimmed.slice(1).trim()))
        continue
      }
      if (inListKey) finishList()

      const colonIdx = trimmed.indexOf(':')
      if (colonIdx < 0) continue
      const key = trimmed.slice(0, colonIdx).trim()
      const value = unquoteYamlValue(trimmed.slice(colonIdx + 1).trim())

      switch (key) {
        case 'domain':       config.domain = value; break
        case 'scope':        config.scope = value; break
        case 'remote_url':   config.remote_url = value; break
        case 'remote_token': config.remote_token = value; break
        case 'remote_scopes':
          // Multi-line YAML list form: `remote_scopes:` (empty) OR
          // `remote_scopes: |` (block scalar marker) — both trigger list
          // accumulation.
          if (value === '' || value === '|' || value === '>') {
            inListKey = 'remote_scopes'
            listAcc = []
          } else {
            config.remote_scopes = value.split(',').map(s => unquoteYamlValue(s.trim())).filter(Boolean)
          }
          break
      }
    }
    finishList()
    return config
  } catch {
    return {}
  }
}

/**
 * Read `.plur.yaml` from the nearest enclosing project; `{}` if absent or
 * unparseable. Minimal line parser (flat fields; arrays comma-separated or
 * `- item` lines) to keep js-yaml out of the CLI bundle.
 * A caller that also needs the path must call `findProjectConfigPath` +
 * `readProjectConfigFromPath` directly: two separate walks are a TOCTOU.
 */
export function readProjectConfig(startDir: string = process.cwd()): ProjectConfig {
  return readProjectConfigFromPath(findProjectConfigPath(startDir))
}

/** The nearest folder holding `.git` above the real (canonical) `dir`, or `null`. */
function realRepositoryRoot(dir: string): string | null {
  let cur = canonicalize(dir)
  for (;;) {
    if (existsSync(join(cur, '.git'))) return cur
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}
