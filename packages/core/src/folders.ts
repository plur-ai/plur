import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, lstatSync, realpathSync } from 'fs'
import { basename, dirname, join, resolve, sep } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import yaml from 'js-yaml'
import { z } from 'zod'
import { logger } from './logger.js'
import { atomicWrite, withLock } from './sync.js'
import { canonicalize, canonicalSpellings, findProjectConfigPath, readProjectConfigFromPath } from './project-config.js'
import { resolveProjectRemoteFromConfig } from './project-remote.js'
import { isSharedScope } from './scope-util.js'
import { isLocalOnlyScope } from './scope-target.js'

/**
 * The folder map (#1347): `<PLUR home>/folders.yaml` holds the user's own
 * decisions about folders — on / off / ask, a default write scope, and
 * `trusted` (the grant that used to live in `trust.yaml`).
 *
 * `.plur.yaml` stays what it was: the repo's REQUEST. It cannot express map
 * entries; only this file, written only through the CLI, holds decisions.
 * Design note: docs/specs/2026-09-28-folder-map-design.md (r3, approved), on
 * the docs/field-report-triage branch; owner decision D1 ("ignore-ask") is in
 * docs/audits/2026-09-29-formal-decisions.yaml there.
 *
 * ```yaml
 * version: 1
 * folders:
 *   - path: ~/work/**
 *     scope: group:example/eng   # on, with a default write scope
 *   - path: ~/work/secret/**
 *     plur: off                  # nothing at all here
 *   - path: /src/team-repo
 *     trusted: true              # this tree's .plur.yaml may use its remote
 * ```
 */

export type FolderMode = 'on' | 'off' | 'ask'

export interface FolderEntry {
  path: string
  plur?: FolderMode
  scope?: string
  trusted?: boolean
}

export interface FolderMap {
  version: 1
  folders: FolderEntry[]
}

/** Where a policy decision came from. */
export type FolderPolicySource = 'map' | 'plur-yaml' | 'mcp-config' | 'default'

export interface FolderPolicy {
  mode: FolderMode
  /** Default write scope: a map entry's `scope`, else a TRUSTED `.plur.yaml`'s hint. */
  scope?: string
  /** True only when a `.plur.yaml` names a remote AND a covering entry is `trusted`. */
  remoteAllowed: boolean
  source: FolderPolicySource
  /**
   * Why the answer is `ask` when that is not simply "unmapped". Today only
   * `untrusted-plur-yaml` (decision D1): the repo's `.plur.yaml` requests
   * settings that need trust, and they are ignored until the user says yes.
   */
  reason?: 'untrusted-plur-yaml'
  /** What that `.plur.yaml` requests, for the question. Never the token. */
  requested?: { scope?: string; domain?: string; remote_url?: string }
}

const FolderEntrySchema = z.object({
  path: z.string().min(1),
  plur: z.enum(['on', 'off', 'ask']).optional(),
  scope: z.string().min(1).optional(),
  trusted: z.boolean().optional(),
}).passthrough()

const FolderMapSchema = z.object({
  version: z.literal(1).optional(),
  folders: z.array(FolderEntrySchema).optional(),
}).passthrough()

export function folderMapPath(root: string): string {
  return join(root, 'folders.yaml')
}

function legacyTrustPath(root: string): string {
  return join(root, 'trust.yaml')
}

// ---------------------------------------------------------------------------
// Pure matching (no filesystem) — exported for tests, including win32 paths.
// ---------------------------------------------------------------------------

type Platform = NodeJS.Platform

/** Normalise a path for comparison: `/` separators, case-folded on win32, no trailing slash. */
function norm(p: string, platform: Platform): string {
  let s = platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p
  while (s.length > 1 && s.endsWith('/') && !/^[a-z]:\/$/i.test(s)) s = s.slice(0, -1)
  return s
}

function firstGlobIndex(p: string): number {
  const m = /[*?]/.exec(p)
  return m ? m.index : -1
}

function globToRegex(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '/' && pattern.startsWith('/**', i) && (i + 3 === pattern.length || pattern[i + 3] === '/')) {
      re += '(?:/.*)?'
      i += 2
    } else if (c === '*' && pattern[i + 1] === '*') {
      re += '.*'
      i += 1
    } else if (c === '*') {
      re += '[^/]*'
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

/**
 * True when `pattern` covers `target`. Both must already be absolute and
 * expanded. A literal directory covers itself and everything below it; a glob
 * covers any path it matches and everything below a match.
 */
export function folderPatternMatches(pattern: string, target: string, platform: Platform = process.platform): boolean {
  const p = norm(pattern, platform)
  const t = norm(target, platform)
  if (firstGlobIndex(p) === -1) {
    if (t === p) return true
    return t.startsWith(p.endsWith('/') ? p : p + '/')
  }
  const re = globToRegex(p)
  let cur = t
  for (;;) {
    if (re.test(cur)) return true
    const i = cur.lastIndexOf('/')
    if (i < 0) return false
    let parent = i === 0 ? '/' : cur.slice(0, i)
    if (/^[a-z]:$/i.test(parent)) parent += '/'
    if (parent === cur) return false
    cur = parent
  }
}

/** Specificity: literal prefix length, then segment count (design r2 §Resolution 4). */
export function folderPatternSpecificity(pattern: string, platform: Platform = process.platform): [number, number] {
  const p = norm(pattern, platform)
  const g = firstGlobIndex(p)
  return [g === -1 ? p.length : g, p.split('/').filter(Boolean).length]
}

/** Expand a leading `~` against `home`. */
export function expandHome(p: string, home: string): string {
  if (p === '~') return home
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2))
  return p
}

// ---------------------------------------------------------------------------
// Entry forms — the #1334 trust semantics, applied to map entries.
// ---------------------------------------------------------------------------

/**
 * The spellings of a stored entry a check accepts. The checked folder is
 * always compared in its canonical form only.
 *
 * Fails CLOSED (the #1334 trust rule; this module is now its single home): a
 * stored entry is compared exactly as written — made absolute, `.`/`..`
 * normalised, never resolved on disk. Resolving it at compare time, or even
 * its parent, would follow a symlink planted after the decision was recorded
 * (a trusted folder, or its parent, swapped for a link elsewhere) and apply
 * the decision to wherever it now points (#778).
 *
 * `~` is the user's home, not a stored path, so it expands against both the
 * home as given and its canonical form (a symlinked home, /var vs
 * /private/var). Nothing after `~` is resolved.
 *
 * `lax` (used only for `off`, where matching MORE is the safe direction) also
 * accepts the entry with its parent, or all of it, canonicalised.
 */
function entryForms(entryPath: string, home: string, lax: boolean): string[] {
  const homes = entryPath === '~' || entryPath.startsWith('~/') || entryPath.startsWith('~\\')
    ? [...new Set([home, canonicalize(home)])]
    : [home]
  const forms = new Set<string>()
  for (const h of homes) {
    const expanded = expandHome(entryPath, h)
    const g = firstGlobIndex(expanded)
    let literal: string
    let tail: string
    if (g === -1) {
      literal = resolve(expanded)
      tail = ''
    } else {
      const cut = Math.max(expanded.lastIndexOf('/', g), expanded.lastIndexOf(sep, g))
      if (cut <= 0) { forms.add(expanded); continue }
      literal = resolve(expanded.slice(0, cut))
      tail = expanded.slice(cut)
    }
    forms.add(literal + tail)
    if (lax) {
      const parent = dirname(literal)
      // Both canonical spellings (#1357): the case-folded one and the
      // case-preserving one, so folding case never drops an `off` match.
      if (parent !== literal) for (const c of canonicalSpellings(parent)) forms.add(join(c, basename(literal)) + tail)
      for (const c of canonicalSpellings(literal)) forms.add(c + tail)
    }
  }
  return [...forms]
}

function entryCovers(entry: FolderEntry, targets: string[], home: string, lax: boolean): boolean {
  const forms = entryForms(entry.path, home, lax)
  return forms.some(f => targets.some(t => folderPatternMatches(f, t)))
}

function mostSpecific(entries: Array<{ e: FolderEntry; i: number }>, home: string): FolderEntry | undefined {
  let best: { e: FolderEntry; i: number; s: [number, number] } | undefined
  for (const c of entries) {
    const s = folderPatternSpecificity(entryForms(c.e.path, home, false)[0])
    if (!best || s[0] > best.s[0] || (s[0] === best.s[0] && s[1] > best.s[1]) ||
        (s[0] === best.s[0] && s[1] === best.s[1] && c.i > best.i)) {
      best = { ...c, s }
    }
  }
  return best?.e
}

// ---------------------------------------------------------------------------
// Load / save, and the one-time trust.yaml import.
// ---------------------------------------------------------------------------

const warned = new Set<string>()
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return
  warned.add(key)
  logger.warning(msg)
}

interface LoadResult { map: FolderMap; malformed: boolean }

function readMapFile(root: string): LoadResult | null {
  const file = folderMapPath(root)
  if (!existsSync(file)) return null
  try {
    const raw = yaml.load(readFileSync(file, 'utf8').replace(/^﻿/, ''))
    if (raw === null || raw === undefined) return { map: { version: 1, folders: [] }, malformed: false }
    const parsed = FolderMapSchema.safeParse(raw)
    if (!parsed.success) throw new Error(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '))
    return { map: { version: 1, folders: (parsed.data.folders ?? []) as FolderEntry[] }, malformed: false }
  } catch (err) {
    warnOnce(`malformed:${file}`, `[plur:folders] cannot read ${file}: ${(err as Error).message} — treating it as empty (folders fall back to ask)`)
    return { map: { version: 1, folders: [] }, malformed: true }
  }
}

/** Read the pre-#1347 `trust.yaml` list. Never writes it. */
export function readLegacyTrustEntries(root: string): string[] {
  const file = legacyTrustPath(root)
  if (!existsSync(file)) return []
  try {
    const raw = yaml.load(readFileSync(file, 'utf8')) as { trusted?: unknown } | null | undefined
    return Array.isArray(raw?.trusted) ? raw!.trusted.filter((t): t is string => typeof t === 'string') : []
  } catch (err) {
    warnOnce(`trust:${file}`, `[plur:trust] cannot parse ${file}: ${(err as Error).message} — treating as no trusted directories`)
    return []
  }
}

/**
 * Serialise every read-modify-write of folders.yaml, trust.yaml and the nonce
 * files (audit follow-up: 12 parallel `plur folders set` all reported success
 * and 5 were saved). One lock file, `folders.yaml.lock`, covers all of them,
 * so a dual-written grant or revocation is never interleaved with another.
 * Reentrant within a process (these functions are synchronous and call each
 * other); across processes it is core's O_EXCL `withLock`.
 */
let lockHeld = false
/** Run `fn` holding the folder-map lock (reentrant). */
export function withFolderMapLock<T>(root: string, fn: () => T): T {
  return locked(root, fn)
}

function locked<T>(root: string, fn: () => T): T {
  if (lockHeld) return fn()
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  return withLock(folderMapPath(root), () => {
    lockHeld = true
    try { return fn() } finally { lockHeld = false }
  }, { maxRetries: 12, baseDelay: 25 })
}

function load(root: string): LoadResult {
  const existing = readMapFile(root)
  if (existing) return existing
  // First read: import trust.yaml once, entries kept exactly as written.
  // trust.yaml itself is kept in step by the dual-write, not by the import.
  const legacy = readLegacyTrustEntries(root)
  const map: FolderMap = { version: 1, folders: legacy.map(path => ({ path, trusted: true })) }
  if (legacy.length > 0) {
    try {
      // Under the lock, and only if nobody created folders.yaml meanwhile:
      // an import must never overwrite a concurrent writer's map.
      return locked(root, () => {
        const now = readMapFile(root)
        if (now) return now
        saveFolderMap(root, map)
        return { map, malformed: false }
      })
    } catch (err) {
      warnOnce(`import:${root}`, `[plur:folders] could not write ${folderMapPath(root)} while importing trust.yaml: ${(err as Error).message} — using the imported entries in memory`)
    }
  }
  return { map, malformed: false }
}

/**
 * Load the folder map. A missing file is empty (after importing any
 * trust.yaml entries); a malformed one is empty with one warning. Never throws.
 */
export function loadFolderMap(root: string): FolderMap {
  return load(root).map
}

/** Write the folder map. Throws on I/O errors — only CLI writes call this. */
export function saveFolderMap(root: string, map: FolderMap): void {
  const body = yaml.dump({ version: 1, folders: map.folders.map(cleanEntry) }, { lineWidth: 120, noRefs: true })
  atomicWrite(folderMapPath(root), body, { mode: 0o600 })
}

function cleanEntry(e: FolderEntry): FolderEntry {
  const out: FolderEntry = { ...e }
  for (const k of ['plur', 'scope', 'trusted'] as const) if (out[k] === undefined) delete out[k]
  return out
}

// ---------------------------------------------------------------------------
// Project markers (mirror of the CLI's isPlurConfigured walk).
// ---------------------------------------------------------------------------

function configHasPlur(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const servers = (parsed as { mcpServers?: Record<string, unknown> } | null)?.mcpServers
    return !!servers && typeof servers === 'object' && Object.prototype.hasOwnProperty.call(servers, 'plur')
  } catch {
    return false
  }
}

/**
 * The first project marker walking up from `cwd` — the same walk, order and
 * home rule as `isPlurConfigured` in packages/cli/src/lib/plur-configured.ts
 * (kept there without a core import so the lightweight hooks stay cheap; a
 * parity test holds the two together). `null` when there is none.
 */
export function findPlurMarker(cwd: string, home: string = homedir()): 'mcp-config' | 'plur-yaml' | null {
  const start = canonicalize(cwd)
  const homeResolved = canonicalize(home)
  let dir = start
  for (;;) {
    const atHome = dir === homeResolved
    if (!atHome || start === homeResolved) {
      if (configHasPlur(join(dir, '.mcp.json'))) return 'mcp-config'
      if (configHasPlur(join(dir, '.claude', 'settings.json'))) return 'mcp-config'
      if (configHasPlur(join(dir, '.claude', 'settings.local.json'))) return 'mcp-config'
      if (configHasPlur(join(dir, '.cursor', 'mcp.json'))) return 'mcp-config'
      if (existsSync(join(dir, '.plur.yaml'))) return 'plur-yaml'
    }
    if (atHome) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------

export interface FolderPolicyOptions {
  /** PLUR home (`Plur.paths.root`). */
  root: string
  /** Defaults to `os.homedir()`. */
  home?: string
}

/** True when a `trusted: true` entry covers `dir` (canonical target, #1334 entry forms). */
export function isTrustedInMap(entries: FolderEntry[], dir: string, home: string = homedir()): boolean {
  const target = [canonicalize(dir)]
  return entries.some(e => e.trusted === true && entryCovers(e, target, home, false))
}

/**
 * Decide what PLUR does in `dir` (design r2 §Resolution, with owner decision
 * D1 "ignore-ask", 2026-09-29, matching #1228's E3):
 *  1. any matching `off` entry → off;
 *  2. a `.plur.yaml`:
 *     - TRUSTED (a covering `trusted: true` entry), or requesting nothing →
 *       on, exactly as before; a map `scope` beats its hint; its remote only
 *       when trusted;
 *     - UNTRUSTED and requesting a scope, domain or remote → its hints are
 *       ignored. A map decision for the folder applies (step 4); otherwise
 *       ask, with `reason: 'untrusted-plur-yaml'` and what it `requested`.
 *       The ask flow's "yes" writes `trusted: true` (plus a scope if chosen);
 *  3. a project MCP config → on;
 *  4. the most specific matching map entry;
 *  5. otherwise ask (including `$HOME`).
 */
export function resolveFolderPolicy(dir: string, opts: FolderPolicyOptions): FolderPolicy {
  const home = opts.home ?? homedir()
  const entries = loadFolderMap(opts.root).folders
  const strict = [canonicalize(dir)]
  const lax = [...new Set([strict[0], ...canonicalSpellings(dir), resolve(dir)])]

  if (entries.some(e => e.plur === 'off' && entryCovers(e, lax, home, true))) {
    return { mode: 'off', remoteAllowed: false, source: 'map' }
  }

  const matching = entries.map((e, i) => ({ e, i })).filter(c => entryCovers(c.e, strict, home, false))
  const mapScope = mostSpecific(matching.filter(c => c.e.scope), home)?.scope

  const configPath = findProjectConfigPath(dir)
  const marker = configPath ? 'plur-yaml' : findPlurMarker(dir, home)
  const deciding = matching.filter(c => c.e.plur !== undefined || c.e.scope !== undefined || c.e.trusted === true)
  const config = readProjectConfigFromPath(configPath)
  const requests = !!(config.scope || config.domain || config.remote_url)
  const untrustedRequest = configPath !== null && requests &&
    !isTrustedInMap(entries, dirname(configPath), home)
  if (untrustedRequest && deciding.length === 0) {
    return {
      mode: 'ask', remoteAllowed: false, source: 'plur-yaml', reason: 'untrusted-plur-yaml',
      requested: {
        ...(config.scope ? { scope: config.scope } : {}),
        ...(config.domain ? { domain: config.domain } : {}),
        ...(config.remote_url ? { remote_url: config.remote_url } : {}),
      },
    }
  }
  if (marker && !untrustedRequest) {
    const remote = resolveProjectRemoteFromConfig(
      { isDirectoryTrusted: d => isTrustedInMap(entries, d, home) }, config, configPath,
    )
    const scope = mapScope ?? config.scope
    return {
      mode: 'on',
      ...(scope ? { scope } : {}),
      remoteAllowed: remote.remoteProject !== null,
      source: marker,
    }
  }

  const best = mostSpecific(deciding, home)
  if (best) {
    const mode = best.plur ?? 'on'
    return { mode, ...(mode === 'on' && mapScope ? { scope: mapScope } : {}), remoteAllowed: false, source: 'map' }
  }
  return { mode: 'ask', remoteAllowed: false, source: 'default' }
}

// ---------------------------------------------------------------------------
// Writes (CLI only): set / remove, with the nonce and shared-scope guards.
// ---------------------------------------------------------------------------

export type FolderMapErrorCode = 'malformed' | 'nonce-required' | 'nonce-unknown' | 'nonce-expired' | 'nonce-folder' | 'scope-unconfigured' | 'invalid'

export class FolderMapError extends Error {
  constructor(public readonly code: FolderMapErrorCode, message: string) {
    super(message)
    this.name = 'FolderMapError'
  }
}

export interface FolderChange {
  mode?: FolderMode
  scope?: string
  /** true sets `trusted`, false clears it. */
  trusted?: boolean
}

export interface SetFolderOptions {
  /** Scopes of the stores configured in config.yaml — a shared scope must be one of them. */
  configuredScopes: string[]
  /** Present when the write comes from the ask flow. */
  nonce?: string
  home?: string
  now?: number
}

function hasGlob(p: string): boolean {
  return firstGlobIndex(p) !== -1
}

/** The path a CLI write records: literal folders are canonicalised, globs kept as typed. */
export function folderEntryKey(folder: string, home: string = homedir()): string {
  return hasGlob(folder) ? folder : canonicalize(expandHome(folder, home))
}

function entryIsFolder(e: FolderEntry, folder: string, raw: string, target: string, home: string): boolean {
  return e.path === folder ||
    (!hasGlob(e.path) && (resolve(expandHome(e.path, home)) === raw || entryForms(e.path, home, false).includes(target)))
}

/**
 * True when stored entry form `form` names the folder `target` (canonical,
 * existing) and differs from it only in letter case (#1357).
 *
 * Every path component that differs is checked for IDENTITY, not existence:
 * under the target's canonical parent, the target's component and the
 * entry's own spelling of it must be the same directory entry (same device
 * and inode, by lstat). On a case-sensitive filesystem `Proj` and `pROJ` —
 * or `Ⓟ` and `ⓟ`, which are cased but not letters — can be two sibling
 * folders, and treating one's entry as the other's would move an `off` or a
 * trust grant to the wrong folder. lstat does not follow a symlink, so a
 * link at the entry's spelling has its own inode and never matches, and the
 * parent is the target's canonical one: the stored entry is never resolved
 * through a link (#778). Device and inode are compared as bigints (a 64-bit
 * NTFS file id can exceed 2^53). Any error: false.
 */
function sameFolderIgnoringCase(form: string, target: string): boolean {
  if (form === target || form.toLowerCase() !== target.toLowerCase()) return false
  const a = form.split(sep)
  const b = target.split(sep)
  if (a.length !== b.length) return false
  for (let i = 0; i < b.length; i++) {
    if (a[i] === b[i]) continue
    const prefix = b.slice(0, i)
    try {
      const x = lstatSync([...prefix, b[i]].join(sep) || sep, { bigint: true })
      const y = lstatSync([...prefix, a[i]].join(sep) || sep, { bigint: true })
      if (x.dev !== y.dev || x.ino !== y.ino) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * The entry a CLI edit of `folder` refers to. After #1357 a checked folder is
 * canonical in its ON-DISK case, so an entry recorded in another case (by hand,
 * or before #1357 from a mis-cased typed path) no longer equals it. On a
 * case-insensitive filesystem such an entry is still this folder's entry, so
 * an edit or removal must find it rather than add a second entry beside it.
 * Compared as written apart from letter case — never resolved on disk.
 */
function findEntryIndex(entries: FolderEntry[], folder: string, home: string): { applied: number[]; nameOnly: number[] } {
  if (hasGlob(folder)) return { applied: entries.flatMap((e, i) => (e.path === folder ? [i] : [])), nameOnly: [] }
  const raw = resolve(expandHome(folder, home))
  const target = canonicalize(raw)
  // EVERY entry for this folder, not just the first: a second entry would
  // keep a decision the user just changed (a revoked grant, a replaced `off`).
  //
  // `applied`: the entry covers the canonical target under the strict,
  // fail-closed comparison, so its `trusted` and `scope` are in effect now.
  // `nameOnly`: the entry names the folder only by another spelling — as
  // typed, through a symlink, or in another letter case (identity-checked,
  // #1357). The strict comparison never matched it, so its grant and scope
  // never applied; only an `off` did, through the loose match `off` uses.
  const applied: number[] = []
  const nameOnly: number[] = []
  entries.forEach((e, i) => {
    if (!hasGlob(e.path) && entryForms(e.path, home, false).includes(target)) applied.push(i)
    else if (entryIsFolder(e, folder, raw, target, home) ||
      (!hasGlob(e.path) && entryForms(e.path, home, false).some(f => sameFolderIgnoringCase(f, target)))) nameOnly.push(i)
  })
  return { applied, nameOnly }
}

/** The most restrictive of the modes: off, then ask, then on. */
function mostRestrictive(modes: Array<FolderMode | undefined>): FolderMode | undefined {
  for (const m of ['off', 'ask', 'on'] as const) if (modes.includes(m)) return m
  return undefined
}

function loadForWrite(root: string): FolderMap {
  const r = load(root)
  if (r.malformed) {
    throw new FolderMapError('malformed', `${folderMapPath(root)} could not be read; fix or remove it before writing (nothing was changed).`)
  }
  return r.map
}

/**
 * Create or update the entry for `folder` (under the folder-map lock). See
 * setFolderEntryUnlocked for the rules.
 */
export function setFolderEntry(root: string, folder: string, change: FolderChange, opts: SetFolderOptions): FolderEntry {
  return locked(root, () => setFolderEntryUnlocked(root, folder, change, opts))
}

/**
 * Create or update the entry for `folder`. `mode`/`scope` set the decision;
 * `--scope` alone means on (the `plur` field is dropped so it defaults to on).
 * Returns the entry as written.
 */
function setFolderEntryUnlocked(root: string, folder: string, change: FolderChange, opts: SetFolderOptions): FolderEntry {
  const home = opts.home ?? homedir()
  if (change.mode === undefined && change.scope === undefined && change.trusted === undefined) {
    throw new FolderMapError('invalid', 'Nothing to set: pass --scope <s>, --on, --off, --ask, --trusted or --no-trusted.')
  }
  // A team scope that is meant to reach a store (group:, org:, team:, ...)
  // must name one that is configured, or a typo silently stays local.
  // project:* lives in the local store (isLocalOnlyScope), so it needs none.
  if (change.scope !== undefined && isSharedScope(change.scope) && !isLocalOnlyScope(change.scope) &&
      !opts.configuredScopes.includes(change.scope)) {
    throw new FolderMapError('scope-unconfigured',
      `"${change.scope}" is a team scope with no store configured in config.yaml, so memories would stay local. ` +
      `Add the store first (plur stores add / plur scopes register), then retry.`)
  }
  // Refuse a malformed map and check the nonce first, but CONSUME the nonce
  // only after the map is saved: a refused or failed write never burns it.
  const map = loadForWrite(root)
  const consume = opts.nonce !== undefined ? verifyFolderNonce(root, opts.nonce, folder, opts.now) : null
  const key = folderEntryKey(folder, home)
  const { applied, nameOnly } = findEntryIndex(map.folders, folder, home)
  // Every entry for this folder merges into ONE, which keeps exactly what is
  // in effect now, except what this change sets:
  //  - path, `trusted` and `scope` come ONLY from entries that applied. The
  //    scope is the one the resolver picks among them (`mostSpecific`), so a
  //    merge never reroutes writes; the grant is kept when any applied entry
  //    had one, as `isTrustedInMap` does. With none, the path is the canonical
  //    key and there is no grant or scope.
  //  - entries matched only by name (typed spelling, symlink, letter case)
  //    contribute their mode at most. Their grant and scope never applied,
  //    and a merge must not bring them to life (#778, #1357).
  //  - the mode is the most restrictive of the applied modes and the
  //    name-only `off`/`ask` (never a name-only `on`); a mode this change sets
  //    wins, and `--scope` without a mode means `on` — also when it replaces a
  //    merged `off`.
  const appliedEntries = applied.map(i => ({ e: map.folders[i], i }))
  const entry: FolderEntry = { path: appliedEntries[0]?.e.path ?? key }
  if (appliedEntries.some(c => c.e.trusted === true)) entry.trusted = true
  const scope = mostSpecific(appliedEntries.filter(c => c.e.scope !== undefined), home)?.scope
  if (scope !== undefined) entry.scope = scope
  // A name-only entry can only make the mode MORE restrictive: its `on` never
  // applied (only `off` matches loosely), so it must not become the mode.
  const mode = mostRestrictive([
    ...applied.map(i => map.folders[i].plur),
    ...nameOnly.map(i => map.folders[i].plur).filter(m => m !== 'on'),
  ])
  if (mode !== undefined) entry.plur = mode
  if (change.scope !== undefined) {
    entry.scope = change.scope
    if (change.mode === undefined) delete entry.plur
  }
  if (change.mode !== undefined) entry.plur = change.mode
  if (change.trusted === true) entry.trusted = true
  if (change.trusted === false) delete entry.trusted
  const matched = [...applied, ...nameOnly]
  if (matched.length) {
    const at = Math.min(...matched)
    map.folders = map.folders.flatMap((e, i) => (i === at ? [entry] : matched.includes(i) ? [] : [e]))
  } else map.folders.push(entry)
  saveFolderMap(root, map)
  // Decision F3: the nonce is used up as soon as the map is saved — the
  // decision it authorised is now recorded — and BEFORE the trust.yaml write.
  // If that write then fails, the caller sees the error and a retry needs a
  // fresh ask; the nonce is never left valid for a second use.
  consume?.()
  // Dual-write (see addLegacyTrustEntry): keep trust.yaml in step for
  // adapters on the previous core.
  if (change.trusted === true && !hasGlob(entry.path)) addLegacyTrustEntryUnlocked(root, entry.path)
  if (change.trusted === false) removeLegacyTrustEntryUnlocked(root, folder, home)
  return cleanEntry(entry)
}

/**
 * Remove the entry for `folder` (exact entry, not a covering one). Returns
 * whether one was removed. A `nonce` (from the ask flow) is checked like
 * `setFolderEntry`'s and consumed only when an entry was removed and saved.
 */
export function removeFolderEntry(
  root: string, folder: string, home: string = homedir(), opts?: { nonce?: string; now?: number },
): boolean {
  return locked(root, () => removeFolderEntryUnlocked(root, folder, home, opts))
}

function removeFolderEntryUnlocked(
  root: string, folder: string, home: string, opts?: { nonce?: string; now?: number },
): boolean {
  const map = loadForWrite(root)
  const consume = opts?.nonce !== undefined ? verifyFolderNonce(root, opts.nonce, folder, opts.now) : null
  const { applied, nameOnly } = findEntryIndex(map.folders, folder, home)
  const matched = [...applied, ...nameOnly]
  if (matched.length === 0) return false
  const removedEntries = map.folders.filter((_, i) => matched.includes(i))
  map.folders = map.folders.filter((_, i) => !matched.includes(i))
  saveFolderMap(root, map)
  consume?.()   // F3: consumed once the map is saved, before trust.yaml
  // Decision F2: removing a trusted entry is a revocation, so it is completed
  // in trust.yaml too (never an addition).
  for (const removed of removedEntries) {
    if (removed.trusted === true) removeLegacyTrustEntryUnlocked(root, removed.path, home)
  }
  return true
}

/**
 * Clear `trusted` on the exact entry for `folder`; an entry left with no
 * decision is removed. Returns whether a grant was removed.
 */
export function clearFolderTrust(root: string, folder: string, home: string = homedir()): boolean {
  return locked(root, () => clearFolderTrustUnlocked(root, folder, home))
}

function clearFolderTrustUnlocked(root: string, folder: string, home: string): boolean {
  const map = loadForWrite(root)
  let changed = false
  const raw = resolve(expandHome(folder, home))
  const target = canonicalize(raw)
  map.folders = map.folders.filter(e => {
    // Also an entry for this folder recorded in another letter case, checked
    // for identity like findEntryIndex's fallback (#1357). Its grant never
    // applied, but `plur untrust` must still clear it and say so.
    const hit = e.trusted === true && (entryIsFolder(e, folder, raw, target, home) ||
      (!hasGlob(e.path) && entryForms(e.path, home, false).some(f => sameFolderIgnoringCase(f, target))))
    if (!hit) return true
    changed = true
    delete e.trusted
    return e.plur !== undefined || e.scope !== undefined
  })
  if (changed) saveFolderMap(root, map)
  return changed
}

/**
 * DUAL-WRITE (audit follow-up, adversarial M1 / data-loss F7). While any
 * published adapter still reads trust.yaml — the opencode plugin pins the
 * pre-folder-map core — every grant is also recorded there, in that file's own
 * format, and every revocation removes it there (removeLegacyTrustEntry).
 * Because revocations land in both files, a downgrade or a re-import cannot
 * resurrect a revoked grant. Globs are not written: the old reader matches
 * literal folders only. Drop the dual-write once every adapter is on this core.
 */
function addLegacyTrustEntryUnlocked(root: string, path: string): void {
  const entries = readLegacyTrustEntries(root)
  if (entries.includes(path)) return
  atomicWrite(legacyTrustPath(root), yaml.dump({ version: 1, trusted: [...entries, path].sort() }))
}

function nativeRealpath(p: string): string | null {
  try { return realpathSync.native(p) } catch { return null }
}

/**
 * Whether a trust.yaml `line` names the same folder as `folder`, for a
 * REVOCATION (decision F2). It uses the map's own matcher: `~` expands against
 * the home (as given and canonical), both spellings are normalised the way the
 * map compares paths (case-folded on win32), and each side is also compared
 * in its canonical and on-disk forms, so a differently-cased line on a
 * case-insensitive filesystem goes too. Matching wide is the safe direction
 * here: this only ever REMOVES a grant.
 */
function namesSameFolder(line: string, folder: string, home: string): boolean {
  if (hasGlob(line)) return false
  const f = expandHome(folder, home)
  const targets = [resolve(f), canonicalize(f), nativeRealpath(f)].filter((x): x is string => !!x)
  const forms = entryForms(line, home, true)
  for (const form of [...forms]) {
    const n = nativeRealpath(form)
    if (n) forms.push(n)
  }
  return forms.some(a => targets.some(b => norm(a, process.platform) === norm(b, process.platform)))
}

/**
 * Remove the grant for `folder` from the pre-#1347 `trust.yaml`, if it lists
 * one (the stored string, its plain spelling, or its canonical form). Without
 * this, a downgrade (an older CLI or MCP reading trust.yaml) or a re-import
 * after folders.yaml is deleted would bring a revoked grant back. Removal is
 * fail-safe. Returns whether an entry was removed. Throws on a write error so a revocation never silently half-applies.
 */
export function removeLegacyTrustEntry(root: string, folder: string, home: string = homedir()): boolean {
  return locked(root, () => removeLegacyTrustEntryUnlocked(root, folder, home))
}

function removeLegacyTrustEntryUnlocked(root: string, folder: string, home: string): boolean {
  const file = legacyTrustPath(root)
  if (!existsSync(file)) return false
  const entries = readLegacyTrustEntries(root)
  const kept = entries.filter(t => !namesSameFolder(t, folder, home))
  if (kept.length === entries.length) return false
  atomicWrite(file, yaml.dump({ version: 1, trusted: kept }))
  return true
}

// ---------------------------------------------------------------------------
// Nonces for writes from the ask flow.
// ---------------------------------------------------------------------------

/** How long an unconsumed nonce lives if its session never reports its end. */
export const FOLDER_NONCE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Same mapping as packages/cli/src/lib/session-key.ts `safeSessionKey`
 * (copied, not imported: the CLI's hooks load that file without core). A
 * parity test holds the two together.
 */
export function safeSessionKey(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_')
  return safe || 'unknown'
}

interface NonceRecord { nonce: string; folder: string; issued_at: number }
interface NonceFile { session: string; nonces: NonceRecord[] }

function nonceDir(root: string): string {
  return join(root, 'folder-nonces')
}

function nonceFile(root: string, sessionId: string): string {
  return join(nonceDir(root), `${safeSessionKey(sessionId)}.yaml`)
}

function readNonceFile(file: string): NonceFile | null {
  try {
    const raw = yaml.load(readFileSync(file, 'utf8')) as NonceFile | null
    if (!raw || !Array.isArray(raw.nonces)) return null
    return raw
  } catch {
    return null
  }
}

function writeNonceFile(file: string, data: NonceFile): void {
  if (data.nonces.length === 0) { rmSync(file, { force: true }); return }
  atomicWrite(file, yaml.dump(data), { mode: 0o600 })
}

/**
 * Issue a single-use nonce that lets the ask flow of `sessionId` record a
 * decision for exactly `folder`.
 */
export function issueFolderNonce(root: string, sessionId: string, folder: string, now: number = Date.now()): string {
  return locked(root, () => issueFolderNonceUnlocked(root, sessionId, folder, now))
}

function issueFolderNonceUnlocked(root: string, sessionId: string, folder: string, now: number): string {
  mkdirSync(nonceDir(root), { recursive: true, mode: 0o700 })
  const file = nonceFile(root, sessionId)
  const data = readNonceFile(file) ?? { session: safeSessionKey(sessionId), nonces: [] }
  const nonce = randomBytes(16).toString('hex')
  data.nonces.push({ nonce, folder: canonicalize(folder), issued_at: now })
  writeNonceFile(file, data)
  return nonce
}

/** Drop every nonce of `sessionId` — called when the session ends. */
export function endFolderNonceSession(root: string, sessionId: string): void {
  rmSync(nonceFile(root, sessionId), { force: true })
}

/**
 * Verify and consume `nonce` for `folder` in one step. See verifyFolderNonce.
 */
export function consumeFolderNonce(root: string, nonce: string, folder: string, now: number = Date.now()): void {
  locked(root, () => verifyFolderNonce(root, nonce, folder, now)())
}

/**
 * Verify `nonce` for `folder` and return the function that consumes it.
 * Writers call that only after their write succeeded, so a failed write never
 * burns the nonce. Throws a FolderMapError when the nonce is unknown (never
 * issued, already used, or its session ended), expired (removed on the spot),
 * or was issued for a different folder (left in place).
 */
export function verifyFolderNonce(root: string, nonce: string, folder: string, now: number = Date.now()): () => void {
  const dir = nonceDir(root)
  let files: string[] = []
  try { files = readdirSync(dir).filter(f => f.endsWith('.yaml')) } catch { /* no nonces issued */ }
  for (const f of files) {
    const file = join(dir, f)
    const data = readNonceFile(file)
    if (!data) continue
    const idx = data.nonces.findIndex(r => r.nonce === nonce)
    if (idx < 0) continue
    const rec = data.nonces[idx]
    if (now - rec.issued_at > FOLDER_NONCE_TTL_MS) {
      data.nonces.splice(idx, 1)
      writeNonceFile(file, data)
      throw new FolderMapError('nonce-expired', 'That nonce has expired; nothing was changed.')
    }
    if (rec.folder !== canonicalize(folder)) {
      throw new FolderMapError('nonce-folder', `That nonce was issued for ${rec.folder}, not ${canonicalize(folder)}; nothing was changed.`)
    }
    return () => {
      // Re-read: another writer may have changed this session's file since.
      const fresh = readNonceFile(file)
      if (!fresh) return
      const j = fresh.nonces.findIndex(r => r.nonce === nonce)
      if (j < 0) return
      fresh.nonces.splice(j, 1)
      writeNonceFile(file, fresh)
    }
  }
  throw new FolderMapError('nonce-unknown', 'Unknown or already-used nonce; nothing was changed.')
}
