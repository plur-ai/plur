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
  // An existing but zero-length file is never something PLUR wrote:
  // `initFilesystemStore` writes `engrams: []`, which is 12 bytes. It is a
  // truncation artifact, and yaml.load() would hand back `undefined` for it.
  if (stat.size === 0) {
    throw new EngramStoreUnreadableError(filePath, new Error('file is empty (0 bytes)'))
  }
  let raw: any
  try {
    raw = yaml.load(fs.readFileSync(filePath, 'utf8'))
  } catch (err) {
    throw new EngramStoreUnreadableError(filePath, err)
  }
  // Non-empty bytes that parse to nothing: a comments-only or whitespace-only
  // file. PLUR never writes one, so this is a truncation, not a fresh store.
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
  if (raw.engrams == null) return []
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
  if (!opts.allowShrink) {
    const before = countEngramsOnDisk(filePath)
    if (before !== null && outgoing.length < before * (1 - SHRINK_TOLERANCE)) {
      throw new EngramStoreShrinkError(filePath, before, outgoing.length)
    }
  }
  const content = yaml.dump({ engrams: outgoing }, { lineWidth: 120, noRefs: true, quotingType: '"' })
  atomicWrite(filePath, content)
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
    const raw: any = yaml.load(fs.readFileSync(filePath, 'utf8'))
    if (raw == null || typeof raw !== 'object' || !Array.isArray(raw.engrams)) return null
    return raw.engrams.length
  } catch {
    return null
  }
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
