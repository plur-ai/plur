import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { isTransientPackDir, loadPack } from '../engrams.js'
import { isPackUrl } from './download.js'
import { findRegistryRowIndex, isAmbiguousLegacyRow, isDirNow, loadRegistry, saveRegistry, withRegistryLock } from './registry.js'
import { normalizeStagedPack } from './staging.js'


// --- Integrity ---

/** What a pack's shipped integrity value says, checked against its contents. */
export interface IntegrityCheck {
  /** 'ok': matched. 'modified': did not match. 'absent': the pack shipped none. */
  status: 'ok' | 'modified' | 'absent'
  /** The value the pack shipped, if it shipped one. */
  shipped?: string
  /** The value its contents actually hash to. */
  computed: string
  /** What to tell the person deciding whether to install it. */
  note: string
}


/**
 * Compare the integrity value a pack SHIPPED against what its contents hash to.
 *
 * Export writes the hash into an `INTEGRITY` file; recomputing a fresh hash at
 * install and recording that would only show "we computed a hash", not "the
 * hash matched".
 *
 * Hash the pack AS RECEIVED. Install later hashes the staged, sanitised copy,
 * which legitimately differs when the privacy scan drops an engram; comparing
 * against that would raise a mismatch on packs nobody touched.
 *
 * A pack that ships no `INTEGRITY` is 'absent', not 'ok'. Nothing was checked.
 *
 * This detects accidental corruption and casual editing. It is NOT a defence
 * against a determined sender, who edits the contents and the `INTEGRITY` file
 * together: nothing here is signed. Say that plainly wherever this is shown.
 */
export function verifyPackIntegrity(packDir: string): IntegrityCheck {
  const file = path.join(packDir, 'INTEGRITY')

  if (!fs.existsSync(file)) {
    return {
      status: 'absent',
      computed: computePackIntegrity(packDir),
      note: 'This pack shipped no integrity value, so there was nothing to check it against.',
    }
  }

  const shipped = fs.readFileSync(file, 'utf8').trim()
  // Recompute in the version the pack shipped (§5.5): a legacy v1 value
  // verifies exactly as it always did, and `computed` stays comparable with
  // `shipped` when both are shown.
  const computed = computePackIntegrityLike(shipped, packDir)
  if (packIntegrityMatches(shipped, packDir)) {
    return {
      status: 'ok',
      shipped,
      computed,
      note: 'The contents match the value the pack shipped. That means it arrived intact — '
        + 'not that its contents are trustworthy, and not that the sender is who they say. '
        + 'Packs are not signed, so somebody who edited the contents could edit this value too.',
    }
  }
  return {
    status: 'modified',
    shipped,
    computed,
    note: 'The contents do NOT match the value the pack shipped. It has been changed since it '
      + 'was built, by damage in transit or by somebody editing it. Do not install it unless '
      + 'you know why it differs.',
  }
}


/**
 * The v1 pack hash (ENGRAM-STANDARD-v1.md §5.5, legacy form):
 *   H1 = SHA256( bytes(SKILL.md) || bytes(engrams.yaml) )
 * recorded as `sha256:<hex>`. Returns the bare hex.
 *
 * Kept so that every pack and registry row carrying a v1 value still verifies
 * (`packIntegrityMatches`). Do NOT use it for new values: the concatenation is
 * unframed, so it is not injective. Bytes moved across the file boundary keep
 * the hash, a missing SKILL.md hashes like an empty one, and a deprecated
 * `manifest.yaml` is not covered at all. New values are v2
 * (`computePackIntegrity`).
 */
export function computePackHash(packDir: string): string {
  return packHashV1FromParts(readPackIntegrityParts(packDir, ['SKILL.md', 'engrams.yaml']))
}


/** The parts the v2 hash covers, in the order it covers them (§5.5). */
export const PACK_INTEGRITY_V2_PARTS = ['SKILL.md', 'manifest.yaml', 'engrams.yaml'] as const


/**
 * The raw bytes of each part a pack hash covers (`PACK_INTEGRITY_V2_PARTS`, a
 * superset of the v1 parts), or `null` for a part that does not exist. Read
 * once, so a v1 check and a v2 value can be computed from the same bytes.
 */
export type PackIntegrityParts = Record<(typeof PACK_INTEGRITY_V2_PARTS)[number], Buffer | null>


export function readPackIntegrityParts(
  packDir: string,
  only: ReadonlyArray<(typeof PACK_INTEGRITY_V2_PARTS)[number]> = PACK_INTEGRITY_V2_PARTS,
): PackIntegrityParts {
  const parts = {} as PackIntegrityParts
  for (const name of PACK_INTEGRITY_V2_PARTS) {
    const p = path.join(packDir, name)
    parts[name] = only.includes(name) && fs.existsSync(p) ? fs.readFileSync(p) : null
  }
  return parts
}


/** v1 over already-read parts: SKILL.md then engrams.yaml, unframed. Bare hex. */
export function packHashV1FromParts(parts: PackIntegrityParts): string {
  const hash = crypto.createHash('sha256')
  // No manifest.yaml fallback.
  if (parts['SKILL.md']) hash.update(parts['SKILL.md'])
  if (parts['engrams.yaml']) hash.update(parts['engrams.yaml'])
  return hash.digest('hex')
}


/** v2 over already-read parts, as recorded: `sha256:v2:<hex>`. */
export function packIntegrityV2FromParts(parts: PackIntegrityParts): string {
  const hash = crypto.createHash('sha256')
  for (const name of PACK_INTEGRITY_V2_PARTS) {
    const bytes = parts[name]
    if (bytes) {
      hash.update(`${name}\0${bytes.length}\0`)
      hash.update(bytes)
    } else {
      hash.update(`${name}\0-\0`)
    }
  }
  return `sha256:v2:${hash.digest('hex')}`
}


/**
 * The v2 pack integrity value (ENGRAM-STANDARD-v1.md §5.5), as the string it is
 * recorded as: `sha256:v2:<64 lowercase hex>`.
 *
 *   H2 = SHA256( part(SKILL.md) || part(manifest.yaml) || part(engrams.yaml) )
 *   part(n) = n || 0x00 || decimal(byte length) || 0x00 || bytes   if the file exists
 *           = n || 0x00 || "-" || 0x00                              if it does not
 *
 * Every part is named and length-prefixed, and an absent part is spelled
 * differently from an empty one, so the input can be parsed back unambiguously:
 * two packs with the same value have byte-identical parts. That is what makes
 * it usable as a content-addressable identifier for a pack's hashed parts,
 * which v1 (`computePackHash`) is not.
 *
 * `provenance/` and `INTEGRITY` are not covered, as in v1. Raw file bytes; never
 * re-serialize before hashing.
 */
export function computePackIntegrity(packDir: string): string {
  return packIntegrityV2FromParts(readPackIntegrityParts(packDir))
}


export const INTEGRITY_V1_RE = /^sha256:[0-9a-f]{64}$/

export const INTEGRITY_V2_RE = /^sha256:v2:[0-9a-f]{64}$/


/**
 * What `packDir` hashes to, in the same version as `recorded`, so a shipped or
 * recorded v1 value is compared against a v1 recomputation, and anything else
 * (v2, or a value in no known format) against v2.
 */
export function computePackIntegrityLike(recorded: string, packDir: string): string {
  return INTEGRITY_V1_RE.test(recorded) ? `sha256:${computePackHash(packDir)}` : computePackIntegrity(packDir)
}


/**
 * Does `packDir` match a recorded integrity value? Accepts v1 (`sha256:<hex>`,
 * legacy) and v2 (`sha256:v2:<hex>`); any other format never matches.
 */
export function packIntegrityMatches(recorded: string, packDir: string): boolean {
  if (!INTEGRITY_V1_RE.test(recorded) && !INTEGRITY_V2_RE.test(recorded)) return false
  return computePackIntegrityLike(recorded, packDir) === recorded
}


// --- Migration: v1 -> v2 registry baselines ---

export type PackIntegrityMigrationAction =
  /**
   * v1 row, pack verifies clean under v1: re-baselined to v2 (or would be, on a
   * dry run). `baseline` says whether the pack was re-verified against its
   * source or the v1 trust was only carried forward.
   */
  | 'migrated'
  /** The row already carries v2. Nothing to do. */
  | 'already-v2'
  /**
   * Left as v1. `reason` says why: the pack no longer matches its v1 value
   * (`differs-from-v1`, it goes on reporting `modified`), or it matches v1 but
   * not what installing its recorded source produces (`differs-from-source`,
   * an edit v1 cannot see, or a source that has moved on since install).
   */
  | 'skipped-modified'
  /** No registry row for this pack. No baseline is invented. */
  | 'skipped-no-entry'
  /** A legacy row (no `dir`) that another installed directory's manifest also names, or one marked `ambiguous` when such a pack was uninstalled: it could be either pack's baseline, so it is left alone. */
  | 'skipped-ambiguous-legacy-row'
  /** The pack's manifest could not be read, so it cannot be matched to a row. */
  | 'skipped-unreadable'
  /** The row's value is in no known format. Left as it is. */
  | 'skipped-unknown-format'


export interface PackIntegrityMigrationReport {
  dry_run: boolean
  /** How many rows were (or, on a dry run, would be) re-baselined to v2, carried ones included. */
  migrated: number
  /** Of `migrated`, how many were carried forward without re-verification. */
  carried: number
  packs: Array<{
    /** Directory name under the packs directory. */
    dir: string
    /** Manifest name, when it could be read. */
    name?: string
    action: PackIntegrityMigrationAction
    /** For `migrated`: how the new baseline was established. */
    baseline?: 'source-verified' | 'carried-from-v1'
    /** For `skipped-modified`: which comparison failed. */
    reason?: 'differs-from-v1' | 'differs-from-source'
    from?: string
    to?: string
  }>
}


/**
 * The v2 value installing `source` would record today, or `null` when the
 * source is not a local pack directory that can be read (a URL, a path that no
 * longer exists, the installed directory itself, anything that fails to load).
 *
 * Only the three hashed parts are copied, into a temporary directory, and put
 * through the same `normalizeStagedPack` install uses, so a source that install
 * had to neutralize still reproduces the installed bytes.
 */
export function expectedInstalledIntegrity(source: string | undefined, packDir: string): string | null {
  if (!source || isPackUrl(source)) return null
  const src = path.resolve(source)
  if (src === path.resolve(packDir) || !isDirNow(src)) return null
  let tmp: string | undefined
  try {
    const manifest = loadPack(src).manifest
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-pack-reverify-'))
    for (const name of PACK_INTEGRITY_V2_PARTS) {
      const from = path.join(src, name)
      let st: fs.Stats
      try { st = fs.lstatSync(from) } catch { continue } // absent part
      if (!st.isFile()) return null // a link or special file: install would refuse it
      fs.copyFileSync(from, path.join(tmp, name))
    }
    normalizeStagedPack(tmp, manifest)
    return computePackIntegrity(tmp)
  } catch {
    return null
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }
}


/**
 * Re-baseline installed packs' registry integrity from v1 to v2 (§5.5).
 *
 * A v1 match is NOT evidence that a pack is unchanged: v1 cannot see bytes
 * moved across the SKILL.md / engrams.yaml boundary, nor a `manifest.yaml`
 * added beside SKILL.md. So a row whose pack still
 * matches v1 is handled in one of two ways:
 *
 *   - its recorded `source` is still a local pack directory: the pack is
 *     re-verified against what installing that source produces, and
 *     re-baselined only if it matches (`baseline: 'source-verified'`), else
 *     left as v1 (`skipped-modified`, `reason: 'differs-from-source'`);
 *   - otherwise the v2 value is recorded but marked
 *     `integrity_carried_from: 'v1'` (`baseline: 'carried-from-v1'`), and
 *     `listPacks` reports it as carried. It inherits v1's trust; it certifies
 *     nothing.
 *
 * A pack that no longer matches its v1 value keeps it and goes on reporting
 * `modified`. Nothing else in the row changes, and a pack's shipped
 * `INTEGRITY` file is never touched (it is the producer's value, §5.5.1).
 *
 * Staging (`*.installing-*`) and displaced (`*.replacing-*`) directories and
 * non-directories are skipped, and an entry that vanishes mid-walk is skipped
 * rather than aborting the run. The hashing is done WITHOUT the registry lock;
 * only a real run takes it, briefly, to write rows whose value is still the one
 * it planned from. A dry run never takes it. Idempotent.
 */
export function migratePackIntegrity(
  packsDir: string,
  opts: { dryRun?: boolean } = {},
): PackIntegrityMigrationReport {
  const dryRun = opts.dryRun === true
  const report: PackIntegrityMigrationReport = { dry_run: dryRun, migrated: 0, carried: 0, packs: [] }
  if (!fs.existsSync(packsDir)) return report

  const entries = loadRegistry(packsDir)
  const plan: Array<{ dir: string; name: string; from: string; to: string; carried: boolean }> = []
  for (const dir of fs.readdirSync(packsDir).sort()) {
    if (isTransientPackDir(dir)) continue
    const packDir = path.join(packsDir, dir)
    if (!isDirNow(packDir)) continue
    let name: string
    try { name = loadPack(packDir).manifest.name } catch {
      if (!fs.existsSync(packDir)) continue // removed mid-walk
      report.packs.push({ dir, action: 'skipped-unreadable' })
      continue
    }
    // By directory first, a legacy row (no `dir`) by manifest name: the same
    // rule listPacks verifies with, so a pack is migrated against its own row.
    // A legacy row that another directory's manifest also names could be
    // either pack's baseline: leave it alone rather than guess.
    const idx = findRegistryRowIndex(entries, dir, name)
    const row = idx >= 0 ? entries[idx] : undefined
    if (isAmbiguousLegacyRow(packsDir, dir, name, row, entries)) {
      report.packs.push({ dir, name, action: 'skipped-ambiguous-legacy-row' })
      continue
    }
    if (!row) { report.packs.push({ dir, name, action: 'skipped-no-entry' }); continue }
    if (INTEGRITY_V2_RE.test(row.integrity)) { report.packs.push({ dir, name, action: 'already-v2' }); continue }
    if (!INTEGRITY_V1_RE.test(row.integrity)) {
      report.packs.push({ dir, name, action: 'skipped-unknown-format', from: row.integrity })
      continue
    }
    // One read serves both the v1 check and the new v2 value. Reading twice
    // would let an edit made between the reads become the new baseline of a
    // row carried forward from v1, unreported.
    const parts = readPackIntegrityParts(packDir)
    if (`sha256:${packHashV1FromParts(parts)}` !== row.integrity) {
      report.packs.push({ dir, name, action: 'skipped-modified', reason: 'differs-from-v1', from: row.integrity })
      continue
    }
    const to = packIntegrityV2FromParts(parts)
    const expected = expectedInstalledIntegrity(row.source, packDir)
    if (expected !== null && expected !== to) {
      report.packs.push({ dir, name, action: 'skipped-modified', reason: 'differs-from-source', from: row.integrity })
      continue
    }
    const carried = expected === null
    report.packs.push({
      dir, name, action: 'migrated',
      baseline: carried ? 'carried-from-v1' : 'source-verified',
      from: row.integrity, to,
    })
    report.migrated++
    if (carried) report.carried++
    plan.push({ dir, name, from: row.integrity, to, carried })
  }

  if (!dryRun && plan.length > 0) {
    withRegistryLock(packsDir, () => {
      // Re-read under the lock: an install or uninstall may have landed since
      // the plan was made. Only a row still holding the value planned from is
      // rewritten; anything else was changed by somebody else and is theirs.
      const current = loadRegistry(packsDir)
      let changed = false
      for (const step of plan) {
        const i = findRegistryRowIndex(current, step.dir, step.name)
        const row = i >= 0 ? current[i] : undefined
        if (!row || row.integrity !== step.from) continue
        row.integrity = step.to
        if (step.carried) row.integrity_carried_from = 'v1'
        else delete row.integrity_carried_from
        changed = true
      }
      if (changed) saveRegistry(packsDir, current)
    })
  }
  return report
}


/**
 * A short form of a §5.5 value for display, long enough to tell packs apart:
 * the form prefix (`sha256:v2:` or `sha256:`) and the first 12 hex digits.
 */
export function shortPackIntegrity(value: string): string {
  const m = /^(sha256:(?:v2:)?)([0-9a-f]+)$/.exec(value)
  return m ? `${m[1]}${m[2].slice(0, 12)}` : value.slice(0, 22)
}
