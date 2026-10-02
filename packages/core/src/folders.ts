import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, lstatSync, realpathSync, writeFileSync } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import yaml from 'js-yaml'
import { checkFolderMapText, describeFolderMapIssues, planFolderMapRepair, type FolderMapIssue } from './folder-map-check.js'
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
  /**
   * The path is a literal folder even though it contains `*` or `?` (a folder
   * really named `proj?`): it is never read as a glob (#1415 review).
   */
  literal?: boolean
}

export interface FolderMap {
  version: 1
  folders: FolderEntry[]
}

/** Where a policy decision came from. */
/** Where and why the folder map cannot be used (#1526). */
export interface FolderMapFault {
  file: string
  line?: number
  column?: number
  /** Plain words, e.g. "line 4: indentation — `plur:` is indented 5 spaces, expected 4 (…)". */
  problem?: string
  /** True when `plur folders repair` can fix it. */
  fixable?: boolean
}

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
  reason?: 'untrusted-plur-yaml' | 'malformed-map' | 'resolver-error'
  /**
   * For `malformed-map`: the folder map that could not be read, the line and
   * column of the problem when there is one (1-based), the problem in plain
   * words (it quotes at most the key on that line, #1526), and whether
   * `plur folders repair` can fix it. The decision fails SAFE: the folder is
   * `ask` — no memory — until the file is fixed (audit F4 of #1517, owner
   * decision), never `on` because a project marker is there.
   */
  mapError?: FolderMapFault
  /** What that `.plur.yaml` requests, for the question. Never the token. */
  requested?: { scope?: string; domain?: string; remote_url?: string }
}

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
export function folderPatternMatches(pattern: string, target: string, platform: Platform = process.platform, literal = false): boolean {
  const p = norm(pattern, platform)
  const t = norm(target, platform)
  if (literal || firstGlobIndex(p) === -1) {
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
export function folderPatternSpecificity(pattern: string, platform: Platform = process.platform, literal = false): [number, number] {
  const p = norm(pattern, platform)
  const g = literal ? -1 : firstGlobIndex(p)
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
function entryForms(entryPath: string, home: string, lax: boolean, literalPath = false): string[] {
  const homes = entryPath === '~' || entryPath.startsWith('~/') || entryPath.startsWith('~\\')
    ? [...new Set([home, canonicalize(home)])]
    : [home]
  const forms = new Set<string>()
  for (const h of homes) {
    const expanded = expandHome(entryPath, h)
    const g = literalPath ? -1 : firstGlobIndex(expanded)
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
  const lit = entry.literal === true
  const forms = entryForms(entry.path, home, lax, lit)
  return forms.some(f => targets.some(t => folderPatternMatches(f, t, process.platform, lit)))
}

/** True when the entry's path is read as a glob. */
function entryIsGlob(e: FolderEntry): boolean {
  return e.literal !== true && hasGlob(e.path)
}

function mostSpecific(entries: Array<{ e: FolderEntry; i: number }>, home: string): FolderEntry | undefined {
  let best: { e: FolderEntry; i: number; s: [number, number] } | undefined
  for (const c of entries) {
    const lit = c.e.literal === true
    const s = folderPatternSpecificity(entryForms(c.e.path, home, false, lit)[0], process.platform, lit)
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

interface LoadResult { map: FolderMap; malformed: boolean; error?: Omit<FolderMapFault, 'file'> }

/** The problem with a folders.yaml's text, or its map (#1526: strict, pinpointed). */
function parseMapText(text: string): { map: FolderMap } | { issues: FolderMapIssue[] } {
  const check = checkFolderMapText(text)
  if (!check.ok) return { issues: check.issues }
  const folders = (check.raw.folders ?? []) as FolderEntry[]
  return { map: { version: 1, folders } }
}

/** A broken map's error: the first problem, located, and whether repair can fix the file. */
function mapErrorOf(text: string, issues: FolderMapIssue[]): Omit<FolderMapFault, 'file'> {
  const first = issues[0]
  let fixable = false
  try { fixable = planFolderMapRepair(text).status === 'fixable' } catch { /* not fixable */ }
  return {
    ...(first.line !== undefined ? { line: first.line } : {}),
    ...(first.column !== undefined ? { column: first.column } : {}),
    problem: describeFolderMapIssues(issues),
    fixable,
  }
}

/**
 * Read folders.yaml: null when absent, else the map or why it cannot be used.
 * Absent means ENOENT on the path itself, nothing else. existsSync() also
 * answers false for a dangling symlink, a symlink loop or a parent that
 * cannot be searched — each of those is a map that cannot be read.
 */
function readMapText(file: string): null | { text: string } | { unreadable: string } {
  try {
    lstatSync(file)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    return { unreadable: `cannot be read (${code ?? (err as Error).message})` }
  }
  try {
    return { text: readFileSync(file, 'utf8') }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    const link = (() => { try { return lstatSync(file).isSymbolicLink() } catch { return false } })()
    return { unreadable: `cannot be read (${code ?? (err as Error).message}${link ? ', it is a symlink whose target cannot be read' : ''})` }
  }
}

function readMapFile(root: string): LoadResult | null {
  const file = folderMapPath(root)
  const r = readMapText(file)
  if (r === null) return null
  if ('unreadable' in r) {
    warnOnce(`malformed:${file}`, `[plur:folders] ${file} ${r.unreadable} — treating it as empty (folders fall back to ask)`)
    return { map: { version: 1, folders: [] }, malformed: true, error: { problem: r.unreadable, fixable: false } }
  }
  const parsed = parseMapText(r.text)
  if ('map' in parsed) return { map: parsed.map, malformed: false }
  // The same cases the MCP gate refuses (#1519): an empty file and an unknown
  // top-level key count too, so the hooks and plugins agree with it (#1526).
  const error = mapErrorOf(r.text, parsed.issues)
  warnOnce(`malformed:${file}`, `[plur:folders] ${file} has a problem at ${error.problem} — treating it as empty (folders fall back to ask)`)
  return { map: { version: 1, folders: [] }, malformed: true, error }
}

/** What a broken folder map is, where, and whether `plur folders repair` can fix it (#1526). */
export interface FolderMapProblem extends FolderMapFault {
  /** The problem as a predicate on the file: "<file> <problem>". */
  problem: string
  fixable: boolean
}

/**
 * Why the folder map cannot be used, or null when it can (or does not exist).
 * Read-only: unlike {@link loadFolderMap} it never imports trust.yaml, so it
 * never writes folders.yaml. For callers that must fail safe on a broken map
 * (the MCP memory tools) instead of reading it as empty.
 *
 * Strict where the loader once was lenient: a map that says nothing is not
 * "no decisions" when the file exists, and an unknown top-level key (a typo
 * such as `folder:`) would otherwise drop every decision silently.
 */
export function folderMapProblem(root: string): FolderMapProblem | null {
  const file = folderMapPath(root)
  const r = readMapText(file)
  if (r === null) return null
  if ('unreadable' in r) return { file, problem: r.unreadable, fixable: false }
  const parsed = parseMapText(r.text)
  if ('map' in parsed) return null
  const error = mapErrorOf(r.text, parsed.issues)
  return { file, ...error, problem: `has a problem at ${error.problem}`, fixable: error.fixable === true }
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

/** What {@link repairFolderMap} found or did (#1526). */
export interface FolderMapRepairResult {
  /**
   * `absent`: no folders.yaml. `ok`: nothing to repair. `fixable`: a repair
   * is possible (dry run). `repaired`: written. `unfixable`: needs a hand fix,
   * nothing changed. `unreadable`: the file cannot be read (a dangling symlink,
   * a permission), nothing changed. `changed`: the file changed since the
   * caller's dry run, nothing written.
   */
  status: 'absent' | 'ok' | 'fixable' | 'repaired' | 'unfixable' | 'unreadable' | 'changed'
  file: string
  /** The text the plan was made from (pass it back as `expect`). */
  before?: string
  diff?: string
  fixes?: FolderMapIssue[]
  issues?: FolderMapIssue[]
  /** For `unreadable`: why. */
  problem?: string
  backup?: string
  /** After a write: the map re-checked from disk (null = it is fine now). */
  problemAfter?: FolderMapProblem | null
}

/** `20261002T090807Z`: the UTC time, for a backup's name. */
function utcStamp(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '')
}

/**
 * `plur folders repair` (#1526). Plans the repair of a broken folders.yaml
 * and, with `apply`, performs it under the folder-map lock: a backup
 * `folders.yaml.plur-backup-<UTC>` next to the file (the original bytes),
 * an atomic write of the repaired text (to the symlink's target when the map
 * is a symlink, so the link stays a link), then a re-check from disk.
 *
 * Only unambiguous fixes are made (see planFolderMapRepair); when any problem
 * needs a hand fix, nothing is written at all. `expect`, when given, must be
 * the text the caller showed the user (its dry run's `before`): if the file
 * changed since, nothing is written.
 */
export function repairFolderMap(root: string, opts: { apply: boolean; expect?: string; now?: Date }): FolderMapRepairResult {
  const file = folderMapPath(root)
  const plan = (): FolderMapRepairResult => {
    const r = readMapText(file)
    if (r === null) return { status: 'absent', file }
    if ('unreadable' in r) return { status: 'unreadable', file, problem: r.unreadable }
    const p = planFolderMapRepair(r.text)
    if (p.status === 'ok') return { status: 'ok', file, before: r.text }
    if (p.status === 'unfixable') return { status: 'unfixable', file, before: r.text, issues: p.issues }
    return { status: 'fixable', file, before: r.text, diff: p.diff, fixes: p.fixes }
  }
  if (!opts.apply) return plan()
  return locked(root, () => {
    const shown = plan()
    if (shown.status !== 'fixable') return shown
    if (opts.expect !== undefined && opts.expect !== shown.before) return { ...shown, status: 'changed' }
    const p = planFolderMapRepair(shown.before!)
    if (p.status !== 'fixable') return shown
    // The original bytes, private like the map; never overwrite an earlier
    // backup (two repairs in one second get -2, -3, …).
    const stem = `${file}.plur-backup-${utcStamp(opts.now ?? new Date())}`
    let backup = stem
    for (let n = 2; ; n++) {
      try {
        writeFileSync(backup, shown.before!, { mode: 0o600, flag: 'wx' })
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n > 99) throw err
        backup = `${stem}-${n}`
      }
    }
    let target = file
    try { if (lstatSync(file).isSymbolicLink()) target = realpathSync(file) } catch { /* write the path itself */ }
    atomicWrite(target, p.after, { mode: 0o600 })
    return { ...shown, status: 'repaired', backup, problemAfter: folderMapProblem(root) }
  })
}

function cleanEntry(e: FolderEntry): FolderEntry {
  const out: FolderEntry = { ...e }
  for (const k of ['plur', 'scope', 'trusted', 'literal'] as const) if (out[k] === undefined) delete out[k]
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

function findOffEntries(entries: FolderEntry[], dir: string, home: string): FolderEntry[] {
  const lax = [...new Set([canonicalize(dir), ...canonicalSpellings(dir), resolve(dir)])]
  return entries.filter(e => e.plur === 'off' && entryCovers(e, lax, home, true))
}

/**
 * Every map entry that turns PLUR off in `dir` (resolution step 1). A more
 * specific `on` entry never overrides an `off`, so turning the folder back on
 * means changing ALL of these, which may be parent folders or globs: callers
 * name them in their "how to turn it back on" text.
 */
export function folderOffEntries(dir: string, opts: FolderPolicyOptions): FolderEntry[] {
  return findOffEntries(loadFolderMap(opts.root).folders, dir, opts.home ?? homedir())
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
  const loaded = load(opts.root)
  if (loaded.malformed) {
    // Fail SAFE (audit F4 of #1517): an unreadable map could hold an `off`
    // for this folder, so nothing — not even a project marker — turns memory
    // on until it is fixed. `plur folders set` refuses to write it too.
    return {
      mode: 'ask', remoteAllowed: false, source: 'default', reason: 'malformed-map',
      mapError: { file: folderMapPath(opts.root), ...(loaded.error ?? {}) },
    }
  }
  const entries = loaded.map.folders
  const strict = [canonicalize(dir)]

  if (findOffEntries(entries, dir, home).length > 0) {
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

export type FolderMapErrorCode = 'malformed' | 'nonce-required' | 'nonce-unknown' | 'nonce-expired' | 'nonce-folder' | 'nonce-answer' | 'nonce-session' | 'scope-unconfigured' | 'invalid' | 'covers-home'

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

/**
 * The one answer a nonce authorises (#1378): a `set` (the same shape as the
 * FolderChange it will be compared with) or the removal of the entry.
 * `plur trust` is the answer `{ trusted: true }`. `folders set --no-trusted`
 * is `{ trusted: false }`; `plur untrust` needs no nonce (#1477 review).
 */
export type FolderAnswer = FolderChange | { remove: true }

/**
 * The comparable form of an answer. `--scope X` means on, so it equals
 * `--scope X --on`; everything else must match exactly, `trusted` included
 * (absent, true and false are three different answers).
 */
function answerKey(a: FolderAnswer | undefined | null): string | null {
  if (!a || typeof a !== 'object') return null
  if ('remove' in a) return a.remove === true ? 'remove' : null
  const mode = a.mode ?? (a.scope !== undefined ? 'on' : null)
  return JSON.stringify(['set', mode, a.scope ?? null, a.trusted ?? null])
}

function describeAnswer(a: FolderAnswer | undefined | null): string {
  if (!a || typeof a !== 'object') return 'no answer'
  if ('remove' in a) return 'removing the entry'
  const parts: string[] = []
  if (a.scope !== undefined) parts.push(`--scope ${a.scope}`)
  else if (a.mode !== undefined) parts.push(`--${a.mode}`)
  if (a.trusted === true) parts.push('--trusted')
  if (a.trusted === false) parts.push('--no-trusted')
  return parts.join(' ') || 'no answer'
}

export interface SetFolderOptions {
  /** Scopes of the stores configured in config.yaml — a shared scope must be one of them. */
  configuredScopes: string[]
  /** Present when the write comes from the ask flow. */
  nonce?: string
  /**
   * The session the redeeming command runs in, when its host says so
   * (PLUR_FOLDER_SESSION; audit F5 of #1517). Only that session's nonces are
   * consulted, and a session-bound nonce needs it.
   */
  session?: string
  home?: string
  now?: number
  /**
   * Record `folder` as a literal folder even when its name contains `*` or
   * `?` (`plur remote` records the current folder this way). Without it such
   * a path is stored as a glob, as `plur folders set` intends.
   */
  literal?: boolean
  /**
   * Refuse (FolderMapError 'covers-home', nothing written) when the path this
   * write records is the home folder, a filesystem root or an ancestor of the
   * home: such an entry would cover every folder under it. Checked under the
   * folder-map lock on the key actually written, so a folder swapped for a
   * symlink to the home after the caller's own check is still refused
   * (#1415 review). `plur remote` sets it.
   */
  refuseCoveringHome?: boolean
}

/**
 * True when `dir` is `home`, a filesystem root, or an ancestor of `home`.
 * `dir` is compared as given (resolved) and canonicalised, against the home
 * as given and canonicalised, so a symlink, `..` or another letter case does
 * not hide it.
 */
export function coversHomeOrRoot(dir: string, home: string = homedir()): boolean {
  const dirs = new Set([resolve(dir), canonicalize(dir)])
  const homes = new Set([resolve(home), canonicalize(home)])
  for (const d of dirs) {
    if (dirname(d) === d) return true // a root: its parent is itself
    for (const h of homes) {
      const rel = relative(d, h)
      if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return true
    }
  }
  return false
}

function hasGlob(p: string): boolean {
  return firstGlobIndex(p) !== -1
}

/** The path a CLI write records: literal folders are canonicalised, globs kept as typed. */
export function folderEntryKey(folder: string, home: string = homedir(), literal = false): string {
  return !literal && hasGlob(folder) ? folder : canonicalize(expandHome(folder, home))
}

function entryIsFolder(e: FolderEntry, folder: string, raw: string, target: string, home: string): boolean {
  return (e.path === folder && !entryIsGlob(e)) ||
    (!entryIsGlob(e) && (resolve(expandHome(e.path, home)) === raw || entryForms(e.path, home, false, e.literal === true).includes(target)))
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
function findEntryIndex(
  entries: FolderEntry[], folder: string, home: string, literal = false,
): { applied: number[]; nameOnly: number[] } {
  // A glob edit (not a literal one, #1415) names only the glob entry as typed.
  if (!literal && hasGlob(folder)) return { applied: entries.flatMap((e, i) => (e.path === folder ? [i] : [])), nameOnly: [] }
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
    // A literal entry (#1415) is a plain folder even when its name has `*`/`?`.
    const lit = e.literal === true
    if (!entryIsGlob(e) && entryForms(e.path, home, false, lit).includes(target)) applied.push(i)
    else if (entryIsFolder(e, folder, raw, target, home) ||
      (!entryIsGlob(e) && entryForms(e.path, home, false, lit).some(f => sameFolderIgnoringCase(f, target)))) nameOnly.push(i)
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
    const why = r.error?.problem ? ` — ${r.error.problem}` : ''
    const how = r.error?.fixable ? 'run `plur folders repair` to fix it' : 'fix it by hand (`plur folders repair` re-checks it)'
    throw new FolderMapError('malformed', `${folderMapPath(root)} cannot be used${why}; ${how} before writing (nothing was changed).`)
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
  const literal = opts.literal === true
  const consume = opts.nonce !== undefined ? verifyFolderNonce(root, opts.nonce, folder, change, opts.now, home, literal, opts.session) : null
  const key = folderEntryKey(folder, home, literal)
  const { applied, nameOnly } = findEntryIndex(map.folders, folder, home, literal)
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
  const grantedPaths = [...applied, ...nameOnly].filter(i => map.folders[i].trusted === true).map(i => map.folders[i].path)
  const entry: FolderEntry = { path: appliedEntries[0]?.e.path ?? key }
  // The merged path stays a literal folder (#1415) when it has `*`/`?` and
  // either this edit is literal or the applied entry it came from was.
  if (hasGlob(entry.path) && (literal || appliedEntries[0]?.e.literal === true)) entry.literal = true
  // #1415 review: the refusal holds on the path this write records, computed
  // here under the lock — not on a check the caller made before it.
  if (opts.refuseCoveringHome) {
    const written = new Set([key, entry.path].filter(p => literal || entry.literal === true || !hasGlob(p)).map(p => expandHome(p, home)))
    for (const p of written) {
      if (coversHomeOrRoot(p, home)) {
        throw new FolderMapError('covers-home',
          `${p} is your home folder, a filesystem root or a folder above your home, and an entry for it would cover ` +
          'every folder under it; nothing was changed.')
      }
    }
  }
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
  if (change.trusted === true && !entryIsGlob(entry)) addLegacyTrustEntryUnlocked(root, entry.path)
  if (change.trusted === false) {
    // A revocation: the folder's own line, and the line of every matched
    // entry that held a grant (applied or name-only), as `rm` does.
    removeLegacyTrustEntryUnlocked(root, folder, home)
    for (const p of grantedPaths) removeLegacyTrustEntryUnlocked(root, p, home)
  }
  return cleanEntry(entry)
}

/**
 * Remove the entry for `folder` (exact entry, not a covering one). Returns
 * whether one was removed. A `nonce` (from the ask flow) is checked like
 * `setFolderEntry`'s and consumed only when an entry was removed and saved.
 */
export function removeFolderEntry(
  root: string, folder: string, home: string = homedir(), opts?: { nonce?: string; now?: number; session?: string },
): boolean {
  return locked(root, () => removeFolderEntryUnlocked(root, folder, home, opts))
}

function removeFolderEntryUnlocked(
  root: string, folder: string, home: string, opts?: { nonce?: string; now?: number; session?: string },
): boolean {
  const map = loadForWrite(root)
  const consume = opts?.nonce !== undefined ? verifyFolderNonce(root, opts.nonce, folder, { remove: true }, opts.now, home, false, opts.session) : null
  const { applied, nameOnly } = findEntryIndex(map.folders, folder, home)
  const matched = [...applied, ...nameOnly]
  if (matched.length === 0) return false
  const removed = map.folders.filter((_, i) => matched.includes(i))
  map.folders = map.folders.filter((_, i) => !matched.includes(i))
  saveFolderMap(root, map)
  consume?.()   // F3: consumed once the map is saved, before trust.yaml
  // Decision F2: removing a trusted entry is a revocation, so it is completed
  // in trust.yaml too (never an addition) — for EVERY removed entry that held
  // a grant, applied or name-only, so no spelling of it survives there.
  for (const e of removed) if (e.trusted === true) removeLegacyTrustEntryUnlocked(root, e.path, home)
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
  const cleared: string[] = []
  const raw = resolve(expandHome(folder, home))
  const target = canonicalize(raw)
  map.folders = map.folders.filter(e => {
    // Also an entry for this folder recorded in another letter case, checked
    // for identity like findEntryIndex's fallback (#1357). Its grant never
    // applied, but `plur untrust` must still clear it and say so.
    const hit = e.trusted === true && (entryIsFolder(e, folder, raw, target, home) ||
      (!entryIsGlob(e) && entryForms(e.path, home, false, e.literal === true).some(f => sameFolderIgnoringCase(f, target))))
    if (!hit) return true
    changed = true
    cleared.push(e.path)
    delete e.trusted
    return e.plur !== undefined || e.scope !== undefined
  })
  if (changed) {
    saveFolderMap(root, map)
    // Dual-write (F2): the revocation is completed in trust.yaml for EVERY
    // cleared entry, applied or name-only (untrustDirectory also removes the
    // line for the folder as given).
    for (const p of cleared) removeLegacyTrustEntryUnlocked(root, p, home)
  }
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
 * the home (as given and canonical), and each side is also compared in its
 * canonical and on-disk forms, so a differently-cased line on a
 * case-insensitive filesystem goes too. Matching wide is the safe direction
 * here — this only ever REMOVES a grant — but never across folders: a line
 * differing only in letter case must be the SAME directory entry (#1357's
 * identity check), so a case-sensitive volume keeps a sibling's grant.
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
  // Case is never folded blindly (#1357): on a case-sensitive volume `Proj`
  // and `pROJ` can be two folders, and revoking one must not remove the
  // other's grant. A differently-cased line that exists resolves to the
  // on-disk case above; anything else must pass the identity check.
  const same = (a: string, b: string) => norm(a, 'linux') === norm(b, 'linux') || sameFolderIgnoringCase(a, b)
  return forms.some(a => targets.some(b => same(a, b)))
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

/**
 * `session_bound`: the nonce works only from the session it was issued in,
 * named by the redeeming command (audit F5 of #1517). Set by an issuer whose
 * host passes the session to the commands the agent runs (the opencode
 * plugin, through shell.env). The editor hooks' hosts cannot, so theirs are
 * unbound and work from any shell, as before.
 */
interface NonceRecord { nonce: string; folder: string; answer?: FolderAnswer; issued_at: number; session_bound?: boolean }
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
 * Issue a single-use nonce that lets the ask flow of `sessionId` record
 * exactly `answer` for exactly `folder` (#1378). The ask flow issues one nonce
 * per answer it offers, and prints each next to its command: a nonce issued
 * for `{ mode: 'on' }` does not authorise `--trusted`, `--off`, another scope
 * or `rm`. `plur trust` is `{ trusted: true }`, `folders set --no-trusted` is
 * `{ trusted: false }` and `plur folders rm` is `{ remove: true }`. The folder
 * is recorded as the key a write of it records (folderEntryKey: `~` expanded,
 * canonicalised, a glob as typed), which is what verifyFolderNonce compares.
 * `literal` must match the write's own `literal` option (#1415 review): a
 * literal write of `sub?` records the canonical folder, a glob write `sub?`
 * as typed, and the nonce is bound to the same key.
 */
export function issueFolderNonce(
  root: string, sessionId: string, folder: string, answer: FolderAnswer, now: number = Date.now(),
  options: { home?: string; literal?: boolean; bindSession?: boolean } = {},
): string {
  if (answerKey(answer) === null) throw new FolderMapError('invalid', 'A folder nonce needs the answer it authorises.')
  const key = folderEntryKey(folder, options.home ?? homedir(), options.literal === true)
  return locked(root, () => issueFolderNonceUnlocked(root, sessionId, key, answer, now, options.bindSession === true))
}

function issueFolderNonceUnlocked(root: string, sessionId: string, key: string, answer: FolderAnswer, now: number, bound: boolean): string {
  mkdirSync(nonceDir(root), { recursive: true, mode: 0o700 })
  const file = nonceFile(root, sessionId)
  const data = readNonceFile(file) ?? { session: safeSessionKey(sessionId), nonces: [] }
  const nonce = randomBytes(16).toString('hex')
  // The same key a write of this folder records (#1477 review): `~` expands
  // to the home, a literal folder is canonicalised, a glob is kept as typed.
  data.nonces.push({ nonce, folder: key, answer: cleanAnswer(answer), issued_at: now, ...(bound ? { session_bound: true } : {}) })
  writeNonceFile(file, data)
  return nonce
}

/** Only the fields an answer has, so the nonce file holds nothing else. */
function cleanAnswer(a: FolderAnswer): FolderAnswer {
  if ('remove' in a) return { remove: true }
  return {
    ...(a.mode !== undefined ? { mode: a.mode } : {}),
    ...(a.scope !== undefined ? { scope: a.scope } : {}),
    ...(a.trusted !== undefined ? { trusted: a.trusted } : {}),
  }
}

/** Drop every nonce of `sessionId` — called when the session ends. */
export function endFolderNonceSession(root: string, sessionId: string): void {
  rmSync(nonceFile(root, sessionId), { force: true })
}

/**
 * Verify and consume `nonce` for `answer` on `folder` in one step. See verifyFolderNonce.
 */
export function consumeFolderNonce(
  root: string, nonce: string, folder: string, answer: FolderAnswer, now: number = Date.now(),
  options: { home?: string; literal?: boolean; session?: string } = {},
): void {
  locked(root, () => verifyFolderNonce(root, nonce, folder, answer, now, options.home ?? homedir(), options.literal === true, options.session)())
}

/**
 * Verify `nonce` for `answer` on `folder` and return the function that
 * consumes it. Writers call that only after their write succeeded, so a
 * failed write never burns the nonce. Throws a FolderMapError when the nonce
 * is unknown (never issued, already used, or its session ended), expired
 * (removed on the spot), or was issued for a different folder or a different
 * answer (left in place, so the answer it was issued for still works). A
 * record with no bound answer (written before #1378) authorises nothing.
 */
export function verifyFolderNonce(
  root: string, nonce: string, folder: string, answer: FolderAnswer, now: number = Date.now(), home: string = homedir(),
  literal = false, session?: string,
): () => void {
  // Checked against exactly the key the write records (#1477 review). With
  // canonicalize(folder) alone, a quoted `~/x` was checked as `<cwd>/~/x`
  // but written as `$HOME/x`, so a nonce for one folder could write another.
  // `literal` is the write's own (#1415 review): a literal write of `sub?`
  // records the canonical folder, so it is checked against that, not `sub?`.
  const key = folderEntryKey(folder, home, literal)
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
    // Session binding (audit F5 of #1517), checked before anything is
    // consumed or removed, so a refused nonce still works where it belongs.
    const sameSession = session !== undefined && data.session === safeSessionKey(session)
    if ((session !== undefined && !sameSession) || (rec.session_bound === true && !sameSession)) {
      throw new FolderMapError('nonce-session',
        'That nonce belongs to another session (or this command names none); nothing was changed. ' +
        'Run the command from the session that showed it, or decide by hand in a terminal: plur folders set <folder> --on | --off.')
    }
    if (now - rec.issued_at > FOLDER_NONCE_TTL_MS) {
      data.nonces.splice(idx, 1)
      writeNonceFile(file, data)
      throw new FolderMapError('nonce-expired', 'That nonce has expired; nothing was changed.')
    }
    if (rec.folder !== key) {
      throw new FolderMapError('nonce-folder', `That nonce was issued for ${rec.folder}, not ${key}; nothing was changed.`)
    }
    const bound = answerKey(rec.answer)
    if (bound === null || bound !== answerKey(answer)) {
      throw new FolderMapError('nonce-answer',
        `That nonce was issued for ${describeAnswer(rec.answer)}, not ${describeAnswer(answer)}; nothing was changed.`)
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
