/**
 * Validity-gated daily backups of the engram store (audit #794, issue #799).
 *
 * ## Why this exists
 *
 * Every finding in #794 that ends "the corpus is gone" ends there because there
 * was nothing to restore from. The guards added in #795/#796 are refusals: they
 * stop PLUR making a bad situation worse. They cannot recover bytes that a
 * truncation already destroyed. Only a backup can.
 *
 * ## Why the gate is the feature
 *
 * Backing up an already-corrupt file is worse than not backing up at all: it
 * costs the same, and it quietly replaces the last good copy with a bad one, so
 * the user discovers at restore time that their safety net was cut days ago.
 * A snapshot is therefore only taken when the current file passes every check
 * in {@link validateStore}.
 *
 * ## Why the hook is where it is
 *
 * The snapshot is taken from inside `_withStoreLock(paths.engrams, …)`, before
 * `store.load()`, on the first such acquisition per process per day. Both halves
 * of that ordering are load-bearing:
 *
 *   - INSIDE the lock, so it cannot copy a half-written file
 *   - BEFORE the load, so it copies the on-disk bytes before any write path can
 *     replace them
 *
 * Constructor time would be wrong: read-only instances and `plur status` would
 * trigger it, and #731 forbids write side effects there.
 *
 * ## What it costs, and the one interaction to watch
 *
 * Measured on a 50,000-engram / 39 MB store: **1.4 s** for the first write of
 * the day (validate + copy + fsync), and **0 ms** for every write after it —
 * short-circuited in-process, and by the state file for a second process the
 * same day. So a normal day costs one copy, not one per write.
 *
 * That 1.4 s lands INSIDE the store lock, which is the trade this ordering
 * buys. It matters because it narrows the margin on the still-open stale-lock
 * finding (#804 / audit F9): the audit measured a 50k store already holding the
 * lock ~4.9 s (2.4 s save + 2.4 s load) against a 10 s stale threshold, and this
 * takes that to ~6.3 s once per day. Still under the threshold, but the headroom
 * drops by roughly a quarter on the largest stores — which is an argument for
 * fixing F9's liveness check rather than a reason to move the backup out from
 * under the lock, since moving it there would reintroduce the half-written-file
 * race this ordering exists to prevent.
 */
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import * as yaml from 'js-yaml'
import { EngramSchemaPassthrough } from './schemas/engram.js'
import { logger } from './logger.js'
import { atomicWrite, withLock } from './sync.js'

/** Directory under the plur root holding snapshots and their state. */
export const BACKUP_DIR = 'backups'

/**
 * Keep this many day-granularity snapshots.
 *
 * ## Disk cost
 *
 * Snapshots are uncompressed copies of the whole store, so the retained set
 * costs up to `(KEEP_DAILY + KEEP_WEEKLY) x store size`. Measured against real
 * stores: a 10 MB store (~5,000 engrams) retains ~113 MB; a 39 MB store
 * (50,000 engrams) retains ~431 MB.
 *
 * Uncompressed is the deliberate choice at these sizes: a backup you can read,
 * diff and hand to `git` beats one that needs tooling to inspect, and the whole
 * point of the validity gate is that a human can check what was kept. If the
 * footprint becomes a problem it is the WEEKLY tier to shorten first — the
 * daily window is what actually gets restored from.
 */
const KEEP_DAILY = 7

/** Keep this many week-granularity snapshots beyond the daily window. */
const KEEP_WEEKLY = 4

/**
 * How far the corpus may shrink against the last known-good count before a
 * snapshot is refused. Mirrors the write-path shrink guard in engrams.ts.
 */
const SHRINK_TOLERANCE = 0.1

export interface StoreValidity {
  ok: boolean
  /** Machine-readable failure codes, empty when ok. */
  failures: string[]
  /** Human-readable explanation of each failure, in the same order. */
  reasons: string[]
  /** Engram records counted, or null when the file could not be parsed at all. */
  count: number | null
}

interface BackupState {
  /** YYYY-MM-DD of the last snapshot attempt that succeeded. */
  last_backup_date?: string
  /** Record count of the last snapshot that passed the gate. */
  last_good_count?: number
  /** sha256 of the last snapshot that passed the gate. */
  last_good_sha256?: string
}

function statePath(root: string): string {
  return path.join(root, BACKUP_DIR, '.state.json')
}

function readState(root: string): BackupState {
  try {
    return JSON.parse(fs.readFileSync(statePath(root), 'utf8')) as BackupState
  } catch {
    return {}
  }
}

function writeState(root: string, state: BackupState): void {
  const p = statePath(root)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n', 'utf8')
}

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Decide whether a store file is fit to be backed up (or restored from).
 *
 * The checks map 1:1 onto the audit's protection design:
 *
 *   (a) parses
 *   (b) no schema-invalid entries — catches the F2 silent-delete case
 *   (c) count is not far below the last known-good — catches the F1 truncation
 *       case, and is the ONLY check that can, since a truncated file is
 *       perfectly valid YAML describing a smaller corpus
 *   (d) ids unique and non-empty
 *   (e) non-zero size, and the file ends with a newline as PLUR's writer always
 *       does — a cheap tell for a write cut short
 *
 * `lastGoodCount` is optional because the first ever snapshot has no baseline;
 * (c) is skipped in that case rather than guessed at.
 */
export function validateStore(filePath: string, lastGoodCount?: number): StoreValidity {
  const failures: string[] = []
  const reasons: string[] = []

  let raw: Buffer
  try {
    raw = fs.readFileSync(filePath)
  } catch (err) {
    return { ok: false, failures: ['unreadable'], reasons: [`cannot read ${filePath}: ${err}`], count: null }
  }

  // (e) — size and terminator
  if (raw.length === 0) {
    return { ok: false, failures: ['empty'], reasons: ['file is 0 bytes'], count: null }
  }
  if (!raw.toString('utf8').endsWith('\n')) {
    failures.push('truncated')
    reasons.push('file does not end with a newline — PLUR\'s writer always emits one, so this looks cut short')
  }

  // (a) — parses, and is the shape of a store
  let doc: any
  try {
    doc = yaml.load(raw.toString('utf8'))
  } catch (err) {
    return { ok: false, failures: ['unparseable'], reasons: [`YAML parse failed: ${err}`], count: null }
  }
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.engrams)) {
    return {
      ok: false,
      failures: ['not-a-store'],
      reasons: ['parsed, but is not a mapping with an `engrams` list'],
      count: null,
    }
  }

  const entries: unknown[] = doc.engrams
  const count = entries.length

  // (b) — every entry typechecks
  let invalid = 0
  const ids = new Set<string>()
  let duplicateIds = 0
  let missingIds = 0
  for (const entry of entries) {
    if (!EngramSchemaPassthrough.safeParse(entry).success) invalid++
    // (d) — ids unique and non-empty. Checked on the raw entry so a
    // schema-invalid record still contributes its id to the uniqueness check.
    const id = (entry as any)?.id
    if (typeof id !== 'string' || id.length === 0) missingIds++
    else if (ids.has(id)) duplicateIds++
    else ids.add(id)
  }
  if (invalid > 0) {
    failures.push('invalid-entries')
    reasons.push(`${invalid} entry/entries fail schema validation`)
  }
  if (missingIds > 0) {
    failures.push('missing-ids')
    reasons.push(`${missingIds} entry/entries have no id`)
  }
  if (duplicateIds > 0) {
    failures.push('duplicate-ids')
    reasons.push(`${duplicateIds} duplicate id(s)`)
  }

  // (c) — not materially smaller than the last known-good corpus
  if (typeof lastGoodCount === 'number' && lastGoodCount > 0) {
    const floor = lastGoodCount * (1 - SHRINK_TOLERANCE)
    if (count < floor) {
      failures.push('shrunk')
      reasons.push(
        `holds ${count} engram(s) but the last good snapshot held ${lastGoodCount} — ` +
        `a drop this large is how a truncation looks`,
      )
    }
  }

  return { ok: failures.length === 0, failures, reasons, count }
}

function todayStamp(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function snapshotPath(root: string, stamp: string): string {
  return path.join(root, BACKUP_DIR, `engrams-${stamp}.yaml`)
}

/** Tracks which roots this process has already snapshotted, so the check is one stat per day, not per write. */
const doneThisProcess = new Set<string>()

export interface BackupOutcome {
  taken: boolean
  /** Why no snapshot was taken. Absent when `taken` is true. */
  skipped?: 'already-today' | 'no-store' | 'invalid'
  path?: string
  validity?: StoreValidity
}

/**
 * Take today's snapshot if one is due and the store is fit to copy.
 *
 * MUST be called from inside the store lock, before the store is loaded — see
 * the module docstring. Never throws: a backup failure must not take down the
 * write that triggered it, since the write itself is still safe. Failures are
 * logged, and a store that fails the gate is reported loudly because it means
 * the user's safety net is not being refreshed.
 */
export function maybeDailyBackup(root: string, storePath: string, now = new Date()): BackupOutcome {
  const key = `${root} ${todayStamp(now)}`
  if (doneThisProcess.has(key)) return { taken: false, skipped: 'already-today' }
  try {
    if (!fs.existsSync(storePath)) {
      doneThisProcess.add(key)
      return { taken: false, skipped: 'no-store' }
    }
    const state = readState(root)
    const stamp = todayStamp(now)
    if (state.last_backup_date === stamp) {
      doneThisProcess.add(key)
      return { taken: false, skipped: 'already-today' }
    }

    // A corrupt or missing .state.json used to mean "no baseline", so the shrink
    // gate silently stopped applying and a same-day snapshot could be replaced
    // by a weaker one (#813, audit finding 14): valid 100-row snapshot, crash
    // leaves partial state, live corpus becomes a valid 1-row file, restart
    // overwrites the 100-row backup with 1 row. Fall back to the strongest
    // existing snapshot's own count, which is on disk in its sidecar and does
    // not depend on the state file at all.
    const existing = listBackups(root)
    const strongest = existing.reduce<number | undefined>(
      (max, b) => (typeof b.count === 'number' && (max === undefined || b.count > max) ? b.count : max),
      undefined,
    )
    const baseline = state.last_good_count ?? strongest
    const validity = validateStore(storePath, baseline)
    if (!validity.ok) {
      // Deliberately NOT marked done: if the user repairs the store later
      // today, the next write should snapshot the repaired copy.
      logger.warning(
        `[plur:backup] refusing to snapshot ${storePath} — ${validity.reasons.join('; ')}. ` +
        `Your last good backup is unchanged. Run 'plur doctor' to inspect.`,
      )
      return { taken: false, skipped: 'invalid', validity }
    }

    const bytes = fs.readFileSync(storePath)
    const dest = snapshotPath(root, stamp)
    // Never replace an existing same-day snapshot with a weaker one. The
    // validity gate above compares against the last known-good count; this
    // compares against the file we would be overwriting, which is the one
    // actually at risk.
    const sameDay = existing.find(b => b.stamp === stamp)
    if (sameDay && typeof sameDay.count === 'number' && (validity.count ?? 0) < sameDay.count) {
      logger.warning(
        `[plur:backup] keeping today's existing snapshot (${sameDay.count} engrams) — the live store ` +
        `holds ${validity.count}, and replacing a stronger snapshot with a weaker one would discard ` +
        `the better copy. Run 'plur restore --list' to inspect.`,
      )
      doneThisProcess.add(key)
      return { taken: false, skipped: 'invalid', validity }
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    writeFileDurable(dest, bytes)
    // Sidecar is what makes a restore verifiable rather than hopeful.
    //
    // `taken_at` is the full instant, not just the date: snapshots are daily,
    // so everything learned during the REST of that day is newer than the
    // snapshot. Comparing at day granularity would silently classify a whole
    // day's engrams as "already in the backup", which is exactly the false
    // reassurance a restore must not give.
    writeFileDurable(
      `${dest}.sha256`,
      Buffer.from(
        `${sha256(bytes)}  ${path.basename(dest)}\n${validity.count} engrams\ntaken_at ${now.toISOString()}\n`,
        'utf8',
      ),
    )

    doneThisProcess.add(key)
    writeState(root, {
      last_backup_date: stamp,
      last_good_count: validity.count ?? undefined,
      last_good_sha256: sha256(bytes),
    })
    rotate(root, now)
    return { taken: true, path: dest, validity }
  } catch (err) {
    logger.warning(`[plur:backup] snapshot failed (the write itself was unaffected): ${err}`)
    return { taken: false, skipped: 'invalid' }
  }
}

/** fsync a file written by a non-atomic helper (copyFileSync). Best-effort. */
function flushFileAt(filePath: string): void {
  let fd: number | undefined
  try {
    fd = fs.openSync(filePath, 'r+')
    fs.fsyncSync(fd)
  } catch {
    /* nothing actionable — the copy itself succeeded */
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* ignore */ }
    }
  }
}

/**
 * Write and fsync — a backup that is only in the page cache is not a backup,
 * which is the same reasoning as the store's own atomicWrite (audit #794, F4).
 */
function writeFileDurable(dest: string, bytes: Buffer): void {
  const fd = fs.openSync(dest, 'w')
  try {
    fs.writeFileSync(fd, bytes)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export interface BackupEntry {
  path: string
  stamp: string
  size: number
  sha256?: string
  count?: number
  /** Full ISO instant the snapshot was taken — see the sidecar note in maybeDailyBackup. */
  takenAt?: string
}

/** Every snapshot on disk, newest first. */
export function listBackups(root: string): BackupEntry[] {
  const dir = path.join(root, BACKUP_DIR)
  if (!fs.existsSync(dir)) return []
  const out: BackupEntry[] = []
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(/^engrams-(\d{4}-\d{2}-\d{2})\.yaml$/)
    if (!m) continue
    const full = path.join(dir, name)
    const entry: BackupEntry = { path: full, stamp: m[1], size: fs.statSync(full).size }
    try {
      const sidecar = fs.readFileSync(`${full}.sha256`, 'utf8')
      entry.sha256 = sidecar.split(/\s+/)[0]
      const cm = sidecar.match(/(\d+) engrams/)
      if (cm) entry.count = parseInt(cm[1], 10)
      const tm = sidecar.match(/taken_at (\S+)/)
      if (tm) entry.takenAt = tm[1]
    } catch { /* sidecar missing — listing still works, restore will object */ }
    out.push(entry)
  }
  return out.sort((a, b) => (a.stamp < b.stamp ? 1 : -1))
}

/**
 * Prune snapshots: keep the newest {@link KEEP_DAILY} days, then one per ISO
 * week for {@link KEEP_WEEKLY} further weeks, then delete.
 */
function rotate(root: string, now: Date): void {
  const all = listBackups(root)
  if (all.length <= KEEP_DAILY) return
  const keep = new Set<string>()
  for (const b of all.slice(0, KEEP_DAILY)) keep.add(b.path)

  const weeksSeen = new Set<string>()
  for (const b of all.slice(KEEP_DAILY)) {
    const week = isoWeek(new Date(`${b.stamp}T00:00:00Z`))
    if (weeksSeen.has(week)) continue
    weeksSeen.add(week)
    if (weeksSeen.size <= KEEP_WEEKLY) keep.add(b.path)
  }

  for (const b of all) {
    if (keep.has(b.path)) continue
    try {
      fs.unlinkSync(b.path)
      fs.unlinkSync(`${b.path}.sha256`)
    } catch { /* already gone, or no sidecar */ }
  }
  void now
}

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${t.getUTCFullYear()}-W${week}`
}

export interface RestorePlan {
  backup: BackupEntry
  validity: StoreValidity
  /** sha256 of the backup as it is on disk right now. */
  actualSha256: string
  /** True when the sidecar hash matches the bytes. */
  integrityOk: boolean
  /** Engram ids present in the CURRENT store but absent from the backup — restoring loses these. */
  wouldLose: string[]
  /** Engram ids the history log records as created after the backup's stamp. */
  unrecoverable: string[]
}

/**
 * Work out what restoring a given snapshot would actually do, without doing it.
 *
 * A restore is itself a whole-corpus overwrite, so it is exactly the operation
 * the rest of this audit is about. It must therefore be at least as careful as
 * a write: verify the backup independently, and NAME what the user is about to
 * lose rather than rolling them back silently.
 */
export function planRestore(root: string, storePath: string, stamp?: string): RestorePlan {
  const all = listBackups(root)
  if (all.length === 0) throw new Error(`[plur] no backups found in ${path.join(root, BACKUP_DIR)}`)
  const backup = stamp ? all.find(b => b.stamp === stamp) : all[0]
  if (!backup) throw new Error(`[plur] no backup for ${stamp}. Available: ${all.map(b => b.stamp).join(', ')}`)

  const bytes = fs.readFileSync(backup.path)
  const actualSha256 = sha256(bytes)
  const integrityOk = backup.sha256 === undefined ? false : backup.sha256 === actualSha256
  // No lastGoodCount here on purpose: the question is whether the BACKUP is
  // internally sound, not whether it matches today's (possibly ruined) corpus.
  const validity = validateStore(backup.path)

  const backupIds = new Set(idsIn(backup.path))
  const currentIds = idsIn(storePath)
  const wouldLose = currentIds.filter(id => !backupIds.has(id))

  return {
    backup,
    validity,
    actualSha256,
    integrityOk,
    wouldLose,
    // Compare against the snapshot's INSTANT where we have it. Falling back to
    // the end of its day is the conservative direction when a sidecar predates
    // this field: it under-reports rather than inventing losses.
    unrecoverable: idsCreatedAfter(root, backup.takenAt ?? `${backup.stamp}T23:59:59.999Z`)
      .filter(id => !backupIds.has(id)),
  }
}

function idsIn(filePath: string): string[] {
  try {
    const doc: any = yaml.load(fs.readFileSync(filePath, 'utf8'))
    if (!doc || !Array.isArray(doc.engrams)) return []
    return doc.engrams.map((e: any) => e?.id).filter((id: unknown): id is string => typeof id === 'string')
  } catch {
    return []
  }
}

/**
 * Engram ids the append-only history records as created after `since`
 * (a full ISO instant, compared lexically — ISO-8601 UTC sorts correctly).
 *
 * History is JSONL under `history/`, which the audit confirmed is the one
 * append-only artifact that survived every concurrency probe (P09C: 240/240
 * lines). That makes it the right source for "what existed that the backup does
 * not have" — the difference between a restore and a second data-loss event.
 *
 * This matters most for same-day losses. Snapshots are daily, so everything
 * learned after the morning's snapshot is unprotected by it; naming those
 * engrams is the only way the user learns what a restore costs them.
 */
function idsCreatedAfter(root: string, since: string): string[] {
  const dir = path.join(root, 'history')
  if (!fs.existsSync(dir)) return []
  const ids: string[] = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue
    let lines: string[]
    try {
      lines = fs.readFileSync(path.join(dir, name), 'utf8').split('\n')
    } catch { continue }
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line)
        if (typeof ev?.timestamp !== 'string' || ev.timestamp <= since) continue
        if (typeof ev?.engram_id === 'string') ids.push(ev.engram_id)
      } catch { /* a partial trailing line is expected in an append-only log */ }
    }
  }
  return [...new Set(ids)]
}

export interface RestoreResult extends RestorePlan {
  restored: true
  /** Where the pre-restore store was moved, so a mistaken restore is itself reversible. */
  supersededPath: string
}

/**
 * Restore a snapshot over the live store.
 *
 * Refuses unless the backup verifies, unless `force` is set. The current store
 * is never deleted — it is moved aside first, because a restore performed on a
 * wrong assumption must not be the end of the line.
 */
export function restoreBackup(
  root: string,
  storePath: string,
  opts: { stamp?: string; force?: boolean } = {},
): RestoreResult {
  // Under the store lock, and atomic (#811 audit, finding 10).
  //
  // Restoring is a whole-corpus overwrite — the exact operation the rest of
  // this audit constrains — and it was doing it unlocked, through a truncating
  // open on the LIVE file. Two consequences:
  //
  //   - a writer committing between the superseded copy and the overwrite left
  //     its engram in NEITHER file, with both calls reporting success
  //   - a crash mid-write left the live corpus partial, which is precisely the
  //     input the loader now refuses
  //
  // `withLock` here is the synchronous variant, which shares the `<path>.lock`
  // file protocol with `withAsyncLock` — so a restore run from the CLI waits
  // for an MCP server mid-write, which is the case that matters.
  //
  // PLANNING happens inside the lock too (audit 2026-08-03, finding 12). Read
  // outside it, `wouldLose` and `unrecoverable` describe a corpus that may have
  // changed before the overwrite lands: an engram learned in between is copied
  // aside and then replaced, while the result — whose entire contract is to
  // NAME what it removes — never mentions it. The data is still recoverable
  // from the superseded copy, but the operator was told it was not at risk.
  // The refusal checks move in with it, so a plan can never be validated
  // against one state and applied to another.
  let plan!: RestorePlan
  const superseded = `${storePath}.superseded-${Date.now()}`
  withLock(storePath, () => {
    plan = planRestore(root, storePath, opts.stamp)
    if (!opts.force) {
      const problems: string[] = []
      if (!plan.validity.ok) problems.push(...plan.validity.reasons)
      if (!plan.integrityOk) {
        problems.push(
          plan.backup.sha256 === undefined
            ? 'no sha256 sidecar — cannot verify the backup is intact'
            : 'sha256 does not match the sidecar — the backup itself is damaged',
        )
      }
      if (problems.length > 0) {
        throw new Error(
          `[plur] refusing to restore ${plan.backup.path}: ${problems.join('; ')}.\n` +
          `Restoring is a whole-corpus overwrite; doing it from a backup that does not verify would ` +
          `replace a damaged store with a differently damaged one.\n` +
          `Pass force to override if you have inspected the file yourself.`,
        )
      }
    }
    if (fs.existsSync(storePath)) {
      fs.copyFileSync(storePath, superseded)
      flushFileAt(superseded)
    }
    // tmp + fsync + rename, rather than truncating the live file in place.
    atomicWrite(storePath, fs.readFileSync(plan.backup.path, 'utf8'))
  })

  if (plan.wouldLose.length > 0) {
    logger.warning(
      `[plur:restore] ${plan.wouldLose.length} engram(s) present before the restore are not in this ` +
      `backup: ${plan.wouldLose.slice(0, 10).join(', ')}${plan.wouldLose.length > 10 ? ', …' : ''}. ` +
      `The pre-restore store was kept at ${superseded}.`,
    )
  }
  if (plan.unrecoverable.length > 0) {
    logger.warning(
      `[plur:restore] history records ${plan.unrecoverable.length} engram(s) created after this ` +
      `backup that it does not contain: ${plan.unrecoverable.slice(0, 10).join(', ')}` +
      `${plan.unrecoverable.length > 10 ? ', …' : ''}.`,
    )
  }
  return { ...plan, restored: true, supersededPath: superseded }
}

/** Test seam — forget which roots this process has snapshotted. */
export function _resetBackupProcessState(): void {
  doneThisProcess.clear()
}
