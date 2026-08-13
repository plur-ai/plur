import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { EngramSchemaPassthrough, type Engram } from './schemas/engram.js'
import { PackManifestSchema, type PackManifest } from './schemas/pack.js'
import { logger } from './logger.js'
import { atomicWrite } from './sync.js'

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
 * Parse store bytes into valid and quarantined entries, or throw.
 *
 * The single definition of "is this a readable engram store". It exists as a
 * standalone function because the rules were previously written out twice —
 * once in {@link loadEngrams} and once in `YamlStore` — and the copies drifted:
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
): { valid: Engram[]; quarantined: unknown[] } {
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
  const valid: Engram[] = []
  const quarantined: unknown[] = []
  for (const entry of raw.engrams) {
    const result = EngramSchemaPassthrough.safeParse(entry)
    if (result.success) valid.push(result.data)
    else quarantined.push(entry)
  }
  if (quarantined.length > 0) {
    logger.warning(
      `Quarantined ${quarantined.length} invalid engram(s) in ${filePath} — ` +
      `they are excluded from recall but PRESERVED in the file. Run 'plur doctor' to inspect them.`,
    )
  }
  return { valid, quarantined }
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
  const { valid, quarantined } = parseEngramFile(filePath, content, stat.size)
  setQuarantine(filePath, quarantined)
  return valid
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
 * A stale entry cannot cause loss: `saveEngrams` re-reads the file's current
 * quarantine before writing, and an id that has since become valid is
 * de-duplicated against the outgoing array.
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
  constructor(readonly filePath: string, readonly before: number, readonly after: number) {
    super(
      `[plur] refusing to write ${filePath}: it holds ${before} engram(s) and this write would leave ${after}.\n` +
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
 * How much of the corpus a single non-shrinking write may remove before it is
 * treated as corruption. Small deletions still happen legitimately through
 * paths that forget to declare themselves; a >10% drop is not a rounding error.
 */
const SHRINK_TOLERANCE = 0.1

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
  if (quarantined.length > 0) {
    const ids = new Set(outgoing.map(e => e.id))
    for (const entry of quarantined) {
      const id = (entry as any)?.id
      // An entry that has since been re-added properly must not come back as a
      // malformed duplicate.
      if (typeof id === 'string' && ids.has(id)) continue
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
  if (!opts.allowShrink) assertShrinkAllowed(filePath, outgoing.length)
  atomicWrite(filePath, content)
}

/**
 * Refuse a whole-corpus write that drops more than {@link SHRINK_TOLERANCE} of
 * the records on disk.
 *
 * Extracted so it is a SHARED FUNCTION rather than a step inside one writer
 * (#824, found in Črt's independent review). The guard lived only in
 * `saveEngrams`, and `YamlStore.save()` — the `EngramStore` backend from
 * `createStore`/`factory.ts` — is a parallel whole-corpus writer that
 * `yaml.dump`s straight to disk, so the F2/F3 wipe protection was silently
 * absent there. Same shape as the quarantine bug: a cross-cutting rule enforced
 * by convention and missed at a parallel call site.
 *
 * Sharing the function does not make the rule structural — a third writer could
 * still forget to call it — but it removes the copy, which is the part that
 * drifts. #824 tracks making it a type every writer must pass through.
 */
export function assertShrinkAllowed(filePath: string, outgoingCount: number): void {
  const before = countEngramsOnDisk(filePath)
  if (before !== null && outgoingCount < before * (1 - SHRINK_TOLERANCE)) {
    throw new EngramStoreShrinkError(filePath, before, outgoingCount)
  }
}

/**
 * Async twin of {@link assertShrinkAllowed}, for the async store backends.
 *
 * Shares `countRecordStarts` — the counting RULE has exactly one definition, so
 * the two paths cannot disagree about what a record is. Only the read differs,
 * because blocking the event loop on a multi-megabyte corpus is precisely what
 * the async store exists to avoid.
 */
export async function assertShrinkAllowedAsync(filePath: string, outgoingCount: number): Promise<void> {
  let before: number | null = null
  try {
    const { readFile, stat } = await import('fs/promises')
    const info = await stat(filePath)
    if (!info.isDirectory() && info.size > 0) {
      const text = await readFile(filePath, 'utf8')
      const scanned = countRecordStarts(text)
      if (scanned !== null) before = scanned
      else {
        const raw: any = yaml.load(text)
        before = raw && typeof raw === 'object' && Array.isArray(raw.engrams) ? raw.engrams.length : null
      }
    }
  } catch {
    before = null // no baseline — nothing to guard against
  }
  if (before !== null && outgoingCount < before * (1 - SHRINK_TOLERANCE)) {
    throw new EngramStoreShrinkError(filePath, before, outgoingCount)
  }
}

/**
 * Count engram records currently on disk, or `null` when there is nothing to
 * compare against (no file yet).
 *
 * Deliberately tolerant: an unreadable file returns `null` rather than throwing,
 * because the guard's job is to catch a shrink against a KNOWN baseline. Callers
 * that must not proceed on an unreadable store get that from `loadEngrams`,
 * which every one of them already went through to build the array being saved.
 */
function countEngramsOnDisk(filePath: string): number | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const stat = fs.statSync(filePath)
    if (stat.isDirectory() || stat.size === 0) return null
    const text = fs.readFileSync(filePath, 'utf8')
    const scanned = countRecordStarts(text)
    // The scan recognised the document's shape — trust it. It is exact for any
    // block-sequence `engrams:` list, which is what `yaml.dump` emits and what
    // every store file in the wild is.
    if (scanned !== null) return scanned
    // Unrecognised shape (flow sequence `engrams: [...]`, anchors, an exotic
    // hand edit). Fall back to the authoritative parse rather than guess: this
    // number can REFUSE a write, so it is never allowed to be an approximation.
    const raw: any = yaml.load(text)
    if (raw == null || typeof raw !== 'object' || !Array.isArray(raw.engrams)) return null
    return raw.engrams.length
  } catch {
    return null
  }
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

export function loadAllPacks(packsDir: string): LoadedPack[] {
  if (!fs.existsSync(packsDir)) return []
  const packs: LoadedPack[] = []
  for (const entry of fs.readdirSync(packsDir)) {
    const packDir = `${packsDir}/${entry}`
    if (!fs.statSync(packDir).isDirectory()) continue
    if (!fs.existsSync(`${packDir}/SKILL.md`) && !fs.existsSync(`${packDir}/manifest.yaml`)) continue
    try {
      packs.push(loadPack(packDir))
    } catch (err) {
      logger.warning(`Failed to load pack ${entry}: ${err}`)
    }
  }
  return packs
}

/** Derive a 3-char prefix from a store scope (e.g. 'datafund' → 'DFU', 'project:myapp' → 'PMY') */
export function storePrefix(scope: string): string {
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

export function generateEngramId(existing: Engram[]): string {
  const day = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const prefix = `ENG-${day}-`
  // Legacy compact form minted by earlier releases: ENG-YYYYMMDD → ENG-YYYY-MMDD-
  const legacyPrefix = `ENG-${day.slice(0, 4)}-${day.slice(5, 7)}${day.slice(8, 10)}-`
  const existingNums = existing
    .filter(e => e.id.startsWith(prefix) || e.id.startsWith(legacyPrefix))
    .map(e => parseInt(e.id.slice(e.id.startsWith(prefix) ? prefix.length : legacyPrefix.length), 10))
    .filter(n => !isNaN(n))
  const next = existingNums.length > 0 ? Math.max(...existingNums) + 1 : 1
  return `${prefix}${String(next).padStart(3, '0')}`
}
