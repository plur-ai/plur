import * as fs from 'fs'
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
 * Individually invalid ENTRIES are still skipped rather than fatal: one bad
 * engram among many is a partial-data problem, not an unreadable-store problem,
 * and dropping it loses less than refusing to load the rest. That skip is
 * counted and warned about.
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
  if (fs.statSync(filePath).isDirectory()) return []
  let raw: any
  try {
    raw = yaml.load(fs.readFileSync(filePath, 'utf8'))
  } catch (err) {
    throw new EngramStoreUnreadableError(filePath, err)
  }
  // A file that parses but has no `engrams` array is genuinely empty — a fresh
  // store, or one whose only content is comments.
  if (raw == null) return []
  if (!raw.engrams || !Array.isArray(raw.engrams)) {
    if (typeof raw !== 'object') {
      throw new EngramStoreUnreadableError(filePath, new Error('top-level value is not a mapping'))
    }
    return []
  }
  const valid: Engram[] = []
  let skipped = 0
  for (const entry of raw.engrams) {
    const result = EngramSchemaPassthrough.safeParse(entry)
    if (result.success) valid.push(result.data)
    else skipped++
  }
  if (skipped > 0) logger.warning(`Skipped ${skipped} invalid engram(s) in ${filePath}`)
  return valid
}

export function saveEngrams(filePath: string, engrams: Engram[]): void {
  const content = yaml.dump({ engrams }, { lineWidth: 120, noRefs: true, quotingType: '"' })
  atomicWrite(filePath, content)
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
