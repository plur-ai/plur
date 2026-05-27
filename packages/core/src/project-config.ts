import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { homedir } from 'os'

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
  const home = resolve(homedir())
  let dir = resolve(startDir)
  const MAX_DEPTH = 12  // hard ceiling — beyond ~12 dirs deep, give up
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    // Refuse to accept a .plur.yaml that lives directly in HOME.
    // That's the failure mode where a stray home-level config silently
    // intercepts every project the user opens.
    if (dir !== home) {
      const candidate = join(dir, '.plur.yaml')
      if (existsSync(candidate)) return candidate
    }
    // Stop at .git boundary — never escape the current project.
    if (existsSync(join(dir, '.git'))) return null
    // Hard ceilings: home, root, current-dir sentinel.
    if (dir === home || dir === '/' || dir === '.') return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/**
 * Strip balanced single or double quotes around a YAML scalar value.
 * Defensive: a user (or editor auto-format) may quote values.
 */
function unquoteYamlValue(v: string): string {
  return v.replace(/^(['"])(.*)\1$/, '$2')
}

/**
 * Read `.plur.yaml` from the nearest enclosing project directory.
 * Returns `{}` if not found or unparseable.
 *
 * The parser is intentionally minimal (line-by-line) rather than pulling
 * js-yaml into the CLI bundle — config files are short, fields are flat,
 * and dependency-free keeps the CLI bundle tiny. Arrays use comma-
 * separated values OR YAML-style `- item` lines.
 *
 * Accepts an optional `startDir` so callers (notably the MCP server,
 * which lives in core and gets the dir from `process.cwd()`) can override
 * the walk root.
 */
export function readProjectConfig(startDir: string = process.cwd()): ProjectConfig {
  const configPath = findProjectConfigPath(startDir)
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
      // Any non-dash line ends the previous list
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
            // Inline comma-separated form
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
