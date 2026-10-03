import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { EngramSchemaPassthrough, type Engram } from './schemas/engram.js'
import { PackManifestSchema, type PackManifest } from './schemas/pack.js'
import { logger } from './logger.js'
import { atomicWrite, fsyncDir } from './sync.js'
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
 * Read engrams from a YAML store.
 *
 * ## Why a parse failure THROWS instead of returning []
 *
 * A missing file really is an empty store, so that returns `[]`. A file that
 * exists but will not parse is a different fact, and conflating the two used to
 * destroy data:
 *
 *   1. `engrams.yaml` becomes unparseable — most plausibly a git merge conflict
 *      after `plur sync`, which puts `<<<<<<<` markers straight into the file.
 *   2. This function caught the error, logged it, and returned `[]`.
 *   3. Every `Plur` write is load -> mutate -> save, and `save` replaces the
 *      WHOLE file. So the next `learn()` wrote a one-engram corpus.
 *   4. Every prior engram was gone, unrecoverable from the file.
 *
 * Measured before the fix: a store with 5 engrams, corrupted, then one write —
 * the file afterwards contained exactly 1 engram and none of the originals.
 * The `logger.error` on the way past was visible, but the RETURN VALUE lied,
 * and the caller acted on the return value.
 *
 * So: unreadable is not empty. Callers that genuinely want "treat unreadable as
 * empty" — a diagnostic counter, a best-effort probe — must catch
 * {@link EngramStoreUnreadableError} and say so at the call site.
 *
 * ## What #766 missed, and this fixes (audit #794, F1/F2)
 *
 * The original throw only fired when `yaml.load` itself threw. An adversarial
 * audit found three corruption classes that never throw, all of which reached
 * `return []` and were then persisted by the next write:
 *
 *   - a ZERO-LENGTH file: `yaml.load('')` returns `undefined`, not an error.
 *     This is the canonical artifact of a power cut (see the fsync note on
 *     `atomicWrite`), so the two bugs composed into total corpus loss.
 *   - a file that parses to a mapping with NO `engrams` key — a truncation that
 *     happens to land on a document boundary, or a half-written header.
 *   - per-entry schema failures, which were silently dropped from the returned
 *     array and therefore deleted by the next unrelated write.
 *
 * Measured: 5 engrams -> 0 via `feedback`/`forget`/`compact` and even via
 * `recall()` alone (reactivation writes activation back). The probe is
 * `probe/p01-corrupt.ts`.
 *
 * A missing file is still `[]` — that is a genuinely empty store and the only
 * way a first run can work. An EXISTING file that says nothing intelligible is
 * now an error, because PLUR cannot tell an empty corpus from a destroyed one,
 * and guessing wrong in that direction is unrecoverable.
 *
 * Individually invalid ENTRIES are no longer dropped. They are QUARANTINED:
 * kept out of the returned array (callers must not reason about entries that
 * do not typecheck) but preserved verbatim so {@link saveEngrams} writes them
 * back. A malformed engram is a partial-data problem; deleting it to tidy up
 * the file is a data-loss problem, and the second is worse.
 */
/**
 * The shape rule for an engram store document — THE one definition, shared by
 * every reader of a store file (formal round 2, core-persistence#11): this
 * loader, sync's push-set strip (sync.ts `readEngramList`) and the backup gate
 * (backup.ts `validateStore`). Before, sync also accepted a bare top-level
 * array that this loader refuses, so sync would strip, commit and push a file
 * PLUR itself cannot load.
 *
 * Returns the raw entries of `engrams:`, or throws {@link EngramStoreUnreadableError}.
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
  // write turns a truncated 5,000-engram store into a valid 1-engram one, which
  // then syncs and can replace subsequent backups. Demonstrated: 5 engrams,
  // file truncated to `engrams:\n`, one learn -> 1 engram on disk (#811 audit,
  // finding 4). An earlier version of this parser accepted it, and a test
  // blessed the behaviour.
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
  // Field-compat rules live in ONE place (#877) — normalise before parse, so
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

/** Whether two raw records carry the same content (key order ignored) — the P1 "exact duplicate" test. */
export function sameEngramContent(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

/** One id change made by {@link resolveDuplicateIds} (or by sync's restore). */
export interface IdRename { from: string; to: string }

/**
 * The fresh id a clashing copy gets: `<id>-D<8 hex of sha256(content)>`, with
 * `-2`, `-3`, … appended only if that is already taken.
 *
 * DETERMINISTIC on purpose. The rename happens when a reader detects the clash,
 * and several readers read one file (the loader, the PGLite index, a second
 * process) before anyone writes it back. Derived from the copy's own content,
 * every one of them arrives at the same id without coordinating, and reading
 * the file twice records one rename, not two. Keeps the original id as a prefix
 * so the date and the history trail stay legible, and matches the schema's id
 * pattern (`^(ENG|ABS|META)-[A-Za-z0-9-]+$`).
 */
export function freshDuplicateId(id: string, entry: unknown, taken: ReadonlySet<string>): string {
  const h = createHash('sha256').update(canonicalJson(entry)).digest('hex').slice(0, 8)
  const base = `${id}-D${h}`
  let candidate = base
  for (let k = 2; taken.has(candidate); k++) candidate = `${base}-${k}`
  return candidate
}

/**
 * THE duplicate-id rule (owner decision P1, 2026-09-27: "keep both, rename
 * one"). One rule for every reader — the loader, the PGLite index, the
 * Postgres writer; the backup gate accepts what this resolves.
 *
 * Two different engrams can carry one id without anyone editing a file:
 * `generateEngramId` mints `max(same-day suffix)+1` per machine, so two synced
 * machines that learn on the same day mint the same id. Before this rule the
 * readers disagreed on which copy was "the" engram (YAML lookups saw the first,
 * the PGLite index the last, Postgres refused), and the other copy could not be
 * reached by id at all.
 *
 * - The FIRST copy keeps the id.
 * - A LATER copy with different content gets {@link freshDuplicateId}.
 * - A later copy identical to a kept copy of that id is an exact duplicate, not
 *   a clash: it is dropped (nothing is lost) and counted in `exactDuplicates`.
 *
 * Pure. Callers record `renames` (see {@link recordIdRenames}). `alsoTaken`
 * reserves ids that are not in `entries` (e.g. quarantined rows).
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
 * ONE history pass for all of `renames` (audit of #1228, finding 2): this used
 * to call `readHistoryForEngram` per rename, re-reading every month each time,
 * and it ran from `loadEngrams` — so every read-only process paid renames ×
 * the whole log (250 s for 300 renames against a 29 MB log). Write paths only:
 * see {@link loadEngrams} and {@link saveEngrams}.
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
 * index sync — and must not append history (audit of #1228, finding 2), so the
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
 * there are none. Audit of #1228, finding 1: these used to live only in the
 * sync process's memory between resetting the working tree and restoring it,
 * so a Ctrl-C, SIGTERM or SIGKILL during the (up to 30 s) pull deleted every
 * scope:local engram.
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

/**
 * Durably record `files` as held (write + fsync + rename + fsync dir), or delete
 * the recovery file when `files` is empty. Called BEFORE the tree is reset and
 * again, to delete it, only AFTER every held record is back.
 */
export function writeHeldRecovery(root: string, files: readonly HeldFile[]): void {
  const p = heldRecoveryPath(root)
  if (files.length === 0) {
    try { fs.unlinkSync(p) } catch { return }
    fsyncDir(path.dirname(p))
    return
  }
  atomicWrite(p, JSON.stringify({
    version: 1,
    note: 'Records a plur sync set aside during git pull (never pushed). Restored automatically; do not delete by hand.',
    files,
  }), { mode: 0o600 })
}

/**
 * Held records to put back into a record list, and the renames that needs.
 *
 * Owner decision P1b: a held record whose id the list already carries with
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
    return readHeldRecovery(root)?.find(f => f.file === 'engrams.yaml')?.held ?? null
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
 * The single definition of "is this a readable engram store". It exists as a
 * standalone function because the rules were previously written out twice —
 * once in {@link loadEngrams} and once in a since-removed parallel YAML
 * store — and the copies drifted:
 * #766 hardened the first and left the second returning `[]` for a file it
 * could not parse (audit #794, F14). Anything that reads a store file goes
 * through here so that cannot recur.
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
  // Owner decision P1: a clashing id keeps both copies, the later one renamed.
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
 *
 * These carried the same defect the engram store did (audit #794 F1/F2, still
 * live after the first remediation and re-found by the #811 audit): an
 * unparseable or wrongly-shaped file returned `[]`, and since every writer
 * rewrites the whole array, the next capture persisted that emptiness. A
 * corrupt episodes.yaml became a one-episode file; a tensions.yaml with
 * schema-invalid entries silently lost them.
 *
 * Missing file is still `[]` — that is a genuinely empty store. An EXISTING
 * file that says nothing intelligible is an error. Individually invalid entries
 * are QUARANTINED and handed back to the caller so they can be written out
 * again, never dropped.
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

export function loadEngrams(filePath: string): Engram[] {
  if (!fs.existsSync(filePath)) return []
  // A directory is a misconfiguration (`stores[].path` must name an
  // engrams.yaml, since it is handed straight to this function) — but NOT a
  // data-loss risk, which is what the throw below exists for. `saveEngrams`
  // cannot write to a directory either, so there is no path where a directory
  // read as "empty" leads to an overwrite. Treating it as empty preserves
  // long-standing behaviour; the throw is reserved for the case that actually
  // destroys data.
  const stat = fs.statSync(filePath)
  if (stat.isDirectory()) return []
  const content = fs.readFileSync(filePath, 'utf8')
  let entries = engramStoreEntries(filePath, content, stat.size)
  // Audit of #1228, finding 1: while a sync has scope:local records set aside
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
  // Recorded by the next write, not here: a load is a read (finding 2).
  const pending: PendingRename[] = [
    ...heldRenames.map(r => ({ ...r, reason: SYNC_HELD_RENAME_REASON, data: { store: filePath, cause: 'sync-recovery' } })),
    ...renames.map(r => ({ ...r, reason: 'duplicate id: a later, different copy was given a fresh id (P1)', data: { store: filePath } })),
  ]
  if (pending.length > 0) pendingRenamesByPath.set(key, pending)
  else pendingRenamesByPath.delete(key)
  return valid
}

/** History reason for a held (never-pushed) record re-id'd against a pulled one (P1b). */
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
 * Exact-duplicate records the last load of a path read once (P1). The file
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
 * Entries that failed schema validation on the last load of a given file.
 *
 * Keyed by resolved path so a save can put them back. This is deliberately
 * module-level rather than threaded through every caller: `loadEngrams` and
 * `saveEngrams` are called by ~20 write paths that all follow load -> mutate ->
 * save on the same file, and changing all of their signatures to carry an
 * opaque payload they never inspect would be far more invasive — and far easier
 * to get wrong — than one map keyed on the thing they already agree about.
 *
 * PRECONDITION, not a self-healing property: a writer must `loadEngrams` the
 * same path before it saves. `saveEngrams` re-attaches whatever this map holds
 * for that path from the last load IN THIS PROCESS — it does not re-parse the
 * file, and an earlier version of this comment claimed it did (2026-08-13
 * data-loss audit, F6). Every in-tree writer satisfies the precondition
 * because they all load under the lock immediately before saving, so the
 * entries are fresh in practice; the point of stating it as a precondition is
 * that a future writer which saves WITHOUT a preceding load would either
 * re-inject a stale quarantine set or, with an empty map, drop quarantined
 * rows. An id that has since become valid is de-duplicated against the
 * outgoing array, so the failure mode is confined to that one case.
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
   * the error go away" reinstates the exact bug the guard exists to catch.
   */
  allowShrink?: boolean
}

/**
 * How much of the corpus undeclared writes may remove before it is treated as
 * corruption. Small deletions still happen legitimately through paths that
 * forget to declare themselves; a >10% drop is not a rounding error.
 *
 * CUMULATIVE (owner decision P2, 2026-09-27, "gate every removal"; proved by
 * `PlurSpec.R2Persist.Shrink.base_bounds`): the 10% is measured from the
 * baseline — the count at this process's last write to the file that did not
 * shrink it, or that declared `allowShrink`. It used to be measured from the
 * file as it was just then, so ten tolerated writes took 100 engrams to 37
 * without a refusal. See {@link shrinkRuns}.
 */
const SHRINK_TOLERANCE = 0.1

/**
 * Per store file: the baseline of the current run of undeclared shrinks, and
 * the record count this process last wrote there. In process only — no new
 * persisted state; a restart starts a new run.
 *
 * `last` is how a run ends when someone ELSE writes the file: if the count on
 * disk is no longer what this process wrote (another process, a sync pull, a
 * hand edit), this process cannot judge that change, so the baseline restarts
 * at the file as it now is. Otherwise a legitimate removal made elsewhere would
 * leave a stale, higher baseline here and refuse this process's next small
 * removal.
 */
interface ShrinkRun { base: number; last: number }
const shrinkRuns = new Map<string, ShrinkRun>()

/**
 * Write the whole corpus to a store file.
 *
 * ## Why there is a guard here as well as in the loader (audit #794)
 *
 * Both ends are load-bearing, and each is provably insufficient alone:
 *
 *   - loader-only fails, because F2 and F3's plain-store case reach the writer
 *     through a loader that had nothing to report — the entries parsed, they
 *     just did not typecheck, or the store was a save-only backend with no
 *     append semantics to refuse with.
 *   - seam-only fails, because the wipe fires from eight-plus `_writeEngrams`
 *     call sites that never touch the incremental write seam at all.
 *
 * So the invariant lives at the choke point every writer already funnels
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
      // A quarantined entry whose id a valid engram also carries used to be
      // DROPPED here ("re-added properly, must not come back as a malformed
      // duplicate"). That lost the entry whenever the two were different
      // engrams — the same-day id clash P1 is about. Owner principle "keep both,
      // rename one — nothing lost or hidden" (2026-09-27): keep it, verbatim
      // except for a fresh id by the same rule as the loader, so both stay
      // addressable; recorded in history.
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
  // The count check is UNCONDITIONAL (audit 2026-08-03, finding 5).
  //
  // It used to sit behind a byte-size pre-check: only a write whose serialized
  // length was >5% smaller than the file on disk paid for an exact count. That
  // pre-check encoded an assumption its own comment stated out loud — "records
  // are broadly similar in size" — and engrams are not. One carrying
  // `rationale`, `dual_coding` and `knowledge_anchors` outweighs a bare
  // statement several times over. So a write that dropped 11 of 100 records
  // moved the COUNT 11% (past this guard) while moving BYTES under 5%, the
  // pre-check returned false, and the guard never ran at all. A data-loss write
  // succeeded through the very check that exists to stop it.
  //
  // The reason for gating it was real — the exact count was a full YAML parse,
  // on a path `_reactivateResults` makes every recall() take. The fix is to make
  // counting cheap rather than to skip it: `countEngramsOnDisk` now scans for
  // record-start lines instead of parsing, falling back to the parse only when
  // the structure is not recognisable.
  //
  // Measured, 20,000 engrams / 19.1 MB, median of 5 (probe/bench-shrink-count.ts):
  //   save with the guard      432ms
  //   save with allowShrink    370ms   -> the guard costs 62ms
  //   the old parse-based count would have added 246ms to that same save.
  // So the guard now runs on every write for a quarter of what it used to cost
  // on the rare writes it actually ran on.
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
  // Record what PLUR itself wrote (owner decision P2, formal run 2026-09-26):
  // the daily backup's shrink gate compares the file against this count, so a
  // deliberate removal re-baselines it while a file that shrank without PLUR
  // writing it is still refused. After the write, so it records what landed.
  recordLastWritten(filePath, outgoing.length)
}

/**
 * Refuse a whole-corpus write that drops more than {@link SHRINK_TOLERANCE} of
 * the records on disk.
 *
 * Extracted so it is a SHARED FUNCTION rather than a step inside one writer
 * (#824, found in Črt's independent review). The guard once lived only in
 * `saveEngrams` while a second, parallel whole-corpus YAML writer (the
 * `EngramStore`-era `YamlStore`, removed in the 2026-09 audit) dumped straight
 * to disk without it. `saveEngrams` is now the ONLY whole-corpus YAML writer
 * in core; a future writer must call this before touching the file. #824
 * tracks making it a type every writer must pass through.
 */
export function assertShrinkAllowed(filePath: string, outgoingCount: number): void {
  judgeShrink(filePath, outgoingCount)
}

/**
 * The guard itself: throws, or returns the run state to record once the write
 * lands. Branch for branch `ratchetBase` in `PlurSpec.R2Persist.Shrink`:
 *
 *   - nothing to compare against (no file)          -> allowed, new run at `out`
 *   - `out >= disk` (not a shrink)                   -> allowed, new run at `out`
 *   - a shrink: baseline = the run's, if the file is
 *     still what this process last wrote, else disk -> allowed iff
 *                                                      `out >= 90% of baseline`
 *
 * Since the baseline is never below the file's count, a write allowed here is
 * always allowed by the old per-write rule too (theorem `new_implies_old`).
 */
function judgeShrink(filePath: string, outgoingCount: number): ShrinkRun {
  const key = resolveKey(filePath)
  const counted = countEngramsOnDisk(filePath)
  if (counted === null) return { base: outgoingCount, last: outgoingCount }
  // Exact duplicates the loader read once are not engrams this write removes (P1).
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
 * Count engram records currently on disk, or `null` when there is nothing to
 * compare against (no file yet, or a directory — a misconfiguration the write
 * itself fails on, not a data-loss risk).
 *
 * An EXISTING file it cannot count THROWS {@link EngramStoreUnreadableError}
 * (formal round 2, core-persistence#12). It used to return `null` here too, and
 * `null` lets every write through: a store with merge-conflict markers (both
 * sides' engrams in it), a zero-byte file, or one this process cannot read was
 * replaced by whatever array the caller held. The comment then said callers
 * "already went through `loadEngrams`" — true of the file as it was THEN, not of
 * the file being replaced now. Same rule as the loader: PLUR cannot tell an
 * empty corpus from a destroyed one, so it does not overwrite either. A caller
 * that declared `allowShrink` never reaches this.
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
 * Exact number of records in an `engrams:` block sequence, by scanning for
 * record-start lines — no YAML parse (audit 2026-08-03, finding 5).
 *
 * Counting has to be cheap because it now runs on EVERY guarded write, and
 * `_reactivateResults` makes every `recall()` a write. A full parse cost 388ms
 * on a 20,000-engram / 15.7MB store; this reads the same file and never builds
 * an object graph.
 *
 * Exactness matters more than speed here — the result can refuse a write — so
 * this returns `null` rather than a guess whenever the document is not a shape
 * it fully understands, and the caller parses instead:
 *
 *   - the top-level `engrams:` key must be present as a block key;
 *   - its items are the lines at the sequence's own indent starting with `- `;
 *   - a `- ` appearing inside a nested list or a multi-line scalar is NOT a
 *     record start, so both are skipped explicitly rather than counted.
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
 * the source-of-truth abstraction intact (#766). */
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

  // SKILL.md is the canonical manifest. manifest.yaml is DEPRECATED (#325): it
  // still loads (with a warning) and installPack auto-upgrades the installed copy
  // to SKILL.md — we don't hard-break existing manifest.yaml packs.
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

  // Validate the frontmatter, not just its presence (#325): a SKILL.md with no
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
 * Namespace a store-local id the way the read paths hand it back.
 *
 * A store's ids are prefixed with `ENG-{storePrefix(scope)}-` on load so ids
 * from different stores cannot collide locally. The write path has to return
 * the same shape, or a caller that records what it just wrote is holding an id
 * no read path ever produced (#914). Idempotent: an already-namespaced id is
 * returned unchanged, so the two call sites can't double-prefix each other.
 *
 * An id carrying this scope's OLD three-letter prefix (releases up to 0.21.0,
 * see {@link legacyStorePrefix}) is upgraded to the current prefix rather than
 * wrapped a second time — a store file can hold such an id verbatim.
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
 * that carries none. Both prefix forms parse: the current seven letters and
 * the three-letter form of releases up to 0.21.0. A store prefix is always
 * followed by the four-digit year of the id it wraps, which is what tells it
 * apart from a bare id (`ENG-2026-…`) or a pack id.
 */
export function parseNamespacedId(id: string, anyTail = false): { kind: string; prefix: string; bare: string } | null {
  // `anyTail`: accept any id after the prefix, for callers that then check the
  // prefix against a CONFIGURED store's (server ids are dated, test stubs and
  // some older servers' are not). Never for stripping blind — a pack id like
  // `ENG-PACK-EM-006` parses that way too.
  const m = (anyTail ? /^(ENG|ABS|META)-([A-Z]{2,8})-(?=[A-Za-z0-9])/ : /^(ENG|ABS|META)-([A-Z]{2,8})-(?=\d{4}-)/).exec(id)
  if (!m) return null
  return { kind: m[1], prefix: m[2], bare: `${m[1]}-${id.slice(m[0].length)}` }
}

/**
 * Strip any store namespace prefix from an ID to obtain its bare form (#1119).
 * E.g. 'ENG-GPLKQZA-2026-08-13-025' -> 'ENG-2026-08-13-025'. The old
 * three-letter form ('ENG-GPL-2026-08-13-025') strips the same way.
 */
export function bareEngramId(id: string): string {
  return parseNamespacedId(id)?.bare ?? id
}

/**
 * The three-letter prefix releases up to 0.21.0 gave a store
 * (e.g. 'datafund' → 'DFU', 'project:myapp' → 'PMY').
 *
 * Lossy: every `group:<org>/<team>` scope of one org got the same one, so two
 * team stores minting the same server id on the same day handed out one
 * namespaced id for two engrams (0.21.1 audit, H1). Kept only to READ ids in
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
 * The namespace prefix of a store: the readable three letters of
 * {@link legacyStorePrefix} plus four letters of a SHA-256 digest of the whole
 * scope (e.g. 'group:plur/eng' → 'GPL' + four letters), so two scopes that
 * share the first three no longer share a prefix (0.21.1 audit, H1).
 *
 * Derived from the scope alone, on purpose: every read and write path that
 * namespaces an id holds the scope, while several hold no store entry, and a
 * prefix one path cannot compute is how save and recall drifted apart before
 * (#914, #1568). Two configured stores with the SAME scope (one scope on two
 * servers, or a path store and a url store) share a prefix; the action paths
 * resolve such an id to the one store that holds the row, and refuse it as
 * ambiguous when more than one does.
 *
 * Letters only, so ids keep matching `^(ENG|ABS|META)-[A-Za-z0-9-]+$` and the
 * `[A-Z]+` readers.
 */
export function storePrefix(scope: string): string {
  const digest = createHash('sha256').update(scope).digest()
  let tag = ''
  for (let i = 0; i < 4; i++) tag += String.fromCharCode(65 + (digest[i] % 26))
  return legacyStorePrefix(scope) + tag
}

/**
 * Generate the next local engram id.
 *
 * Canonical format (#771): `ENG-YYYY-MM-DD-NNN` — full ISO-8601 date
 * separators, identical to the id shape the enterprise server assigns, so an
 * engram gets the same id whether it is minted locally or server-side.
 * Releases before this minted a compact date (`ENG-YYYY-MMDD-NNN`); those ids
 * remain valid forever — every parser accepts both forms (see
 * spec/ENGRAM-STANDARD-v1.md §3.3) — but new ids are no longer minted compact.
 *
 * The per-day sequence counts BOTH forms, so a store upgraded mid-day
 * continues numbering after its compact-form ids instead of restarting at 001.
 */
/**
 * The canonical id prefix for today, `ENG-YYYY-MM-DD-`.
 *
 * Exported so the one place that mints ids from a corpus
 * ({@link generateEngramId}) and the one that delegates minting to the store
 * (`PrimaryStore.nextEngramId`) cannot drift apart on the format — a store
 * queried with a prefix the engine does not itself use would allocate ids in a
 * namespace nothing else counts.
 */
export function engramIdDatePrefix(now: Date = new Date()): string {
  return `ENG-${now.toISOString().slice(0, 10)}-`
}

export function generateEngramId(existing: Engram[], alsoAllocated: Iterable<string> = []): string {
  const day = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const prefix = `ENG-${day}-`
  // Legacy compact form minted by earlier releases: ENG-YYYYMMDD → ENG-YYYY-MMDD-
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
  // Ids that were minted and are no longer in the corpus (#816).
  //
  // The corpus is not a record of what has been ALLOCATED, only of what
  // currently exists — `compact()` removes rows and frees their ids, so the
  // next `learn()` mints an id a different engram already had. Everything
  // keyed by id that outlives the corpus entry then merges two lives into one:
  // history narrates a single story out of two, a restore diff reads a
  // substitution as an edit, and a `supersedes` edge silently re-targets.
  //
  // Callers pass the ids this store has minted (from the append-only history
  // log, which never forgets). Purely additive: this can only raise `max`, so
  // an incomplete list degrades to the previous behaviour and can never cause
  // a collision that the previous behaviour would have avoided.
  for (const id of alsoAllocated) {
    const n = suffixOf(id)
    if (n !== null && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`
}
