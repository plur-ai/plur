/**
 * Shared change journal (overhaul W0; plan revisions D1 and R2).
 *
 * One primitive for every store operation that must be undoable — the pin
 * audit (W3), consolidation (W6), rescope (W7) and enrichment (W10):
 *
 *   const change = plur.beginChange('consolidate.merge', { proposal })
 *   const record = await change.apply(tx => { tx.put(merged); tx.put(retired) })
 *   ...
 *   await plur.undoChange(record.id)
 *
 * What a change records: its id, kind and caller metadata, and for EVERY row
 * it touched a full before-snapshot (or `null` for a row it created) and the
 * after-state it wrote (or `null` for a row it removed). The apply runs under
 * the store write lock, so the before-snapshots are exactly what the change
 * replaced and two changes never interleave.
 *
 * What undo guarantees: it restores the before-snapshots atomically (one store
 * write, under the same lock), and it REFUSES — {@link ChangeConflictError},
 * naming the rows — when any touched row no longer holds what the change
 * wrote. A refused undo writes nothing. Undo is itself a journalled change
 * (kind `undo`, `meta.undoes`), so the journal is append-only and an undo
 * after a sync is a compensating write, never a rewrite of history.
 *
 * Storage: an append-only JSONL sidecar next to the store
 * (`<root>/changes.jsonl`), the same pattern as `history/*.jsonl`. The
 * engram rows themselves stay in YAML. The journal holds engram content
 * (including `scope: local` rows), so it is machine-local: it is not one of the
 * files `plur sync` stages.
 *
 * Retention (S5). The journal must not keep content the store has let go of:
 *  - `forget` and `compact` redact the rows they retire or remove
 *    ({@link redactChangeJournal}): every snapshot of those rows becomes
 *    `{ id, _redacted: true }`, and an undo that would restore one refuses
 *    with {@link ChangeRedactedError}. Callers that remove content for other
 *    reasons (a secret found in a row) call `Plur.redactChangeJournal`.
 *  - Size-based rotation: before a change is begun, a journal over
 *    {@link changeJournalMaxBytes} (default 8 MiB, `PLUR_CHANGE_JOURNAL_MAX_BYTES`)
 *    becomes `changes.1.jsonl`, replacing the previous generation. Changes in
 *    a generation that was dropped can no longer be listed or undone.
 *
 * Each change writes two lines: `begun` (with the snapshots) BEFORE the store
 * write, and `committed` after it. A crash between the two leaves a `begun`
 * change whose undo compares the store against the recorded after-state, so it
 * either undoes a write that landed or refuses — it never guesses.
 *
 * Scope of support: the local YAML primary store only. Rows of secondary
 * stores, team (remote) stores and packs, and non-YAML primaries, are refused
 * with {@link ChangeJournalUnsupportedError}: these operations act on locally
 * owned scopes only.
 *
 * The store wiring (lock, load, write, index sync) lives on `Plur`
 * (`beginChange`, `undoChange`, `listChanges`, `getChange`); this module holds
 * the journal format, the folding of its lines into records, and the row
 * comparison undo uses.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import { sortKeysDeep } from './history.js'
import type { Engram } from './schemas/engram.js'

/** Journal file name, under the store root. */
export const CHANGE_JOURNAL_FILE = 'changes.jsonl'

/** Path of the change journal for the store rooted at `root`. */
export function changeJournalPath(root: string): string {
  return join(root, CHANGE_JOURNAL_FILE)
}

/** The one older generation kept by rotation. */
export const CHANGE_JOURNAL_ROTATED_FILE = 'changes.1.jsonl'

/** Default size past which the journal rotates (8 MiB). */
export const CHANGE_JOURNAL_DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/** Rotation threshold: `PLUR_CHANGE_JOURNAL_MAX_BYTES` when a positive integer, else the default. */
export function changeJournalMaxBytes(): number {
  const n = parseInt(process.env.PLUR_CHANGE_JOURNAL_MAX_BYTES ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : CHANGE_JOURNAL_DEFAULT_MAX_BYTES
}

/** A snapshot whose content was redacted (S5). */
export function isRedactedRow(row: unknown): boolean {
  return !!row && typeof row === 'object' && (row as { _redacted?: unknown })._redacted === true
}

/** One touched row: what it was before the change and what the change wrote. */
export interface ChangeRowSnapshot {
  id: string
  /** Position in the corpus before the change, or `null` for a row the change created. Used to put a removed row back in place. */
  index: number | null
  /** The full row before the change, or `null` when the change created it. */
  before: Engram | null
  /** The full row as stored after the change, or `null` when the change removed it. */
  after: Engram | null
}

/** A change, folded from its journal lines. */
export interface ChangeRecord {
  id: string
  kind: string
  meta: Record<string, unknown>
  /** ISO timestamp of the apply. */
  at: string
  /** `committed` once the store write landed; `begun` if the process stopped between the journal line and the store write. */
  state: 'begun' | 'committed'
  rows: ChangeRowSnapshot[]
  /** Id of the `undo` change that reverted this one, when there is one. */
  undone_by?: string
}

/** Raw journal lines. */
type JournalLine =
  | { v: 1; state: 'begun'; id: string; kind: string; meta: Record<string, unknown>; at: string; rows: ChangeRowSnapshot[] }
  | { v: 1; state: 'committed'; id: string; at: string; after?: Record<string, Engram | null> }

/** What a change's apply function sees: the locked corpus, and staging for its writes. */
export interface ChangeTx {
  /** A copy of the current row (staged writes included), or undefined. Mutating it changes nothing until `put`. */
  get(id: string): Engram | undefined
  /** Every current row (staged writes included), as copies. */
  all(): Engram[]
  /** Stage a create (unknown id) or a whole-row replace (known id). */
  put(engram: Engram): void
  /** Stage the removal of a row. Prefer retiring (`status: 'retired'`) — removal is for undoing creates. */
  remove(id: string): void
}

/**
 * Handle returned by `beginChange`: apply it once.
 *
 * `fn` runs while the store lock is held. It must only read and stage through
 * `tx` — calling another `Plur` write method from inside it waits on the same
 * lock. Do slow work (model calls, network) before `apply`, never inside it.
 * The journal stages rows as given: write-path policy (the pin quota, the
 * sensitivity guard) is the caller's to apply before staging.
 */
export interface PendingChange {
  readonly id: string
  readonly kind: string
  readonly meta: Record<string, unknown>
  apply(fn: (tx: ChangeTx) => void | Promise<void>): Promise<ChangeRecord>
}

/**
 * Pseudo-field naming the `co_accessed` entries of `associations`, which
 * recall adds and strengthens as bookkeeping. Ignoring it compares (and
 * restores) the other associations only and keeps the current co-access edges.
 */
export const CO_ACCESS_FIELD = 'associations:co_accessed'

/**
 * Top-level engram fields that ordinary use rewrites after any change: inject
 * counts (`injection_count`), recall activation and usage stats, feedback
 * (and the `commitment` step positive feedback takes),
 * re-learn counters and their provenance (`write_count`, `recurrence_count`,
 * `sources`), and recall's co-access edges ({@link CO_ACCESS_FIELD}). They are not content, so by default they never block an undo:
 * an engram injected once after a merge must still be undoable.
 */
export const UNDO_BOOKKEEPING_FIELDS: readonly string[] = Object.freeze([
  'injection_count',
  'activation',
  'usage',
  'feedback_signals',
  // Positive feedback advances it (exploring/leaning -> decided).
  'commitment',
  'write_count',
  'recurrence_count',
  'sources',
  CO_ACCESS_FIELD,
])

/** Options for `undoChange`. */
export interface UndoChangeOptions {
  /**
   * Top-level engram fields to leave out of the "changed since the apply"
   * check. For a field that moved after the apply the CURRENT value is kept
   * on restore (the bookkeeping that happened since is not lost); a field
   * that did not move is restored to its before-value, so an undo with no
   * drift is still exact. Default: {@link UNDO_BOOKKEEPING_FIELDS}. Pass `[]`
   * to make every field count.
   */
  ignoreFields?: readonly string[]
}

/** Base class for change journal errors. */
export class ChangeJournalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** The store or row is outside what the journal supports (non-YAML primary, secondary/remote/pack rows, remote-only folder). */
export class ChangeJournalUnsupportedError extends ChangeJournalError {}

/** No change with this id in the journal. */
export class ChangeNotFoundError extends ChangeJournalError {
  constructor(readonly changeId: string) {
    super(`No change ${changeId} in the change journal.`)
  }
}

/** The change was already undone. */
export class ChangeAlreadyUndoneError extends ChangeJournalError {
  constructor(readonly changeId: string, readonly undoneBy: string) {
    super(`Change ${changeId} was already undone by ${undoneBy}.`)
  }
}

/** One row that blocks an undo. */
export interface ChangeConflictRow {
  id: string
  /** What the change left: the row present (with its content) or absent. */
  expected: 'present' | 'absent'
  /** What the store holds now. */
  found: 'present' | 'absent' | 'changed'
}

/** Undo refused: a touched row no longer holds what the change wrote. Nothing was written. */
export class ChangeConflictError extends ChangeJournalError {
  constructor(readonly changeId: string, readonly rows: ChangeConflictRow[]) {
    super(
      `Refusing to undo change ${changeId}: ${rows.length} row(s) changed since it was applied — `
      + rows.map(r => `${r.id} (expected ${r.expected}, found ${r.found})`).join(', ')
      + '. Nothing was written.',
    )
  }
}

/** Undo refused: a row the change touched was redacted from the journal (forgotten, compacted away, or holding a secret). Nothing was written. */
export class ChangeRedactedError extends ChangeJournalError {
  constructor(readonly changeId: string, readonly ids: string[]) {
    super(`Refusing to undo change ${changeId}: its snapshot of ${ids.join(', ')} was redacted from the change journal (the row was forgotten or removed). Nothing was written.`)
  }
}

/** A new change id: `CHG-<UTC yyyymmddThhmmss>-<random>`. */
export function newChangeId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `CHG-${stamp}-${randomBytes(4).toString('hex')}`
}

/** Canonical form of a row for equality: sorted keys, `undefined` dropped, optional top-level fields left out. */
export function canonicalRow(row: Engram | null | undefined, ignoreFields: readonly string[] = []): string | null {
  if (!row) return null
  const copy: Record<string, unknown> = { ...(row as Record<string, unknown>) }
  for (const f of ignoreFields) {
    if (f === CO_ACCESS_FIELD) copy.associations = withoutCoAccess(copy.associations)
    else delete copy[f]
  }
  return JSON.stringify(sortKeysDeep(JSON.parse(JSON.stringify(copy))))
}

/** `associations` without recall's `co_accessed` edges. */
export function withoutCoAccess(assocs: unknown): unknown {
  return Array.isArray(assocs) ? assocs.filter(a => (a as { type?: string })?.type !== 'co_accessed') : assocs
}

/** `associations` with only recall's `co_accessed` edges. */
export function coAccessOnly(assocs: unknown): unknown[] {
  return Array.isArray(assocs) ? assocs.filter(a => (a as { type?: string })?.type === 'co_accessed') : []
}

/**
 * Apply the ignored fields to a row being restored to `before`: a field that
 * did not move since the change (`now` equals `after`) keeps its before-value,
 * so an undo with no drift is exact; a field that moved keeps its current
 * value, so bookkeeping made since the change is not lost.
 */
export function carryIgnoredFields(
  restored: Record<string, unknown>,
  now: Record<string, unknown>,
  after: Record<string, unknown> | undefined,
  ignoreFields: readonly string[],
): void {
  const canon = (v: unknown) => JSON.stringify(sortKeysDeep(JSON.parse(JSON.stringify(v ?? null))))
  for (const f of ignoreFields) {
    if (f === CO_ACCESS_FIELD) {
      const cur = coAccessOnly(now.associations)
      if (canon(cur) === canon(coAccessOnly(after?.associations))) continue
      const kept = withoutCoAccess(restored.associations)
      restored.associations = [...(Array.isArray(kept) ? kept : []), ...cur]
      continue
    }
    if (canon(now[f]) === canon(after?.[f])) continue
    if (f in now) restored[f] = now[f]
    else delete restored[f]
  }
}

/** Rows whose current state differs from what the change wrote. */
export function findUndoConflicts(
  record: ChangeRecord,
  current: ReadonlyMap<string, Engram>,
  ignoreFields: readonly string[] = [],
): ChangeConflictRow[] {
  const conflicts: ChangeConflictRow[] = []
  for (const row of record.rows) {
    const now = current.get(row.id) ?? null
    if (row.after === null) {
      if (now) conflicts.push({ id: row.id, expected: 'absent', found: 'present' })
    } else if (!now) {
      conflicts.push({ id: row.id, expected: 'present', found: 'absent' })
    } else if (canonicalRow(now, ignoreFields) !== canonicalRow(row.after, ignoreFields)) {
      conflicts.push({ id: row.id, expected: 'present', found: 'changed' })
    }
  }
  return conflicts
}

function appendLine(root: string, line: JournalLine): void {
  const path = changeJournalPath(root)
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  appendFileSync(path, JSON.stringify(line) + '\n', { encoding: 'utf8', mode: 0o600 })
  // Durable before the store write that depends on it.
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/** Append the `begun` line of a change. Call under the store lock, before the store write. */
export function journalBegin(root: string, change: { id: string; kind: string; meta: Record<string, unknown>; at: string; rows: ChangeRowSnapshot[] }): void {
  rotateIfLarge(root)
  appendLine(root, { v: 1, state: 'begun', ...change })
}

/**
 * Rotate before a new change begins, never between a change's two lines: a
 * journal over the size limit becomes the one older generation, replacing
 * the previous one (whose changes can then no longer be undone).
 */
function rotateIfLarge(root: string): void {
  const path = changeJournalPath(root)
  try {
    if (statSync(path).size <= changeJournalMaxBytes()) return
    renameSync(path, join(root, CHANGE_JOURNAL_ROTATED_FILE))
  } catch { /* no journal yet, or a rename race: append to what is there */ }
}

/** Meta keys that hold statement text by design; dropped from any line that names a redacted row (H1). */
const STATEMENT_META_KEYS: readonly string[] = Object.freeze(['merged_statement', 'statement', 'statements'])

/** Text fields of a row snapshot that a meta value or another snapshot may quote. */
function snapshotTexts(row: unknown): string[] {
  if (!row || typeof row !== 'object' || isRedactedRow(row)) return []
  const r = row as { statement?: unknown; rationale?: unknown; structured_data?: { body?: unknown } }
  return [r.statement, r.rationale, r.structured_data?.body].filter((t): t is string => typeof t === 'string' && t.trim().length >= 8)
}

/**
 * Strip statement text from a begun line's meta (H1): on a line that names a
 * redacted row the known statement keys go, and on every line any other
 * string (at any depth) that quotes a redacted row's text is removed.
 * Returns how many fields were removed.
 */
function redactMeta(meta: Record<string, unknown>, texts: readonly string[], namesRedacted: boolean): number {
  let count = 0
  if (namesRedacted) {
    for (const key of STATEMENT_META_KEYS) {
      if (key in meta) { delete meta[key]; count++ }
    }
  }
  const quotes = (v: string) => texts.some(t => v.includes(t))
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return quotes(node) ? undefined : node
    if (Array.isArray(node)) {
      const out: unknown[] = []
      for (const v of node) { const w = walk(v); if (w === undefined) count++; else out.push(w) }
      return out
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const w = walk(v)
        if (w === undefined) { delete (node as Record<string, unknown>)[k]; count++ } else (node as Record<string, unknown>)[k] = w
      }
    }
    return node
  }
  if (texts.length > 0) walk(meta)
  if (count > 0) meta._redacted = true
  return count
}

/** What one {@link redactChangeJournalDetailed} pass removed. */
export interface ChangeJournalRedaction {
  /** Row snapshots (`before`, `after`, committed `after`) replaced by stubs. */
  snapshots: number
  /** Meta fields carrying statement text removed from lines that name a redacted row (H1). */
  meta_fields: number
  /** Unparseable (torn) lines that named a redacted row and were dropped (H2). */
  torn_lines: number
}

/** Options of {@link redactChangeJournalDetailed}. */
export interface ChangeJournalRedactOptions {
  /**
   * True for a row the store still holds. Such a row is never pulled into the
   * redaction as derived content: its content is in the store, and the owner
   * forgets it on its own. Default: the store holds none of them.
   */
  held?: (id: string) => boolean
}

/**
 * Redact every snapshot of the given rows in the journal and its rotated
 * generation (S5): `before`/`after` become `{ id, _redacted: true }`. Call
 * under the store lock. Returns how many snapshots, meta fields and torn
 * lines were redacted ({@link redactChangeJournalDetailed} for the split).
 */
export function redactChangeJournal(root: string, ids: Iterable<string>, options: ChangeJournalRedactOptions = {}): number {
  const r = redactChangeJournalDetailed(root, ids, options)
  return r.snapshots + r.meta_fields + r.torn_lines
}

/**
 * {@link redactChangeJournal} with the counts kept apart. Besides the row
 * snapshots it strips statement text from the meta of every begun line that
 * names a redacted row (a consolidation keeps `merged_statement` there), and
 * it drops a torn line that names one: the reader skips such a line anyway,
 * and passing it through would keep the row's content (H1, H2). The tmp file
 * is removed when the rewrite fails.
 *
 * Derived rows (security audit 2026-11-27). A row a change CREATED alongside a
 * redacted row (a consolidation's merged row, built on a member) carries that
 * row's content. When the store no longer holds it (the consolidation was
 * undone), no command could ever redact it, so it joins the redaction: in
 * every line of both generations, repeated until the set stops growing. So
 * does a row the store no longer holds whose snapshot quotes a redacted row's
 * text, and any meta string, on any line, that quotes one.
 */
export function redactChangeJournalDetailed(root: string, ids: Iterable<string>, options: ChangeJournalRedactOptions = {}): ChangeJournalRedaction {
  const wanted = new Set(ids)
  const total: ChangeJournalRedaction = { snapshots: 0, meta_fields: 0, torn_lines: 0 }
  if (wanted.size === 0) return total
  const held = options.held ?? (() => false)
  const stub = (id: string) => ({ id, _redacted: true }) as unknown as Engram

  // Read both generations once: the derived set is closed over all of them
  // before anything is rewritten.
  const files = [CHANGE_JOURNAL_ROTATED_FILE, CHANGE_JOURNAL_FILE]
    .map(file => join(root, file))
    .filter(path => existsSync(path))
    .map(path => {
      const raws = readFileSync(path, 'utf8').split('\n')
      const parsed = raws.map((raw): JournalLine | null | undefined => {
        if (!raw.trim()) return undefined
        try { return JSON.parse(raw) as JournalLine } catch { return null }
      })
      return { path, raws, parsed }
    })
  const lines = files.flatMap(f => f.parsed).filter((l): l is JournalLine => !!l && typeof l === 'object')
  const begun = lines.filter((l): l is Extract<JournalLine, { state: 'begun' }> => l.state === 'begun' && Array.isArray(l.rows))
  const committed = lines.filter((l): l is Extract<JournalLine, { state: 'committed' }> => l.state === 'committed' && !!l.after && typeof l.after === 'object')

  const texts = new Set<string>()
  const textsOf = (id: string) => {
    for (const l of begun) for (const row of l.rows) if (row.id === id) for (const t of [...snapshotTexts(row.before), ...snapshotTexts(row.after)]) texts.add(t)
    for (const l of committed) if (id in l.after!) for (const t of snapshotTexts(l.after![id])) texts.add(t)
  }
  for (const id of wanted) textsOf(id)
  const quotes = (row: unknown) => snapshotTexts(row).some(v => [...texts].some(t => v.includes(t)))
  const add = (id: string) => { wanted.add(id); textsOf(id) }
  for (let grew = true; grew;) {
    grew = false
    for (const l of begun) {
      const names = l.rows.some(r => wanted.has(r.id))
      for (const row of l.rows) {
        if (wanted.has(row.id) || held(row.id)) continue
        if ((names && row.before === null) || quotes(row.before) || quotes(row.after)) { add(row.id); grew = true }
      }
    }
    for (const l of committed) {
      for (const id of Object.keys(l.after!)) {
        if (!wanted.has(id) && !held(id) && quotes(l.after![id])) { add(id); grew = true }
      }
    }
  }
  const allTexts = [...texts]
  const namesWanted = (raw: string) => {
    for (const id of wanted) if (raw.includes(id)) return true
    return allTexts.some(t => raw.includes(t))
  }

  for (const { path, raws, parsed } of files) {
    const found: ChangeJournalRedaction = { snapshots: 0, meta_fields: 0, torn_lines: 0 }
    const DROP = Symbol('drop')
    const out = raws.map((raw, i): string | typeof DROP => {
      const line = parsed[i]
      if (line === undefined) return raw
      if (line === null) {
        if (namesWanted(raw)) { found.torn_lines++; return DROP }
        return raw
      }
      if (line?.state === 'begun' && Array.isArray(line.rows)) {
        let names = false
        for (const row of line.rows) {
          if (!wanted.has(row.id)) continue
          names = true
          if (row.before !== null && !isRedactedRow(row.before)) { row.before = stub(row.id); found.snapshots++ }
          if (row.after !== null && !isRedactedRow(row.after)) { row.after = stub(row.id); found.snapshots++ }
        }
        if (line.meta && typeof line.meta === 'object') found.meta_fields += redactMeta(line.meta, allTexts, names)
      } else if (line?.state === 'committed' && line.after) {
        for (const id of Object.keys(line.after)) {
          if (wanted.has(id) && line.after[id] !== null && !isRedactedRow(line.after[id])) { line.after[id] = stub(id); found.snapshots++ }
        }
      } else {
        return raw
      }
      return JSON.stringify(line)
    })
    if (found.snapshots + found.meta_fields + found.torn_lines === 0) continue
    const tmp = `${path}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, out.filter((l): l is string => l !== DROP).join('\n'), { encoding: 'utf8', mode: 0o600 })
      const fd = openSync(tmp, 'r')
      try { fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(tmp, path)
    } finally {
      try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* best effort: the next pass reuses the name */ }
    }
    total.snapshots += found.snapshots
    total.meta_fields += found.meta_fields
    total.torn_lines += found.torn_lines
  }
  return total
}

/**
 * Append the `committed` line of a change. `after` carries rows whose stored
 * form differs from the staged one (the loader's normalisation), so undo
 * compares against what is really on disk.
 */
export function journalCommit(root: string, id: string, after?: Record<string, Engram | null>): void {
  appendLine(root, { v: 1, state: 'committed', id, at: new Date().toISOString(), ...(after && Object.keys(after).length > 0 ? { after } : {}) })
}

/**
 * Read the journal and fold its lines into one record per change, oldest
 * first. A torn final line (a crash mid-append) is skipped; any other
 * malformed line is skipped too rather than hiding every change after it.
 */
export function readChangeJournal(root: string): ChangeRecord[] {
  const texts: string[] = []
  for (const file of [CHANGE_JOURNAL_ROTATED_FILE, CHANGE_JOURNAL_FILE]) {
    const path = join(root, file)
    if (existsSync(path)) texts.push(readFileSync(path, 'utf8'))
  }
  if (texts.length === 0) return []
  const byId = new Map<string, ChangeRecord>()
  for (const raw of texts.join('\n').split('\n')) {
    if (!raw.trim()) continue
    let line: JournalLine
    try { line = JSON.parse(raw) } catch { continue }
    if (!line || typeof line !== 'object' || typeof line.id !== 'string') continue
    if (line.state === 'begun') {
      byId.set(line.id, { id: line.id, kind: line.kind, meta: line.meta ?? {}, at: line.at, state: 'begun', rows: line.rows ?? [] })
    } else if (line.state === 'committed') {
      const rec = byId.get(line.id)
      if (!rec) continue
      rec.state = 'committed'
      if (line.after) for (const row of rec.rows) if (row.id in line.after) row.after = line.after[row.id]
    }
  }
  const records = [...byId.values()]
  // Chronological: an undo marks its target, and undoing an undo (a redo)
  // clears the mark on the change that undo had reverted.
  for (const rec of records) {
    const target = rec.kind === 'undo' && rec.state === 'committed' && typeof rec.meta.undoes === 'string' ? byId.get(rec.meta.undoes) : undefined
    if (!target) continue
    target.undone_by = rec.id
    if (target.kind === 'undo' && typeof target.meta.undoes === 'string') {
      const reverted = byId.get(target.meta.undoes)
      if (reverted) delete reverted.undone_by
    }
  }
  return records
}
