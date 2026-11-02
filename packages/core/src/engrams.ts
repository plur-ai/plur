import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { EngramSchemaPassthrough, type Engram } from './schemas/engram.js'
import { PackManifestSchema, type PackManifest } from './schemas/pack.js'
import { logger } from './logger.js'
import { atomicWrite, fsyncDir } from './atomic-write.js'
import { recordLastWritten } from './backup.js'
import { normalizeEngramInput } from './normalize-engram.js'
import { createHash } from 'crypto'
import { appendHistoryBatch, readRekeyedPairs, type HistoryEvent } from './history.js'

/**
 * Error thrown when the engram file exists but cannot be read as engrams.
 *
 * Distinct from "the store is empty" ON PURPOSE — see {@link loadEngrams}.
 */
export class EngramStoreUnreadableError extends Error {
  constructor(readonly filePath: string, readonly cause: unknown) {
    super(
      `[plur] refusing to read ${filePath}: ${cause}\n` +
      `The file exists but is not valid engram YAML, so PLUR cannot tell how many engrams it holds. ` +
      `It is NOT being treated as empty: the write path replaces the whole file, so a write against an ` +
      `"empty" store would destroy every engram in it.\n` +
      `Common cause: a git merge conflict in engrams.yaml after 'plur sync' — look for <<<<<<< markers. ` +
      `Fix the file (or restore it from git history) and retry.`,
    )
    this.name = 'EngramStoreUnreadableError'
  }
}

/**
 * The one shape rule for an engram store document, shared with sync's `readEngramList` and backup's `validateStore`
 * (a looser reader could push a file PLUR cannot load). Returns the raw `engrams:` entries, or throws.
 */
export function engramStoreEntries(filePath: string, content: string, byteLength: number): unknown[] {
  if (byteLength === 0) {
    throw new EngramStoreUnreadableError(filePath, new Error('file is empty (0 bytes)'))
  }
  let raw: any
  try {
    raw = yaml.load(content)
  } catch (err) {
    throw new EngramStoreUnreadableError(filePath, err)
  }
  if (raw == null) {
    throw new EngramStoreUnreadableError(filePath, new Error('file has content but parses to nothing'))
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EngramStoreUnreadableError(filePath, new Error('top-level value is not a mapping'))
  }
  if (!('engrams' in raw)) {
    throw new EngramStoreUnreadableError(
      filePath,
      new Error('mapping has no "engrams" key — the file is not an engram store, or is truncated'),
    )
  }
  // `engrams:` with a null value is NOT an empty store. PLUR only ever writes
  // `engrams: []` — initFilesystemStore included — so a null-valued key is a
  // hand-edit or, far more likely, a truncation that happened to stop right
  // after the key. Accepting it as empty normalises the corruption: the next
  // write would turn a truncated store into a valid 1-engram one, which then
  // syncs and can replace subsequent backups.
  if (raw.engrams == null) {
    throw new EngramStoreUnreadableError(
      filePath,
      new Error('"engrams" key is present but has no value — an empty store is written as `engrams: []`'),
    )
  }
  if (!Array.isArray(raw.engrams)) {
    throw new EngramStoreUnreadableError(filePath, new Error('"engrams" is present but is not a list'))
  }
  return raw.engrams as unknown[]
}

/**
 * Per-entry rule: normalise, then validate. The ONE definition of "this entry is
 * an engram", shared by the loader and the backup gate. `null` = quarantine.
 */
export function parseEngramEntry(entry: unknown): Engram | null {
  // Field-compat rules live in ONE place — normalise before parse, so
  // "absent" is still distinguishable from "Zod filled the default".
  const result = EngramSchemaPassthrough.safeParse(normalizeEngramInput(entry))
  return result.success ? (result.data as Engram) : null
}

/**
 * Ids carried by more than one entry, in first-occurrence order — the ONE
 * duplicate-id detector (backup gate, Postgres save/updateMany, PGLite index).
 * Entries without a string id are ignored here (the schema rejects them).
 */
export function duplicateEngramIds(entries: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const dups = new Set<string>()
  for (const e of entries) {
    const id = (e as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || id.length === 0) continue
    if (seen.has(id)) dups.add(id)
    else seen.add(id)
  }
  return [...dups]
}

/** Key-sorted JSON: two records are "the same content" iff this is equal. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return '{' + Object.keys(o).filter(k => o[k] !== undefined).sort()
      .map(k => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}'
  }
  return JSON.stringify(v) ?? 'null'
}

/** Whether two raw records carry the same content (key order ignored) — the "exact duplicate" test. */
export function sameEngramContent(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

/** One id change made by {@link resolveDuplicateIds} (or by sync's restore). */
export interface IdRename { from: string; to: string }

/**
 * The fresh id a clashing copy gets: `<id>-D<8 hex of sha256(content)>`, plus `-2`, `-3`, … if taken.
 * Deterministic on purpose: several readers detect the same clash before anyone writes back, and all must arrive
 * at the same id. Keeps the original id as prefix and matches `^(ENG|ABS|META)-[A-Za-z0-9-]+$`.
 */
export function freshDuplicateId(id: string, entry: unknown, taken: ReadonlySet<string>): string {
  const h = createHash('sha256').update(canonicalJson(entry)).digest('hex').slice(0, 8)
  const base = `${id}-D${h}`
  let candidate = base
  for (let k = 2; taken.has(candidate); k++) candidate = `${base}-${k}`
  return candidate
}

/**
 * THE duplicate-id rule, shared by the loader, the PGLite index and the Postgres writer: keep both, rename one.
 * Two synced machines learning on the same day mint the same id, so clashes happen without manual edits.
 *
 * - The FIRST copy keeps the id; a later copy with different content gets {@link freshDuplicateId}.
 * - A later copy identical to a kept copy is dropped and counted in `exactDuplicates`.
 *
 * Pure. Callers record `renames` ({@link recordIdRenames}); `alsoTaken` reserves ids not in `entries`.
 */
export function resolveDuplicateIds<T extends { id: string }>(
  entries: readonly T[],
  alsoTaken: Iterable<string> = [],
): { engrams: T[]; renames: IdRename[]; exactDuplicates: number } {
  const taken = new Set<string>(alsoTaken)
  const repeated = new Set<string>()
  for (const e of entries) {
    if (taken.has(e.id)) repeated.add(e.id)
    taken.add(e.id)
  }
  // Canonical content is only needed for ids that occur more than once — the
  // common store has none, so a load pays one Set pass, not a re-serialisation
  // of every record.
  if (repeated.size === 0) return { engrams: [...entries], renames: [], exactDuplicates: 0 }
  const keptContent = new Map<string, string[]>()
  const engrams: T[] = []
  const renames: IdRename[] = []
  let exactDuplicates = 0
  for (const e of entries) {
    if (!repeated.has(e.id)) { engrams.push(e); continue }
    const content = canonicalJson(e)
    const prior = keptContent.get(e.id)
    if (!prior) {
      keptContent.set(e.id, [content])
      engrams.push(e)
    } else if (prior.includes(content)) {
      exactDuplicates++
    } else {
      const to = freshDuplicateId(e.id, e, taken)
      taken.add(to)
      prior.push(content)
      renames.push({ from: e.id, to })
      engrams.push({ ...e, id: to })
    }
  }
  return { engrams, renames, exactDuplicates }
}

/** Renames already written to history by this process — keeps repeated writes cheap. */
const recordedRenames = new Set<string>()

/**
 * Record id renames in `<root>/history` as `engram_rekeyed` events, once each.
 *
 * Idempotent across writes and processes: a rename already in the log (same
 * `from` → `to`) is not written again, and because {@link freshDuplicateId} is
 * deterministic a re-read of an unchanged file produces the same renames.
 *
 * ONE history pass for all of `renames`: a per-rename history read costs
 * renames × the whole log. Write paths only: see {@link loadEngrams} and
 * {@link saveEngrams}.
 */
export function recordIdRenames(root: string, renames: readonly IdRename[], reason: string, data: Record<string, unknown> = {}): void {
  const keyOf = (r: IdRename) => `${path.resolve(root)}\0${r.from}\0${r.to}`
  const todo = renames.filter(r => !recordedRenames.has(keyOf(r)))
  if (todo.length === 0) return
  let already = new Set<string>()
  try {
    already = readRekeyedPairs(root)
  } catch { /* unreadable history: write the events; a repeat is harmless, a gap is not */ }
  const events: HistoryEvent[] = []
  const timestamp = new Date().toISOString()
  for (const r of todo) {
    const pair = `${r.from}\0${r.to}`
    if (!already.has(pair)) {
      events.push({ event: 'engram_rekeyed', engram_id: r.to, timestamp, data: { from: r.from, to: r.to, ...data }, reason })
      already.add(pair)
    }
    recordedRenames.add(keyOf(r))
  }
  if (events.length > 0) appendHistoryBatch(root, events)
}

/**
 * Renames the last load of a store file made in memory and nothing has written
 * yet, keyed like the quarantine map. A load is a READ — hooks, recall, the
 * index sync — and must not append history, so the
 * rename is recorded by the next {@link saveEngrams} of that file, the write
 * that actually puts the new id on disk (and runs under the store lock).
 */
interface PendingRename extends IdRename { reason: string; data: Record<string, unknown> }
const pendingRenamesByPath = new Map<string, PendingRename[]>()

// ---------------------------------------------------------------------------
// Held records of an in-flight (or interrupted) git sync
// ---------------------------------------------------------------------------

/**
 * A store file whose working-tree copy held records the sync push set withholds
 * (scope:local engrams; on a `shared` remote also personal/private engrams and
 * derived sibling records), set aside while `git pull` runs.
 */
export interface HeldFile {
  file: string
  /** Working-tree bytes before the hold — restored verbatim when the pull left the file alone. */
  saved: string
  /** The index blob the working tree was reset to (== HEAD after the sync's commit), trimmed. */
  staged: string
  /** Records present in the working tree but never committed. */
  held: unknown[]
}

/** Recovery file for held records, inside `.git` so no `git add` can ever stage it. */
export const HELD_RECOVERY_FILE = 'plur-held.json'

/** Where a sync rooted at `root` keeps its held records while the tree is reset. */
export function heldRecoveryPath(root: string): string {
  return path.join(root, '.git', HELD_RECOVERY_FILE)
}

/** Thrown when a held-records recovery file exists but cannot be read. */
export class HeldRecoveryUnreadableError extends Error {
  constructor(readonly filePath: string, readonly cause: unknown) {
    super(
      `[plur] cannot read ${filePath}: ${cause}\n` +
      `This file holds scope:local (never-pushed) records that an interrupted 'plur sync' set aside. ` +
      `PLUR will not sync or delete it while it is unreadable. Inspect it (it is JSON), repair it, and retry.`,
    )
    this.name = 'HeldRecoveryUnreadableError'
  }
}

/**
 * The held records of a sync that has not finished restoring them, or null when
 * there are none. They are persisted on disk between resetting the working
 * tree and restoring it, so a Ctrl-C, SIGTERM or SIGKILL during the pull
 * cannot delete scope:local engrams.
 */
export function readHeldRecovery(root: string): HeldFile[] | null {
  const p = heldRecoveryPath(root)
  if (!fs.existsSync(p)) return null
  let v: unknown
  try {
    v = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (err) {
    throw new HeldRecoveryUnreadableError(p, err)
  }
  const files = (v as { files?: unknown } | null)?.files
  if (!Array.isArray(files) || !files.every(f =>
    f && typeof f.file === 'string' && typeof f.saved === 'string' && typeof f.staged === 'string' && Array.isArray(f.held))) {
    throw new HeldRecoveryUnreadableError(p, new Error('not a held-records file'))
  }
  return files as HeldFile[]
}

/** An engram-id token (`ENG-…`, `ABS-…`, `META-…`) anywhere in a string. */
export const ENGRAM_ID_TOKEN = /\b(?:ENG|ABS|META)-[A-Za-z0-9-]+/g

/** Replace engram-id tokens in a record by `map` (old id -> new id), everywhere in it. */
export function renameEngramIdRefs(v: unknown, map: ReadonlyMap<string, string>): unknown {
  if (typeof v === 'string') return v.replace(ENGRAM_ID_TOKEN, m => map.get(m) ?? m)
  if (Array.isArray(v)) return v.map(x => renameEngramIdRefs(x, map))
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, renameEngramIdRefs(x, map)]))
  }
  return v
}

/** The recovery file's raw `merge_renames`, or null (absent / unreadable). */
function rawHeldMergeRenames(root: string): IdRename[] | null {
  try {
    const v = JSON.parse(fs.readFileSync(heldRecoveryPath(root), 'utf8')) as { merge_renames?: unknown } | null
    const r = v?.merge_renames
    if (!Array.isArray(r) || !r.every(x => x && typeof x.from === 'string' && typeof x.to === 'string')) return null
    return r.map(x => ({ from: x.from as string, to: x.to as string }))
  } catch {
    return null
  }
}

/**
 * Engram renames a sync's record merge made to committed engrams while records were held aside; references in the
 * held records are rewritten with them. Saved with the held records BEFORE the merge commit so a crash after the
 * commit keeps it. Applies only once the merge is concluded: while `.git/MERGE_HEAD` exists this returns [].
 */
export function readHeldMergeRenames(root: string): IdRename[] {
  if (fs.existsSync(path.join(root, '.git', 'MERGE_HEAD'))) return []
  return rawHeldMergeRenames(root) ?? []
}

/**
 * Durably record `files` as held (write + fsync + rename + fsync dir), or delete
 * the recovery file when `files` is empty. Called BEFORE the tree is reset and
 * again, to delete it, only AFTER every held record is back.
 */
export function writeHeldRecovery(root: string, files: readonly HeldFile[], mergeRenames?: readonly IdRename[] | null): void {
  const p = heldRecoveryPath(root)
  if (files.length === 0) {
    try { fs.unlinkSync(p) } catch { return }
    fsyncDir(path.dirname(p))
    return
  }
  // `undefined` keeps the merge renames already saved (a rewrite of the held
  // records, e.g. after some were restored); `null` drops them (a new hold).
  const merge = mergeRenames === undefined ? rawHeldMergeRenames(root) : mergeRenames
  atomicWrite(p, JSON.stringify({
    version: 1,
    note: 'Records a plur sync set aside during git pull (never pushed). Restored automatically; do not delete by hand.',
    files,
    ...(merge && merge.length > 0 ? { merge_renames: merge } : {}),
  }), { mode: 0o600 })
}

/**
 * Held records to put back into a record list, and the renames that needs.
 *
 * A held record whose id the list already carries with
 * DIFFERENT content is a different engram (two machines minting the same id on
 * the same day) — the held one, never pushed, gets {@link freshDuplicateId}. A
 * held record identical to one already there is not appended twice (the
 * restore already happened, or a writer persisted it). Deterministic, so a
 * reader's view and the eventual restore agree on every id.
 */
export function mergeHeldRecords(current: readonly unknown[], held: readonly unknown[]): { held: unknown[]; renames: IdRename[] } {
  const idOf = (r: unknown) => (r as { id?: unknown } | null)?.id
  const byId = new Map<string, unknown[]>()
  const taken = new Set<string>()
  for (const r of [...current, ...held]) { const id = idOf(r); if (typeof id === 'string') taken.add(id) }
  for (const r of current) {
    const id = idOf(r)
    if (typeof id === 'string') byId.set(id, [...(byId.get(id) ?? []), r])
  }
  const out: unknown[] = []
  const renames: IdRename[] = []
  for (const r of held) {
    const id = idOf(r)
    const same = typeof id === 'string' ? byId.get(id) : undefined
    if (!same) { out.push(r); continue }
    if (same.some(p => sameEngramContent(p, r))) continue
    // Already restored under its fresh id (an earlier, interrupted restore).
    const first = freshDuplicateId(id as string, r, new Set())
    if ((byId.get(first) ?? []).some(p => sameEngramContent(p, { ...(r as object), id: first }))) continue
    const to = freshDuplicateId(id as string, r, taken)
    taken.add(to)
    renames.push({ from: id as string, to })
    out.push({ ...(r as object), id: to })
  }
  return { held: out, renames }
}

/** Held engrams.yaml records for the store at `filePath`, or null (not a synced root / nothing held / unreadable). */
function heldEngramsFor(filePath: string): unknown[] | null {
  if (path.basename(filePath) !== 'engrams.yaml') return null
  const root = path.dirname(path.resolve(filePath))
  if (!fs.existsSync(heldRecoveryPath(root))) return null
  try {
    const held = readHeldRecovery(root)?.find(f => f.file === 'engrams.yaml')?.held ?? null
    const merged = held ? readHeldMergeRenames(root) : []
    if (!held || merged.length === 0) return held
    // A concluded merge renamed committed engrams: held references follow.
    const map = new Map(merged.map(r => [r.from, r.to] as const))
    return held.map(r => renameEngramIdRefs(r, map))
  } catch (err) {
    logger.warning(`${(err as Error).message}`)
    return null
  }
}

/** Store files whose last load folded in held records from a recovery file. */
const heldMergedPaths = new Set<string>()

/**
 * The PLUR root a store file's history belongs to, or null. A store file is
 * `<root>/engrams.yaml`; a directory that is not a PLUR root (a pack, a bare
 * `stores[].path`) gets no history directory created in it.
 */
function historyRootFor(filePath: string): string | null {
  const dir = path.dirname(path.resolve(filePath))
  if (fs.existsSync(path.join(dir, 'history')) || fs.existsSync(path.join(dir, 'config.yaml'))) return dir
  return null
}

/**
 * Parse store bytes into valid and quarantined entries, or throw.
 *
 * The single definition of "is this a readable engram store". Anything that
 * reads a store file goes through here so that copies of the rules cannot
 * drift apart.
 *
 * `byteLength` is passed separately because the caller may have read the file
 * with either the sync or async API, and the zero-length check must be made on
 * the bytes actually read rather than a second stat that could race.
 */
export function parseEngramFile(
  filePath: string,
  content: string,
  byteLength: number,
): { valid: Engram[]; quarantined: unknown[]; renames: IdRename[]; exactDuplicates: number } {
  return parseEngramEntries(filePath, engramStoreEntries(filePath, content, byteLength))
}

/** {@link parseEngramFile} for entries already read by {@link engramStoreEntries}. */
function parseEngramEntries(
  filePath: string,
  entries: unknown[],
): { valid: Engram[]; quarantined: unknown[]; renames: IdRename[]; exactDuplicates: number } {
  const parsedValid: Engram[] = []
  const quarantined: unknown[] = []
  for (const entry of entries) {
    const parsed = parseEngramEntry(entry)
    if (parsed) parsedValid.push(parsed)
    // Quarantine the ORIGINAL entry, not the normalised one: quarantined
    // entries are written back verbatim, and a rejected engram must not be
    // silently rewritten on its way to being preserved.
    else quarantined.push(entry)
  }
  if (quarantined.length > 0) {
    logger.warning(
      `Quarantined ${quarantined.length} invalid engram(s) in ${filePath} — ` +
      `they are excluded from recall but PRESERVED in the file. Run 'plur doctor' to inspect them.`,
    )
  }
  // A clashing id keeps both copies, the later one renamed.
  const quarantinedIds = quarantined.map(q => (q as { id?: unknown } | null)?.id).filter((x): x is string => typeof x === 'string')
  const { engrams: valid, renames, exactDuplicates } = resolveDuplicateIds(parsedValid, quarantinedIds)
  if (renames.length > 0 || exactDuplicates > 0) {
    logger.warning(
      `[plur] ${filePath}: ` +
      (renames.length > 0
        ? `${renames.length} engram(s) shared an id with an earlier, different engram and were given fresh ids ` +
          `(${renames.slice(0, 3).map(r => `${r.from} -> ${r.to}`).join(', ')}${renames.length > 3 ? ', …' : ''}). `
        : '') +
      (exactDuplicates > 0 ? `${exactDuplicates} exact duplicate record(s) are read once. ` : '') +
      `The file changes on the next write.`,
    )
  }
  return { valid, quarantined, renames, exactDuplicates }
}

/**
 * Error thrown when a sibling record file (episodes, tensions) is unreadable.
 *
 * Same doctrine as {@link EngramStoreUnreadableError}, for the artifacts that
 * are a bare YAML array rather than an `engrams:` mapping.
 */
export class RecordStoreUnreadableError extends Error {
  constructor(readonly filePath: string, readonly cause: unknown) {
    super(
      `[plur] refusing to read ${filePath}: ${cause}\n` +
      `The file exists but is not a valid record list, so PLUR cannot tell how many records it holds. ` +
      `It is NOT being treated as empty: these files are rewritten whole, so a write against an ` +
      `"empty" store would destroy every record in it.\n` +
      `Fix the file (or restore it) and retry.`,
    )
    this.name = 'RecordStoreUnreadableError'
  }
}

/**
 * Read a bare-array record file (episodes.yaml, tensions.yaml), or throw.
 * Missing file is `[]`; an existing file that does not parse or has the wrong shape throws, since writers rewrite
 * the whole array. Invalid entries are QUARANTINED and returned to the caller to be written back, never dropped.
 */
export function parseRecordArrayFile<T>(
  filePath: string,
  validate: (entry: unknown) => T | null,
): { valid: T[]; quarantined: unknown[] } {
  if (!fs.existsSync(filePath)) return { valid: [], quarantined: [] }
  const stat = fs.statSync(filePath)
  if (stat.isDirectory()) return { valid: [], quarantined: [] }
  if (stat.size === 0) throw new RecordStoreUnreadableError(filePath, new Error('file is empty (0 bytes)'))
  let raw: unknown
  try {
    raw = yaml.load(fs.readFileSync(filePath, 'utf8'))
  } catch (err) {
    throw new RecordStoreUnreadableError(filePath, err)
  }
  // An empty list serialises as `[]`, so `null` here means the bytes said
  // nothing — a truncation, not an empty store.
  if (raw == null) throw new RecordStoreUnreadableError(filePath, new Error('file has content but parses to nothing'))
  if (!Array.isArray(raw)) throw new RecordStoreUnreadableError(filePath, new Error('top-level value is not a list'))
  const valid: T[] = []
  const quarantined: unknown[] = []
  for (const entry of raw) {
    const ok = validate(entry)
    if (ok !== null) valid.push(ok)
    else quarantined.push(entry)
  }
  if (quarantined.length > 0) {
    logger.warning(
      `Quarantined ${quarantined.length} invalid record(s) in ${filePath} — ` +
      `excluded from queries but PRESERVED in the file.`,
    )
  }
  return { valid, quarantined }
}

/**
 * Read engrams from a YAML store. A missing file is `[]`. An existing file that does not parse, is zero-length or
 * has no `engrams` key THROWS {@link EngramStoreUnreadableError} — every write saves the whole file, and PLUR cannot
 * tell an empty corpus from a destroyed one. Invalid entries are QUARANTINED and written back by {@link saveEngrams}.
 * A caller that wants "unreadable means empty" must catch the error and say so at the call site.
 */
export function loadEngrams(filePath: string): Engram[] {
  if (!fs.existsSync(filePath)) return []
  // A directory is a misconfiguration (`stores[].path` must name an
  // engrams.yaml, since it is handed straight to this function) — but NOT a
  // data-loss risk, which is what the throw below exists for. `saveEngrams`
  // cannot write to a directory either, so there is no path where a directory
  // read as "empty" leads to an overwrite. The throw is reserved for the case
  // that actually destroys data.
  const stat = fs.statSync(filePath)
  if (stat.isDirectory()) return []
  const content = fs.readFileSync(filePath, 'utf8')
  let entries = engramStoreEntries(filePath, content, stat.size)
  // While a sync has scope:local records set aside
  // (or after one was killed before putting them back), they are in the
  // recovery file, not in engrams.yaml. They are part of the store: every
  // reader sees them, and the next write of this file persists them.
  const key = resolveKey(filePath)
  const held = heldEngramsFor(filePath)
  let heldRenames: IdRename[] = []
  heldMergedPaths.delete(key)
  if (held) {
    const merged = mergeHeldRecords(entries, held)
    if (merged.held.length > 0) entries = [...entries, ...merged.held]
    heldRenames = merged.renames
    heldMergedPaths.add(key)
  }
  const { valid, quarantined, renames, exactDuplicates } = parseEngramEntries(filePath, entries)
  setQuarantine(filePath, quarantined)
  setExactDuplicates(filePath, exactDuplicates)
  // Recorded by the next write, not here: a load is a read.
  const pending: PendingRename[] = [
    ...heldRenames.map(r => ({ ...r, reason: SYNC_HELD_RENAME_REASON, data: { store: filePath, cause: 'sync-recovery' } })),
    ...renames.map(r => ({ ...r, reason: 'duplicate id: a later, different copy was given a fresh id (P1)', data: { store: filePath } })),
  ]
  if (pending.length > 0) pendingRenamesByPath.set(key, pending)
  else pendingRenamesByPath.delete(key)
  return valid
}

/** History reason for a held (never-pushed) record re-id'd against a pulled one. */
export const SYNC_HELD_RENAME_REASON =
  'sync: a pulled engram arrived with the id of a local engram that was never pushed; the local one was given a fresh id (P1b)'

/**
 * After a write of `filePath` lands: record the renames its last load made and
 * this write put on disk, and — if that load folded in held records from an
 * interrupted sync — drop them from the recovery file, since the file now holds
 * them. Runs under the store lock (every writer loads under it before saving),
 * which a running sync also holds, so no live sync is mid-restore here.
 */
function settleAfterWrite(filePath: string, written: readonly Engram[]): void {
  const key = resolveKey(filePath)
  const pending = pendingRenamesByPath.get(key)
  pendingRenamesByPath.delete(key)
  if (pending && pending.length > 0) {
    const root = historyRootFor(filePath)
    if (root) {
      const ids = new Set(written.map(e => e.id))
      const byReason = new Map<string, PendingRename[]>()
      for (const r of pending) {
        if (!ids.has(r.to)) continue // this write dropped it: nothing was renamed on disk
        byReason.set(r.reason, [...(byReason.get(r.reason) ?? []), r])
      }
      for (const [reason, rs] of byReason) recordIdRenames(root, rs, reason, rs[0].data)
    }
  }
  if (heldMergedPaths.delete(key)) {
    const root = path.dirname(path.resolve(filePath))
    try {
      const files = readHeldRecovery(root)
      if (files) writeHeldRecovery(root, files.filter(f => f.file !== 'engrams.yaml'))
    } catch (err) {
      logger.warning(`${(err as Error).message}`)
    }
  }
}

/**
 * Exact-duplicate records the last load of a path read once. The file
 * still holds them until the next write, and the shrink guard counts records
 * on disk — so without this, dropping the duplicate copy would look like a
 * removal (a two-record store holding one record twice is a 50% "shrink").
 * Same precondition as the quarantine map: load before save, in this process.
 */
const exactDuplicatesByPath = new Map<string, number>()

function setExactDuplicates(filePath: string, n: number): void {
  const key = resolveKey(filePath)
  if (n === 0) exactDuplicatesByPath.delete(key)
  else exactDuplicatesByPath.set(key, n)
}

/**
 * Entries that failed schema validation on the last load of each file, keyed by resolved path so a save can put
 * them back (module-level so load/save signatures stay unchanged).
 *
 * PRECONDITION: a writer must `loadEngrams` the same path in this process before it saves — `saveEngrams` does not
 * re-parse. Saving without a preceding load re-injects a stale set or drops quarantined rows.
 */
const quarantineByPath = new Map<string, unknown[]>()

function setQuarantine(filePath: string, entries: unknown[]): void {
  const key = resolveKey(filePath)
  if (entries.length === 0) quarantineByPath.delete(key)
  else quarantineByPath.set(key, entries)
}

function resolveKey(filePath: string): string {
  try { return fs.realpathSync(filePath) } catch { return path.resolve(filePath) }
}

/**
 * Quarantined (schema-invalid) entries currently known for a store file.
 *
 * Exposed for `plur doctor` and for tests; callers must treat the contents as
 * opaque — that is the whole point of quarantine.
 */
export function getQuarantinedEntries(filePath: string): unknown[] {
  return quarantineByPath.get(resolveKey(filePath)) ?? []
}

/** Thrown by {@link saveEngrams} when a write would shrink the store past the guard. */
export class EngramStoreShrinkError extends Error {
  constructor(readonly filePath: string, readonly before: number, readonly after: number, readonly baseline: number = before) {
    super(
      `[plur] refusing to write ${filePath}: it holds ${before} engram(s) and this write would leave ${after}.\n` +
      (baseline > before
        ? `Undeclared writes by this process already took it from ${baseline} to ${before}; the 10% tolerance is ` +
          `cumulative since the last write that did not shrink it (owner decision P2), and this one would exceed it.\n`
        : '') +
      `A write path replaces the whole file, so an unexpected shrink is how a corpus gets destroyed — ` +
      `most often because the file was read as empty or partially unreadable first.\n` +
      `Operations that legitimately remove engrams (compact, forget, outbox flush, pack uninstall) ` +
      `declare it by passing { allowShrink: true }. This one did not.\n` +
      `If the shrink is genuine, re-run the deliberate operation; otherwise restore the file before retrying.`,
    )
    this.name = 'EngramStoreShrinkError'
  }
}

/** Options for {@link saveEngrams}. */
export interface SaveEngramsOptions {
  /**
   * This write is expected to remove engrams — skip the shrink guard.
   *
   * Set it on the deliberate removers (compact, forget, retire, outbox
   * merge-back, pack uninstall/sanitize) and nowhere else. Setting it "to make
   * the error go away" defeats the guard.
   */
  allowShrink?: boolean
}

/**
 * How much of the corpus undeclared writes may remove before it is treated as
 * corruption. Small deletions still happen legitimately through paths that
 * forget to declare themselves; a >10% drop is not a rounding error.
 *
 * CUMULATIVE (proved by `PlurSpec.R2Persist.Shrink.base_bounds`): the 10% is
 * measured from the baseline — the count at this process's last write to the
 * file that did not shrink it, or that declared `allowShrink` — so a series of
 * small tolerated writes cannot add up to a large loss. See {@link shrinkRuns}.
 */
const SHRINK_TOLERANCE = 0.1

/**
 * Per store file, in process only: the baseline of the current run of undeclared shrinks and the record count
 * this process last wrote. If the disk count is no longer `last` (someone else wrote), the baseline restarts at
 * the file as it is now, so a removal made elsewhere cannot block this process's next small removal.
 */
interface ShrinkRun { base: number; last: number }
const shrinkRuns = new Map<string, ShrinkRun>()

/**
 * Write the whole corpus to a store file.
 *
 * ## Why there is a guard here as well as in the loader
 *
 * The loader cannot catch every case: entries can parse and merely fail to
 * typecheck, or the store can be a save-only backend. And many `_writeEngrams`
 * call sites never touch the incremental write seam at all. So the invariant lives at the choke point every writer already funnels
 * through: if the file on disk holds materially more engrams than the array
 * about to replace it, refuse unless the caller said it meant to.
 */
export function saveEngrams(filePath: string, engrams: Engram[], opts: SaveEngramsOptions = {}): void {
  const outgoing = [...engrams]
  // Put quarantined entries back. They were withheld from the caller precisely
  // so it could not act on them, which also means it cannot be expected to
  // carry them — that is this function's job.
  const quarantined = getQuarantinedEntries(filePath)
  const quarantineRenames: IdRename[] = []
  if (quarantined.length > 0) {
    const taken = new Set<string>(outgoing.map(e => e.id))
    for (const entry of quarantined) {
      const id = (entry as any)?.id
      if (typeof id === 'string') taken.add(id)
    }
    const valid = new Set(outgoing.map(e => e.id))
    for (const entry of quarantined) {
      const id = (entry as any)?.id
      // A quarantined entry whose id a valid engram also carries may be a
      // different engram (a same-day id clash). Keep both, rename one: keep it
      // verbatim except for a fresh id by the same rule as the loader, so both
      // stay addressable; recorded in history.
      if (typeof id === 'string' && valid.has(id)) {
        const to = freshDuplicateId(id, entry, taken)
        taken.add(to)
        quarantineRenames.push({ from: id, to })
        outgoing.push({ ...(entry as object), id: to } as Engram)
        continue
      }
      outgoing.push(entry as Engram)
    }
  }
  const content = yaml.dump({ engrams: outgoing }, { lineWidth: 120, noRefs: true, quotingType: '"' })
  // The count check is UNCONDITIONAL. Do not gate it on a byte-size
  // pre-check: engram records vary widely in size, so a write can drop >10%
  // of records while shrinking the file by <5%.
  //
  // It stays cheap because `countEngramsOnDisk` scans for record-start lines
  // instead of parsing (falling back to the parse only when the structure is
  // not recognisable) — this runs on every recall() via `_reactivateResults`.
  const run: ShrinkRun = opts.allowShrink
    ? { base: outgoing.length, last: outgoing.length }
    : judgeShrink(filePath, outgoing.length)
  atomicWrite(filePath, content)
  // Only after the write landed: a refused or failed write leaves the run as it was.
  shrinkRuns.set(resolveKey(filePath), run)
  setExactDuplicates(filePath, 0)
  settleAfterWrite(filePath, outgoing)
  if (quarantineRenames.length > 0) {
    // The file now holds the renamed entries; the next load quarantines them
    // under their new ids.
    setQuarantine(filePath, outgoing.slice(outgoing.length - quarantined.length))
    const root = historyRootFor(filePath)
    if (root) {
      recordIdRenames(root, quarantineRenames,
        'duplicate id: a schema-invalid (quarantined) entry shared a valid engram\'s id and was given a fresh id so both are kept',
        { store: filePath, quarantined: true })
    }
    logger.warning(
      `[plur] ${filePath}: ${quarantineRenames.length} quarantined entr(y/ies) shared an id with a valid engram and ` +
      `were kept under fresh ids (${quarantineRenames.slice(0, 3).map(r => `${r.from} -> ${r.to}`).join(', ')}).`,
    )
  }
  // Record what PLUR itself wrote: the daily backup's shrink gate compares the file against this count, so a
  // deliberate removal re-baselines it while a file that shrank without PLUR
  // writing it is still refused. After the write, so it records what landed.
  recordLastWritten(filePath, outgoing.length)
}

/**
 * Refuse a whole-corpus write that drops more than {@link SHRINK_TOLERANCE} of
 * the records on disk.
 *
 * A SHARED FUNCTION rather than a step inside one writer: `saveEngrams` is the
 * ONLY whole-corpus YAML writer in core, and any future writer must call this
 * before touching the file.
 */
export function assertShrinkAllowed(filePath: string, outgoingCount: number): void {
  judgeShrink(filePath, outgoingCount)
}

/**
 * The guard: throws, or returns the run state to record once the write lands (mirrors `ratchetBase` in
 * `PlurSpec.R2Persist.Shrink`). No file or `out >= disk` -> allowed, new run at `out`. A shrink is allowed iff
 * `out >= 90%` of the baseline (the run's if the file is still what this process wrote, else disk). The baseline
 * is never below the file's count, so this is never looser than a per-write rule (theorem `new_implies_old`).
 */
function judgeShrink(filePath: string, outgoingCount: number): ShrinkRun {
  const key = resolveKey(filePath)
  const counted = countEngramsOnDisk(filePath)
  if (counted === null) return { base: outgoingCount, last: outgoingCount }
  // Exact duplicates the loader read once are not engrams this write removes.
  const disk = Math.max(0, counted - (exactDuplicatesByPath.get(key) ?? 0))
  if (outgoingCount >= disk) return { base: outgoingCount, last: outgoingCount }
  const prior = shrinkRuns.get(key)
  const base = prior && prior.last === counted ? Math.max(prior.base, disk) : disk
  if (outgoingCount < base * (1 - SHRINK_TOLERANCE)) {
    throw new EngramStoreShrinkError(filePath, disk, outgoingCount, base)
  }
  return { base, last: outgoingCount }
}

/**
 * Count engram records on disk, or `null` when there is nothing to compare against (no file, or a directory).
 * An EXISTING file it cannot count THROWS {@link EngramStoreUnreadableError}: `null` would let a write replace a
 * corrupt or unreadable store. Callers that declared `allowShrink` never reach this.
 */
function countEngramsOnDisk(filePath: string): number | null {
  let text: string
  try {
    if (!fs.existsSync(filePath)) return null
    if (fs.statSync(filePath).isDirectory()) return null
    text = fs.readFileSync(filePath, 'utf8')
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null // removed since the existence check
    throw new EngramStoreUnreadableError(filePath, err)
  }
  const scanned = countRecordStarts(text)
  // The scan recognised the document's shape — trust it. It is exact for any
  // block-sequence `engrams:` list, which is what `yaml.dump` emits and what
  // every store file in the wild is.
  if (scanned !== null) return scanned
  // Unrecognised shape (flow sequence `engrams: [...]`, anchors, an exotic
  // hand edit): the loader's own rule decides — it counts, or it throws. This
  // number can REFUSE a write, so it is never allowed to be an approximation.
  return engramStoreEntries(filePath, text, Buffer.byteLength(text)).length
}

/**
 * Exact number of records in an `engrams:` block sequence by scanning record-start lines, without a YAML parse
 * (this runs on every guarded write, and every `recall()` writes).
 * Exactness matters more than speed: return `null` (caller parses) for any shape not fully understood. Requires a
 * top-level block `engrams:` key; items are `- ` lines at the sequence indent; `- ` inside nested lists or
 * multi-line scalars is skipped.
 */
function countRecordStarts(text: string): number | null {
  const lines = text.split('\n')
  let i = 0
  // Find the top-level `engrams:` key (column 0, nothing but the key on it).
  while (i < lines.length && !/^engrams:\s*$/.test(lines[i])) {
    // A flow sequence (`engrams: [...]`) or an anchor is not a shape this
    // understands — hand it to the parser.
    if (/^engrams:\s*\S/.test(lines[i])) return null
    i++
  }
  if (i >= lines.length) return null // no block `engrams:` key at all
  i++

  let itemIndent: number | null = null
  let count = 0
  let blockScalarIndent: number | null = null

  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue

    const indent = line.length - line.trimStart().length

    // Inside a block scalar (`|`/`>`): every line more-indented than its key
    // belongs to the value, and may contain anything at all — including a
    // leading `- `. Skip until the indentation says it ended.
    if (blockScalarIndent !== null) {
      if (indent > blockScalarIndent) continue
      blockScalarIndent = null
    }

    // Dedent to column 0 ends the sequence (a sibling top-level key).
    if (indent === 0) break

    if (itemIndent === null) {
      if (!/^\s*-\s/.test(line)) return null // first entry is not a sequence item
      itemIndent = indent
    }

    if (indent === itemIndent && /^\s*-\s/.test(line)) {
      count++
    } else if (indent < itemIndent) {
      break // dedented out of the sequence
    }

    // Note a block-scalar header so its body cannot be miscounted.
    if (/:\s*[|>][-+0-9]*\s*$/.test(line)) blockScalarIndent = indent
  }

  return itemIndent === null ? null : count
}

/** Initialize an empty filesystem store file (creates parent dirs via atomicWrite).
 * Use this from index.ts instead of calling saveEngrams directly — keeps
 * the source-of-truth abstraction intact. */
export function initFilesystemStore(filePath: string): void {
  saveEngrams(filePath, [])
}

export interface LoadedPack {
  manifest: PackManifest
  engrams: Engram[]
}

function parseSkillMdFrontmatter(filePath: string): Record<string, any> {
  const content = fs.readFileSync(filePath, 'utf8')
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) throw new Error(`No frontmatter found in ${filePath}`)
  return yaml.load(match[1]) as Record<string, any>
}

export function loadPack(packDir: string): LoadedPack {
  const skillMdPath = `${packDir}/SKILL.md`
  const manifestYamlPath = `${packDir}/manifest.yaml`
  const engramsPath = `${packDir}/engrams.yaml`

  // SKILL.md is the canonical manifest. manifest.yaml is DEPRECATED: it still
  // loads (with a warning) and installPack auto-upgrades the installed copy to
  // SKILL.md, so existing manifest.yaml packs keep working.
  let rawManifest: Record<string, any>
  if (fs.existsSync(skillMdPath)) {
    rawManifest = parseSkillMdFrontmatter(skillMdPath)
  } else if (fs.existsSync(manifestYamlPath)) {
    logger.warning(
      `[plur:packs] ${packDir} ships a manifest.yaml — deprecated; use SKILL.md frontmatter. ` +
      `It is read for now and auto-upgraded to SKILL.md on install.`,
    )
    rawManifest = yaml.load(fs.readFileSync(manifestYamlPath, 'utf8')) as Record<string, any>
  } else {
    throw new Error(`No SKILL.md found in ${packDir} — a knowledge pack must ship a SKILL.md (manifest.yaml is deprecated)`)
  }

  // Validate the frontmatter, not just its presence: a SKILL.md with no
  // (or an invalid) manifest must fail with a clear error, not load empty.
  const result = PackManifestSchema.safeParse(rawManifest)
  if (!result.success) {
    const why = result.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new Error(`Invalid pack manifest in ${packDir} — SKILL.md frontmatter failed validation: ${why}`)
  }

  const manifest = result.data
  const engrams = loadEngrams(engramsPath)
  return { manifest, engrams }
}

/**
 * A directory an install creates next to the live pack and removes again
 * (`<dest>.installing-<pid>-<ms>` while staging, `<dest>.replacing-<pid>-<ms>`
 * during the swap). A crash can leave one behind. It is never a pack in its
 * own right — it carries the same manifest name as the pack it shadows — so
 * nothing that walks the packs directory may treat it as one.
 */
export function isTransientPackDir(entry: string): boolean {
  return /\.(installing|replacing)-\d+-\d+$/.test(entry)
}

export function loadAllPacks(packsDir: string): LoadedPack[] {
  if (!fs.existsSync(packsDir)) return []
  const packs: LoadedPack[] = []
  for (const entry of fs.readdirSync(packsDir)) {
    // An install's staging / displaced copy is not a pack: it shares the live
    // pack's manifest name and would load its engrams twice.
    if (isTransientPackDir(entry)) continue
    const packDir = `${packsDir}/${entry}`
    // An entry can vanish between readdir and stat — the registry lock file
    // released by a concurrent install or migration, or a staging directory
    // renamed into place. That is not an error in this listing.
    let isDir: boolean
    try { isDir = fs.statSync(packDir).isDirectory() } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    if (!isDir) continue
    if (!fs.existsSync(`${packDir}/SKILL.md`) && !fs.existsSync(`${packDir}/manifest.yaml`)) continue
    try {
      packs.push(loadPack(packDir))
    } catch (err) {
      logger.warning(`Failed to load pack ${entry}: ${err}`)
    }
  }
  return packs
}

/**
 * The id a pack row is loaded under: `<id>-pack-<pack slug>` (e.g. `ENG-2026-10-18-001-pack-deploy-tips`).
 * Pack ids are minted in the author's store and can equal (accidentally or on purpose) ids of my own memories, so
 * every read path namespaces them; two packs shipping one id also stay apart. Idempotent; fits the id alphabet.
 */
export function packEngramId(id: string, packName: string): string {
  const suffix = `-pack-${packIdSlug(packName)}`
  if (id.endsWith(suffix)) return id
  return `${id}${suffix}`
}

/**
 * The pack-name part of a pack id, one per pack name.
 *
 * A name already in slug form (`release-rules`) is used as it is. Any other
 * name (`Release Rules`, `release_rules`) is lowered to a slug and followed by
 * `--` and twelve hex digits of a SHA-256 digest of the exact name. A slug-form
 * name never contains `--`, so the two kinds cannot meet, and two other names
 * that lower to the same slug differ in the digest. Lowering alone would make
 * `Release Rules` and `release-rules` hand out one id for two packs' rows.
 */
function packIdSlug(packName: string): string {
  if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(packName)) return packName
  const digest = createHash('sha256').update(packName).digest('hex').slice(0, 12)
  return `${legacyPackIdSlug(packName)}--${digest}`
}

/** The pack-name part pack ids had before {@link packIdSlug}: the name lowered to a slug, nothing more. */
function legacyPackIdSlug(packName: string): string {
  return packName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'pack'
}

/**
 * The id a pack row had under the earlier pack-id scheme (lowered name, no
 * digest), given the row's current pack id. Null when the two schemes agree,
 * which is every pack whose name is already in slug form.
 *
 * Ids of the earlier form were handed out (lookups, my memories' relations,
 * receipts) and are not rewritten anywhere, so readers resolve them with
 * {@link matchLegacyPackId}.
 */
export function legacyPackEngramId(packRowId: string, packName: string): string | null {
  const current = `-pack-${packIdSlug(packName)}`
  const legacy = `-pack-${legacyPackIdSlug(packName)}`
  if (current === legacy) return null
  const original = packRowId.endsWith(current) ? packRowId.slice(0, -current.length) : packRowId
  return original.endsWith(legacy) ? original : `${original}${legacy}`
}

/**
 * The one pack row an id of the earlier pack-id form names, or null.
 *
 * Only for an id NO loaded row carries exactly: a current id always wins, so
 * the slug-form pack `release-rules`, whose id never changed, keeps
 * `…-pack-release-rules` even beside a `Release Rules` pack that had the same
 * id before. When two pack rows answer to one earlier id (`Release Rules` and
 * `release_rules` both lowered to `release-rules`), it names neither: that id
 * was already shared by both packs, and picking one would hand out the other
 * pack's text under it.
 */
export function matchLegacyPackId<T extends { id: string }>(
  rows: ReadonlyArray<{ row: T; pack: string }>,
  id: string,
): T | null {
  if (!id.includes('-pack-')) return null
  if (rows.some(r => r.row.id === id)) return null
  const hits = rows.filter(r => legacyPackEngramId(r.row.id, r.pack) === id)
  return hits.length === 1 ? hits[0].row : null
}

/**
 * A pack's rows as read paths hand them out: each under {@link packEngramId}, with every reference to ANOTHER ROW
 * OF THE SAME PACK (relations, associations, `derived_from`, `abstract`) rewritten too, so supersession and lookup
 * inside the pack keep working. References to ids the pack does not ship are left alone. Returns copies; the pack
 * file is never touched, so feedback write-back keeps the author's ids.
 */
export function namespacePackEngrams(engrams: Engram[], packName: string): Engram[] {
  const own = new Set(engrams.map(e => e.id))
  const ref = (target: string): string => own.has(target) ? packEngramId(target, packName) : target
  const refs = (list: unknown): unknown => Array.isArray(list) ? list.map(t => typeof t === 'string' ? ref(t) : t) : list
  return engrams.map(e => {
    const out: Engram = { ...e, id: packEngramId(e.id, packName) }
    if (e.relations) {
      const rel: Record<string, unknown> = { ...e.relations }
      for (const k of Object.keys(rel)) rel[k] = refs(rel[k])
      out.relations = rel as Engram['relations']
    }
    if (Array.isArray(e.associations)) {
      out.associations = e.associations.map(a => a && a.target_type === 'engram' && typeof a.target === 'string'
        ? { ...a, target: ref(a.target) }
        : a)
    }
    if (typeof e.derived_from === 'string') out.derived_from = ref(e.derived_from)
    if (typeof e.abstract === 'string') out.abstract = ref(e.abstract)
    return out
  })
}

/**
 * Namespace a store-local id the way read paths hand it back (`ENG-{storePrefix(scope)}-…`), so a write returns
 * an id a read could produce. Idempotent; an id with this scope's legacy prefix ({@link legacyStorePrefix}) is
 * upgraded rather than wrapped twice.
 */
export function namespaceEngramId(id: string, scope: string): string {
  const prefix = storePrefix(scope)
  if (new RegExp(`^(ENG|ABS|META)-${prefix}-`).test(id)) return id
  const legacy = new RegExp(`^(ENG|ABS|META)-${legacyStorePrefix(scope)}-(?=\\d{4}-)`)
  if (legacy.test(id)) return id.replace(legacy, `$1-${prefix}-`)
  return id.replace(/^(ENG|ABS|META)-/, `$1-${prefix}-`)
}

/**
 * The store prefix of a namespaced id and its bare form, or null for an id
 * that carries none. Both prefix forms parse: the current eleven letters and
 * the legacy three-letter form. A store prefix is always
 * followed by the four-digit year of the id it wraps, which is what tells it
 * apart from a bare id (`ENG-2026-…`) or a pack id.
 */
export function parseNamespacedId(id: string, anyTail = false): { kind: string; prefix: string; bare: string } | null {
  // `anyTail`: accept any id after the prefix, for callers that then check the
  // prefix against a CONFIGURED store's (server ids are dated, test stubs and
  // some older servers' are not). Never for stripping blind — a pack id like
  // `ENG-PACK-EM-006` parses that way too.
  const m = (anyTail ? /^(ENG|ABS|META)-([A-Z]{2,11})-(?=[A-Za-z0-9])/ : /^(ENG|ABS|META)-([A-Z]{2,11})-(?=\d{4}-)/).exec(id)
  if (!m) return null
  return { kind: m[1], prefix: m[2], bare: `${m[1]}-${id.slice(m[0].length)}` }
}

/**
 * Strip any store namespace prefix from an ID to obtain its bare form.
 * E.g. 'ENG-GPLKQZA-2026-08-13-025' -> 'ENG-2026-08-13-025'. The legacy
 * three-letter form ('ENG-GPL-2026-08-13-025') strips the same way.
 */
export function bareEngramId(id: string): string {
  return parseNamespacedId(id)?.bare ?? id
}

/**
 * The legacy three-letter store prefix
 * (e.g. 'datafund' → 'DFU', 'project:myapp' → 'PMY').
 *
 * Lossy: every `group:<org>/<team>` scope of one org gets the same one, so two
 * team stores minting the same server id on the same day would hand out one
 * namespaced id for two engrams. Kept only to READ ids in
 * that form — history, injection records and ids an agent still holds — never
 * to mint one.
 */
export function legacyStorePrefix(scope: string): string {
  const parts = scope.split(/[:\-_./]/).filter(Boolean)
  if (parts.length >= 2) {
    // Multi-part: first char of part1 + first 2 chars of part2
    const p2 = parts[1]
    return (parts[0][0] + p2[0] + (p2[1] || p2[0])).toUpperCase()
  }
  // Single word: first + middle + last char
  const w = parts[0] || scope
  if (w.length >= 3) return (w[0] + w[Math.floor(w.length / 2)] + w[w.length - 1]).toUpperCase()
  // Very short: pad with repeat
  return (w[0] + (w[1] || w[0]) + (w[2] || w[0])).toUpperCase()
}

/**
 * A store's namespace prefix: the three letters of {@link legacyStorePrefix} plus eight letters of SHA-256(scope),
 * so scopes sharing three letters still differ. Derived from the scope alone because every id path holds the scope
 * but not always the store entry. Two stores with the SAME scope share a prefix; action paths resolve to the one
 * store holding the row and refuse ambiguity. Letters only, to keep matching `^(ENG|ABS|META)-[A-Za-z0-9-]+$`.
 */
export function storePrefix(scope: string): string {
  const digest = createHash('sha256').update(scope).digest()
  let tag = ''
  // Eight letters (26^8 ≈ 2·10^11 per three-letter bucket): a collision among
  // 100k scopes of one org is about 2%, so configured scopes are still checked
  // for one (`Plur._sharedPrefixScopes`) and refused for actions by id.
  for (let i = 0; i < 8; i++) tag += String.fromCharCode(65 + (digest[i] % 26))
  return legacyStorePrefix(scope) + tag
}

/**
 * Generate the next local engram id: `ENG-YYYY-MM-DD-NNN` (same shape as server-minted ids). The legacy
 * `ENG-YYYY-MMDD-NNN` form is still parsed (spec/ENGRAM-STANDARD-v1.md §3.3) and counted in the day's sequence,
 * but never minted.
 */
/**
 * Today's id prefix `ENG-YYYY-MM-DD-`, shared by {@link generateEngramId} and `PrimaryStore.nextEngramId` so the
 * format cannot drift.
 */
export function engramIdDatePrefix(now: Date = new Date()): string {
  return `ENG-${now.toISOString().slice(0, 10)}-`
}

export function generateEngramId(existing: Engram[], alsoAllocated: Iterable<string> = []): string {
  const day = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const prefix = `ENG-${day}-`
  // Legacy compact form: ENG-YYYYMMDD → ENG-YYYY-MMDD-
  const legacyPrefix = `ENG-${day.slice(0, 4)}-${day.slice(5, 7)}${day.slice(8, 10)}-`
  const suffixOf = (id: string): number | null => {
    const p = id.startsWith(prefix) ? prefix : id.startsWith(legacyPrefix) ? legacyPrefix : null
    if (p === null) return null
    const n = parseInt(id.slice(p.length), 10)
    return isNaN(n) ? null : n
  }
  let max = 0
  for (const e of existing) {
    const n = suffixOf(e.id)
    if (n !== null && n > max) max = n
  }
  // Also count ids minted earlier that are no longer in the corpus (`compact()` frees ids): reusing one would merge
  // two engrams' history, restore diffs and `supersedes` edges. Callers pass ids from the append-only history log.
  // Purely additive — it can only raise `max`, so an incomplete list never causes a new collision.
  for (const id of alsoAllocated) {
    const n = suffixOf(id)
    if (n !== null && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`
}
