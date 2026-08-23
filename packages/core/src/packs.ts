import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import * as os from 'os'
import { execFileSync } from 'child_process'
import yaml from 'js-yaml'
import { loadPack, loadEngrams, saveEngrams } from './engrams.js'
import { atomicWrite, fsyncDir, withLock } from './sync.js'
import { detectSensitive, detectPromptInjection, truncateToScanLimit } from './secrets.js'
import type { Engram } from './schemas/engram.js'
import { buildProvenanceRecord, buildPackProvenanceRecord, serializeProvenanceRecord } from './provenance.js'
import type { PackManifest } from './schemas/pack.js'
import { logger } from './logger.js'

export { loadAllPacks } from './engrams.js'

// --- URL download helpers ---

/** Returns true if the source string looks like an http/https URL. */
/**
 * Directory name a downloaded archive is extracted into. For a FLAT archive
 * (pack files at the archive root) this also becomes the source basename, which
 * is why installPack overrides it with the manifest name — otherwise every flat
 * archive would install to `packs/extracted` (#813).
 */
export const FLAT_ARCHIVE_DIRNAME = 'extracted'

export function isPackUrl(source: string): boolean {
  return source.startsWith('http://') || source.startsWith('https://')
}

/**
 * Download a pack tar.gz from `url`, extract it to a temp directory, and
 * return the path to the extracted pack directory.
 *
 * The caller is responsible for removing the returned temp directory when done.
 * Use `cleanupDownloadedPack` for that.
 *
 * The archive must be a gzipped tar whose top-level directory is the pack
 * (e.g. `my-pack/SKILL.md`, `my-pack/engrams.yaml`). A flat archive (files
 * at the root without a subdirectory) is also accepted — in that case the
 * extraction root itself is returned as the pack directory.
 *
 * No auth headers are added: signed-URL delivery means the URL is the
 * credential and no Authorization header is needed.
 */
export async function downloadAndExtractPack(url: string): Promise<{ packDir: string; tmpRoot: string }> {
  // Create a unique temp root for this download
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-pack-dl-'))

  // Download
  let response: Response
  try {
    response = await fetch(url)
  } catch (err: unknown) {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to fetch pack from ${url}: ${msg}`)
  }

  if (!response.ok) {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    throw new Error(`Failed to fetch pack from ${url}: HTTP ${response.status} ${response.statusText}`)
  }

  // Save the response body to a .tar.gz file
  const archivePath = path.join(tmpRoot, 'pack.tar.gz')
  const buffer = await response.arrayBuffer()
  fs.writeFileSync(archivePath, Buffer.from(buffer))

  // Extract the archive
  const extractDir = path.join(tmpRoot, FLAT_ARCHIVE_DIRNAME)
  fs.mkdirSync(extractDir)
  try {
    execFileSync('tar', ['-xzf', archivePath, '-C', extractDir], { stdio: 'pipe' })
  } catch (err: unknown) {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    const msg = err instanceof Error ? (err as NodeJS.ErrnoException).message : String(err)
    throw new Error(`Failed to extract pack archive from ${url}: ${msg}`)
  }

  // Find the pack directory: either a single top-level subdirectory, or the
  // extraction root itself (for flat archives).
  const entries = fs.readdirSync(extractDir)
  const subdirs = entries.filter(e => fs.statSync(path.join(extractDir, e)).isDirectory())

  let packDir: string
  if (subdirs.length === 1) {
    // Standard layout: archive contains a single top-level directory
    packDir = path.join(extractDir, subdirs[0])
  } else {
    // Flat layout: SKILL.md / engrams.yaml at archive root
    const hasPackFiles = entries.some(e => e === 'SKILL.md' || e === 'engrams.yaml' || e === 'manifest.yaml')
    if (hasPackFiles) {
      packDir = extractDir
    } else {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
      throw new Error(
        `Pack archive from ${url} has an unexpected layout — expected a single top-level directory or pack files at the root (SKILL.md / engrams.yaml).`,
      )
    }
  }

  return { packDir, tmpRoot }
}

/** Remove the temp directory created by downloadAndExtractPack. Safe to call even if the path no longer exists. */
export function cleanupDownloadedPack(tmpRoot: string): void {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup — log but do not throw
    logger.warning(`cleanupDownloadedPack: could not remove temp dir ${tmpRoot}`)
  }
}

// --- Registry ---

export interface RegistryEntry {
  name: string
  installed_at: string
  source: string
  integrity: string
  version?: string
  creator?: string
}

function registryPath(packsDir: string): string {
  return path.join(packsDir, 'registry.yaml')
}

/**
 * The pack registry exists but cannot be read as a registry (#805, audit F11).
 *
 * Mirrors `EngramStoreUnreadableError`, and for the same reason: the writer is
 * a whole-file replace, so treating an unreadable file as "no packs recorded"
 * means the next install rewrites it with a single entry and every other pack's
 * integrity baseline is gone. Unlike the engram store, what is destroyed is not
 * the data — the packs are still on disk — but the ability to tell whether that
 * data has been tampered with, which fails silent.
 */
export class PackRegistryUnreadableError extends Error {
  constructor(readonly filePath: string, readonly detail: string) {
    super(
      `[plur] refusing to read ${filePath}: ${detail}\n` +
      `The file exists but is not a valid pack registry, so PLUR cannot tell which packs were installed ` +
      `or what they hashed to at install time. It is NOT being treated as empty: the write path replaces ` +
      `the whole file, so an install against an "empty" registry would erase the integrity baseline for ` +
      `every other installed pack — after which a tampered pack reports its integrity as UNKNOWN rather ` +
      `than MODIFIED.\n` +
      `Fix the file (or delete it and re-run 'plur packs install' for each pack to rebuild the baseline) ` +
      `and retry.`,
    )
    this.name = 'PackRegistryUnreadableError'
  }
}

/**
 * Read the registry, refusing rather than guessing (#805, F11).
 *
 * The old body ended in `catch { return [] }`, with the same shape for a file
 * that parsed to something other than `{packs: [...]}`. Measured consequence
 * (probe p08b): truncate the registry, run ONE install, and the surviving entry
 * is that install alone — `integrity_ok` for a previously installed pack goes
 * `true` -> `undefined`, and tampering with its engrams then still reports
 * `undefined`, never `false`. The check that exists to catch a modified pack had
 * degraded to "unknown" without anything saying so.
 */
function loadRegistry(packsDir: string): RegistryEntry[] {
  const p = registryPath(packsDir)
  if (!fs.existsSync(p)) return [] // never installed anything — genuinely empty
  const raw = fs.readFileSync(p, 'utf8')
  if (raw.trim().length === 0) throw new PackRegistryUnreadableError(p, 'the file is empty')
  let parsed: unknown
  try {
    parsed = yaml.load(raw)
  } catch (err) {
    throw new PackRegistryUnreadableError(p, `YAML parse failed: ${(err as Error).message}`)
  }
  if (parsed === null || parsed === undefined) {
    throw new PackRegistryUnreadableError(p, 'the file parsed to nothing')
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PackRegistryUnreadableError(p, `expected a mapping with a "packs" key, got ${Array.isArray(parsed) ? 'a list' : typeof parsed}`)
  }
  const packs = (parsed as { packs?: unknown }).packs
  if (packs === undefined || packs === null) {
    throw new PackRegistryUnreadableError(p, 'no "packs" key')
  }
  if (!Array.isArray(packs)) {
    throw new PackRegistryUnreadableError(p, `"packs" is ${typeof packs}, expected a list`)
  }
  return packs as RegistryEntry[]
}

function saveRegistry(packsDir: string, entries: RegistryEntry[]): void {
  const content = yaml.dump({ packs: entries }, { lineWidth: 120, noRefs: true, quotingType: '"' })
  // Atomic + fsynced (#805, F11). A plain writeFileSync truncates in place, so
  // a crash or a full disk mid-write leaves a half-written registry — which the
  // loader above now refuses, but refusing is only the second line of defence.
  // `atomicWrite` writes to a unique temp file, fsyncs it, renames, then fsyncs
  // the directory, so the registry is either the old one or the new one.
  atomicWrite(registryPath(packsDir), content)
}

/**
 * Serialize a registry read-modify-write (audit 2026-08-03, finding 3).
 *
 * Making `saveRegistry` atomic fixed torn files but not lost updates, and those
 * are the more likely failure: two processes installing different packs each
 * read the same registry, each add their own entry, and each rename a COMPLETE
 * but different snapshot. Both packs end up installed on disk, the last rename
 * wins, and the other pack's integrity baseline is simply gone — after which it
 * reports `unverified` and a tampered copy of it can no longer be detected.
 * That is finding F11's harm arriving by a different road.
 *
 * Two MCP servers, or an MCP server and a CLI, is the ordinary case rather than
 * an exotic one, so atomicity alone was never enough.
 */
function withRegistryLock<T>(packsDir: string, fn: () => T): T {
  // The lock file must live next to the registry, and the directory may not
  // exist yet on a first install.
  if (!fs.existsSync(packsDir)) fs.mkdirSync(packsDir, { recursive: true })
  return withLock(registryPath(packsDir), fn)
}

function addToRegistry(packsDir: string, entry: RegistryEntry): void {
  withRegistryLock(packsDir, () => {
    const entries = loadRegistry(packsDir)
    const idx = entries.findIndex(e => e.name === entry.name)
    if (idx >= 0) entries[idx] = entry
    else entries.push(entry)
    saveRegistry(packsDir, entries)
  })
}

function removeFromRegistry(packsDir: string, name: string): void {
  withRegistryLock(packsDir, () => {
    const entries = loadRegistry(packsDir).filter(e => e.name !== name)
    saveRegistry(packsDir, entries)
  })
}

/** Rewrite one entry's `source` under the same lock — the URL-install path. */
function setRegistrySource(packsDir: string, name: string, source: string): void {
  withRegistryLock(packsDir, () => {
    const entries = loadRegistry(packsDir)
    const idx = entries.findIndex(e => e.name === name)
    if (idx >= 0) { entries[idx].source = source; saveRegistry(packsDir, entries) }
  })
}

// --- Preview ---

export interface PreviewResult {
  manifest: PackManifest
  engram_count: number
  engrams: Array<{ id: string; type: string; statement: string; domain?: string; tags: string[] }>
  security: PrivacyScanResult
  warnings: string[]
  /** What the pack says about where its engrams came from (#970 case 3). */
  provenance: PackProvenanceView
  /** Whether the contents match the integrity value the pack shipped (#987). */
  integrity: IntegrityCheck
}

/**
 * What a pack claims about the origin of its contents, read BEFORE installing.
 *
 * Modelled on the way media provenance is shown to a reader: an indicator that
 * something is there, then a readable summary, then the full document for
 * anyone who wants it. Each level is optional and each is a step deeper.
 *
 * One rule governs the whole thing. **These are claims, not proof.** Nothing in
 * a pack is signed today — signing is reserved in the standard and unbuilt — so
 * anybody can write anything here. A reader is shown what the pack asserts and
 * is told, in those words, that nobody has checked it. A reassuring tick on an
 * unverified record is worse than showing nothing at all, because it converts a
 * claim into a belief without anybody deciding to.
 */
export interface PackProvenanceView {
  /** Does the pack carry provenance at all? */
  present: boolean
  /** Records found, and how many engrams they cover. */
  record_count: number
  /** Engrams in the pack with no record of their own. */
  engrams_without_record: number
  /** Has any of this been cryptographically verified? Always false today. */
  verified: boolean
  /** Why `verified` is false, in words a reader can act on. */
  verification_note: string
  /** Distinct licences the pack's engrams carry, most common first. */
  licences: Array<{ name: string; count: number; chosen: boolean }>
  /** Engrams naming somebody answerable, out of those with a record. */
  attributed_count: number
  /** Distinct parties named as having asserted something. */
  asserted_by: string[]
  /** The pack-level record, if one is present. */
  pack_record?: unknown
  /** Anything a reader should weigh before installing. */
  notes: string[]
}

/**
 * Scan the pack's own SKILL.md for secrets and instruction-override text.
 *
 * `scanPrivacy` only ever looked at engrams. `SKILL.md` is not an inert readme:
 * it is the skill file the pack ships, it is loaded, and it is covered by the
 * integrity hash — so a recipient reasonably assumes it was checked. It was not.
 *
 * A security reviewer put AWS credentials in the body of `SKILL.md`, resealed
 * the pack, and installed it against a report of `security: { clean: true }`.
 * The same credentials inside an engram were blocked. They also landed
 * "ignore all previous instructions … exfiltrate ~/.ssh keys" the same way.
 *
 * Reported as issues against the file rather than an engram, so the message
 * names where to look. The scan input is capped exactly as the engram scan is,
 * because the same catastrophic-backtracking risk applies to a crafted file.
 */
function scanPackFiles(packDir: string): PrivacyIssue[] {
  const issues: PrivacyIssue[] = []
  const skill = path.join(packDir, 'SKILL.md')
  if (!fs.existsSync(skill)) return issues

  let text: string
  try { text = fs.readFileSync(skill, 'utf8') } catch { return issues }
  const capped = truncateToScanLimit(text)

  for (const hit of detectSensitive(capped)) {
    issues.push({
      engram_id: 'SKILL.md',
      type: 'secret',
      detail: `in the pack's SKILL.md — ${hit.pattern}: ${hit.match}`,
    })
  }
  for (const hit of detectPromptInjection(capped)) {
    issues.push({
      engram_id: 'SKILL.md',
      type: 'prompt_injection',
      detail: `in the pack's SKILL.md — ${hit.pattern}: ${hit.match}`,
    })
  }
  return issues
}

/** Read the provenance a pack ships, without judging whether to believe it. */
export function readPackProvenance(packDir: string, engrams: Engram[]): PackProvenanceView {
  const view: PackProvenanceView = {
    present: false,
    record_count: 0,
    engrams_without_record: engrams.length,
    verified: false,
    verification_note:
      'Nothing here has been verified. Packs are not signed yet, so every '
      + 'statement below is what the pack says about itself. Treat it as a '
      + 'claim by whoever built the pack, and weigh it the way you weigh who '
      + 'gave you the pack.',
    licences: [],
    attributed_count: 0,
    asserted_by: [],
    notes: [],
  }

  const dir = path.join(packDir, 'provenance')
  if (!fs.existsSync(dir)) {
    view.notes.push('This pack carries no provenance. That is not a fault — most packs do not — but nothing here says where its contents came from.')
    return view
  }
  view.present = true

  // The identifier comes from a file a stranger wrote. The schema constrains it
  // to ^(ENG|ABS|META)-[A-Za-z0-9-]+$ and quarantines anything else before it
  // gets here, so an id cannot climb out of this directory today. Sanitise
  // anyway: this builds a filesystem path from untrusted input, and if that
  // validation is ever loosened or another caller skips it, the cost of being
  // wrong is an arbitrary file read.
  const readJson = (name: string): any | undefined => {
    const safe = name.replace(/[^A-Za-z0-9._-]/g, '_')
    try { return JSON.parse(fs.readFileSync(path.join(dir, safe), 'utf8')) } catch { return undefined }
  }

  const packRecord = readJson('pack.jsonld')
  if (packRecord) view.pack_record = packRecord

  const licences = new Map<string, { count: number; chosen: boolean }>()
  const parties = new Set<string>()

  for (const engram of engrams) {
    const record = readJson(`${engram.id}.jsonld`)
    if (!record) continue
    view.record_count++

    const subject = (record['@graph'] ?? []).find((n: any) => n['@id'] === `engram:${engram.id}`)
    if (!subject) continue

    const licence = subject['engram:license']
    if (typeof licence === 'string') {
      const chosen = subject['engram:licenseIsDefault'] !== true
      const seen = licences.get(licence)
      // One engram that CHOSE a licence is enough to stop calling it defaulted.
      if (seen) { seen.count++; seen.chosen = seen.chosen || chosen }
      else licences.set(licence, { count: 1, chosen })
    }

    const who = subject['prov:wasAttributedTo']?.['@id']
    if (typeof who === 'string') {
      const name = who.replace(/^engram:agent\//, '')
      if (name !== 'unidentified') { view.attributed_count++; parties.add(name) }
    }
  }

  view.engrams_without_record = engrams.length - view.record_count
  // Said here, not above, because it depends on how many per-engram records
  // turned up. Claiming "records for individual engrams but none for the pack"
  // when there are no records of any kind is simply false.
  if (!packRecord) {
    view.notes.push(view.record_count > 0
      ? 'There are records for individual engrams but none for the pack as a whole.'
      : 'The pack has a provenance directory but no readable records in it.')
  }
  view.asserted_by = [...parties].sort()
  view.licences = [...licences.entries()]
    .map(([name, v]) => ({ name, count: v.count, chosen: v.chosen }))
    .sort((a, b) => b.count - a.count)

  if (view.engrams_without_record > 0) {
    view.notes.push(`${view.engrams_without_record} of ${engrams.length} engram(s) have no record of their own.`)
  }
  if (view.record_count > 0 && view.attributed_count === 0) {
    view.notes.push('No engram names anybody answerable for it. The records say where things came from but not who put them there.')
  }
  const defaulted = view.licences.filter(l => !l.chosen)
  if (defaulted.length) {
    view.notes.push(
      `Licence "${defaulted[0].name}" was never chosen by the pack's author — it is the value engrams get when nobody sets one. `
      + 'Do not read it as the author granting you those terms.',
    )
  }
  return view
}

function _previewPackDir(source: string): PreviewResult {
  if (!fs.existsSync(source)) throw new Error(`Pack source not found: ${source}`)

  const pack = loadPack(source)
  const security = scanPrivacy(pack.engrams)
  // The pack ships more than engrams, and the rest was never scanned.
  const fileIssues = scanPackFiles(source)
  if (fileIssues.length) {
    security.issues.push(...fileIssues)
    security.clean = false
  }
  // Read what the pack claims about its own origins, BEFORE anything installs.
  // The gate belongs at the boundary; afterwards it changes nothing.
  const provenance = readPackProvenance(source, pack.engrams)
  // Check the SHIPPED value against the contents, before anything installs.
  const integrity = verifyPackIntegrity(source)

  const warnings: string[] = []
  // Flag pinned engrams — they bypass the relevance gate (always injected).
  // install strips these, but the preview should be honest about intent (finding #2).
  const pinnedCount = pack.engrams.filter(e => (e as any).pinned === true).length
  if (pinnedCount > 0) warnings.push(`${pinnedCount} engram(s) marked pinned — these bypass relevance filters; install will strip the flag`)
  // Flag prompt-injection text surfaced by the privacy scan
  const injectionCount = security.issues.filter(i => i.type === 'prompt_injection').length
  if (injectionCount > 0) warnings.push(`${injectionCount} engram(s) contain prompt-injection / instruction-override text — install is blocked unless overridden`)
  // Flag engrams with global scope (could override user's own engrams)
  const globalCount = pack.engrams.filter(e => e.scope === 'global').length
  if (globalCount > 0) warnings.push(`${globalCount} engram(s) have global scope — may interact with your own engrams`)
  // Flag very high retrieval strength (unusual for fresh packs)
  const hotEngrams = pack.engrams.filter(e => e.activation.retrieval_strength > 0.9)
  if (hotEngrams.length > 0) warnings.push(`${hotEngrams.length} engram(s) have unusually high retrieval strength (>0.9)`)

  return {
    manifest: pack.manifest,
    engram_count: pack.engrams.length,
    engrams: pack.engrams.map(e => ({
      id: e.id,
      type: e.type,
      statement: e.statement,
      domain: e.domain,
      tags: e.tags ?? [],
    })),
    security,
    warnings,
    provenance,
    integrity,
  }
}

/**
 * Preview a pack before installing — shows manifest, engrams, and security scan.
 *
 * `source` may be a local directory path or an http/https URL pointing to a
 * `.tar.gz` archive. URL packs are downloaded to a temp directory, previewed,
 * and the temp directory is cleaned up before returning.
 */
export async function previewPack(source: string): Promise<PreviewResult> {
  if (isPackUrl(source)) {
    const { packDir, tmpRoot } = await downloadAndExtractPack(source)
    try {
      return _previewPackDir(packDir)
    } finally {
      cleanupDownloadedPack(tmpRoot)
    }
  }
  return _previewPackDir(source)
}

// --- Install ---

export interface InstallResult {
  installed: number
  name: string
  conflicts: ConflictItem[]
  security: PrivacyScanResult
  registry: RegistryEntry
  /**
   * What checking the shipped integrity value found (#987). Reported even when
   * it passed, so a caller can tell "matched" from "there was nothing to match
   * against" — the distinction the old `integrity_ok: true` erased.
   */
  integrity_check: IntegrityCheck
}

export interface ConflictItem {
  pack_engram_id: string
  pack_statement: string
  existing_engram_id: string
  existing_statement: string
  type: 'contradiction' | 'duplicate'
}

function detectConflicts(newEngrams: Engram[], existingEngrams: Engram[]): ConflictItem[] {
  const conflicts: ConflictItem[] = []

  for (const ne of newEngrams) {
    for (const ee of existingEngrams) {
      // Exact or near-duplicate detection (same statement after normalization)
      const nNorm = ne.statement.toLowerCase().replace(/\s+/g, ' ').trim()
      const eNorm = ee.statement.toLowerCase().replace(/\s+/g, ' ').trim()

      if (nNorm === eNorm) {
        conflicts.push({
          pack_engram_id: ne.id,
          pack_statement: ne.statement.slice(0, 120),
          existing_engram_id: ee.id,
          existing_statement: ee.statement.slice(0, 120),
          type: 'duplicate',
        })
        continue
      }

      // Contradiction detection: same domain + opposite polarity signals
      if (ne.domain && ee.domain && ne.domain === ee.domain) {
        // Check for "always X" vs "never X" or "use X" vs "don't use X"
        const nHasNever = /\b(never|don't|do not|avoid|stop)\b/i.test(ne.statement)
        const eHasNever = /\b(never|don't|do not|avoid|stop)\b/i.test(ee.statement)
        const nHasAlways = /\b(always|must|should|prefer|use)\b/i.test(ne.statement)
        const eHasAlways = /\b(always|must|should|prefer|use)\b/i.test(ee.statement)

        // Opposite polarity in same domain = potential contradiction
        if ((nHasNever && eHasAlways) || (nHasAlways && eHasNever)) {
          // Check for topic overlap (shared non-trivial words)
          const nWords = new Set(nNorm.split(' ').filter(w => w.length > 4))
          const eWords = new Set(eNorm.split(' ').filter(w => w.length > 4))
          const overlap = [...nWords].filter(w => eWords.has(w))
          if (overlap.length >= 2) {
            conflicts.push({
              pack_engram_id: ne.id,
              pack_statement: ne.statement.slice(0, 120),
              existing_engram_id: ee.id,
              existing_statement: ee.statement.slice(0, 120),
              type: 'contradiction',
            })
          }
        }
      }
    }
  }

  return conflicts
}

export interface InstallOptions {
  /** Override the prompt-injection block. Secrets are ALWAYS blocked regardless. */
  allowInjection?: boolean
  /**
   * Install even though the contents do not match the integrity value the pack
   * shipped (#987). Off by default: a pack that changed after it was built is
   * exactly the case somebody should have to look at before proceeding.
   */
  allowModified?: boolean
}

/**
 * Serialize a parsed manifest back to SKILL.md content (frontmatter + body).
 * Used to auto-upgrade a deprecated `manifest.yaml` pack to the canonical
 * SKILL.md form on install (#325). 1:1 with PackManifestSchema, so it re-parses.
 */
function manifestToSkillMd(m: PackManifest): string {
  const fm: Record<string, unknown> = { name: m.name, version: m.version }
  if (m.description) fm.description = m.description
  if (m.creator) fm.creator = m.creator
  if (m.license) fm.license = m.license
  if (m.tags && m.tags.length) fm.tags = m.tags
  if (m.metadata) fm.metadata = m.metadata
  const legacy = (m as Record<string, unknown>)['x-datacore']
  if (legacy) fm['x-datacore'] = legacy
  return `---\n${yaml.dump(fm)}---\n\n# ${m.name}\n\n${m.description ?? ''}\n`
}

/**
 * fsync every file in a staged pack, then the directory itself (audit
 * 2026-08-03, finding 11).
 *
 * Best-effort per entry, like `fsyncDir`: a filesystem that cannot fsync a
 * directory must not fail an otherwise good install. Packs are small — a
 * manifest and an engrams file — so this is a handful of syscalls, paid once
 * per install, to stop a crash leaving a durable registry entry pointing at
 * content that never reached the disk.
 */
function fsyncTree(dir: string): void {
  let entries: string[]
  try { entries = fs.readdirSync(dir) } catch { return }
  for (const name of entries) {
    const p = path.join(dir, name)
    try {
      if (fs.statSync(p).isDirectory()) { fsyncTree(p); continue }
      const fd = fs.openSync(p, 'r')
      try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    } catch { /* unreadable or unsupported — skip */ }
  }
  try { fsyncDir(dir) } catch { /* not a syncable directory */ }
}

function _installPackDir(
  packsDir: string,
  source: string,
  existingEngrams?: Engram[],
  opts: InstallOptions = {},
): InstallResult {
  if (!fs.existsSync(source)) throw new Error(`Pack source not found: ${source}`)

  // Preflight the registry BEFORE doing any filesystem work (#805, F11). The
  // registry is only WRITTEN at the end of this function, so without this check
  // an unreadable registry aborts the install after the pack directory is
  // already live — leaving it installed but unrecorded, which then reports
  // `integrity_status: 'unverified'`. That is precisely the ambiguous state
  // this finding is about, so failing early is part of the fix, not a nicety.
  loadRegistry(packsDir)

  // Security scan BEFORE copying — always runs, not opt-out
  const preview = _previewPackDir(source)

  // Does the pack still match the integrity value its author shipped? This was
  // never checked: install recomputed a hash, recorded it, and reported success,
  // so a pack edited after it was built installed silently and `plur packs list`
  // then called it `integrity_ok: true`.
  //
  // Blocking is the right default. Unlike the injection scan, there is no
  // legitimate reason for a pack to differ from its own recorded hash — either
  // it was damaged in transit or somebody changed it, and both deserve a look.
  if (preview.integrity.status === 'modified' && !opts.allowModified) {
    throw new Error(
      `This pack does not match the integrity value it shipped.\n`
      + `  shipped:  ${preview.integrity.shipped}\n`
      + `  contents: ${preview.integrity.computed}\n`
      + `It has been changed since it was built. Install it only if you know why it differs.`,
    )
  }
  const secretIssues = preview.security.issues.filter(i => i.type === 'secret')
  if (secretIssues.length > 0) {
    const details = secretIssues.map(i => `  ${i.engram_id}: ${i.detail}`).join('\n')
    throw new Error(`Pack contains secrets — install blocked:\n${details}`)
  }
  // Prompt-injection text is blocked unless explicitly overridden (finding #2).
  const injectionIssues = preview.security.issues.filter(i => i.type === 'prompt_injection')
  if (injectionIssues.length > 0 && !opts.allowInjection) {
    const details = injectionIssues.map(i => `  ${i.engram_id}: ${i.detail}`).join('\n')
    throw new Error(
      `Pack contains prompt-injection / instruction-override text — install blocked:\n${details}\n` +
      `Re-run with allowInjection if this is intentional (e.g. a security-knowledge pack).`,
    )
  }

  // Destination name is the source basename, EXCEPT for a flat URL archive
  // (#813, audit finding 12). Those extract to a directory literally called
  // `extracted`, so every flat archive installed to `packs/extracted` and
  // silently overwrote the previous one. Only that generic name is overridden,
  // and only with a manifest name safe to use as a directory — every other
  // pack keeps the basename it has always had.
  const rawName = path.basename(source)
  const manifestName = preview.manifest.name?.trim()
  const sourceName = rawName === FLAT_ARCHIVE_DIRNAME && manifestName && /^[A-Za-z0-9._-]+$/.test(manifestName)
    ? manifestName
    : rawName
  const destDir = resolveInside(packsDir, sourceName, 'install')

  // STAGE the whole install, then swap it in (#813, audit finding 12).
  //
  // Copying file-by-file into the live destination meant a copy error, a crash,
  // or a concurrent install left a HYBRID of the old and new pack — half of one
  // version's engrams beside half of another's, with an integrity hash matching
  // neither. Everything below builds the pack in a staging directory; the live
  // directory is not touched until the content is complete and sanitized.
  const staging = `${destDir}.installing-${process.pid}-${Date.now()}`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })

  const files = fs.readdirSync(source)
  for (const file of files) {
    const srcPath = path.join(source, file)
    const destPath = path.join(staging, file)
    if (fs.statSync(srcPath).isFile()) {
      fs.copyFileSync(srcPath, destPath)
    }
  }

  // Auto-upgrade a deprecated manifest.yaml pack to SKILL.md in the installed
  // copy (#325). manifest.yaml still LOADS (loadPack reads it with a deprecation
  // warning), but the managed copy is normalized to the canonical SKILL.md so
  // the integrity hash below is computed over SKILL.md + engrams.yaml. Done
  // before computePackHash so the recorded integrity reflects the upgrade.
  const destSkillMd = path.join(staging, 'SKILL.md')
  const destManifestYaml = path.join(staging, 'manifest.yaml')
  if (!fs.existsSync(destSkillMd) && fs.existsSync(destManifestYaml)) {
    fs.writeFileSync(destSkillMd, manifestToSkillMd(preview.manifest))
    fs.rmSync(destManifestYaml)
    logger.warning(
      `installPack: pack '${preview.manifest.name}' shipped a deprecated manifest.yaml — upgraded to SKILL.md in the installed copy`,
    )
  }

  // Load engrams, then clamp host-overriding fields (pinned / locked commitment)
  // before they can reach injection. Re-save the sanitized copy so the on-disk
  // pack AND the integrity hash reflect the clamped content.
  const engramsPath = path.join(staging, 'engrams.yaml')
  let newEngrams = fs.existsSync(engramsPath) ? loadEngrams(engramsPath) : []
  const sanitized = sanitizePackEngrams(newEngrams)
  if (sanitized.changed) {
    newEngrams = sanitized.engrams
    saveEngrams(engramsPath, newEngrams)
    if (sanitized.pinnedStripped > 0) {
      logger.warning(`installPack: stripped 'pinned' from ${sanitized.pinnedStripped} engram(s) in pack '${preview.manifest.name}'`)
    }
  }

  // Detect conflicts with existing engrams
  const conflicts = existingEngrams ? detectConflicts(newEngrams, existingEngrams) : []

  // Compute integrity over the STAGED, sanitized content — the bytes that are
  // about to become the pack. Hashing the live directory before the swap would
  // record the hash of the previous install.
  const integrity = `sha256:${computePackHash(staging)}`

  // Make the staged content durable BEFORE it becomes the live pack (audit
  // 2026-08-03, finding 11). Every file was copied with plain writes and the
  // staging directory was never fsynced, while the registry entry written
  // afterwards IS durable — so a power loss could leave a durable registry
  // pointing at a pack that is missing, truncated or half-copied, with the
  // previous version already deleted. Atomic-to-readers is not the same
  // property as crash-durable, and the registry's durability made the gap worse
  // rather than better.
  fsyncTree(staging)

  // Swap the staged pack in. Two renames, each atomic: the live directory is
  // moved aside and the staged one takes its place, so a reader never sees a
  // partially-copied pack. If the second rename fails, the previous install is
  // put back rather than leaving nothing there.
  const displaced = `${destDir}.replacing-${process.pid}-${Date.now()}`
  let movedAside = false
  try {
    if (fs.existsSync(destDir)) {
      fs.renameSync(destDir, displaced)
      movedAside = true
    }
    fs.renameSync(staging, destDir)
  } catch (err) {
    if (movedAside && !fs.existsSync(destDir)) {
      try { fs.renameSync(displaced, destDir) } catch { /* best-effort restore */ }
    }
    fs.rmSync(staging, { recursive: true, force: true })
    throw err
  }
  // The renames themselves are metadata operations on the PARENT directory;
  // without this the swap can be lost even though the contents were flushed.
  try { fsyncDir(path.dirname(destDir)) } catch { /* best-effort, as elsewhere */ }
  fs.rmSync(displaced, { recursive: true, force: true })

  const registryEntry: RegistryEntry = {
    name: preview.manifest.name,
    installed_at: new Date().toISOString(),
    source: path.resolve(source),
    integrity,
    version: preview.manifest.version,
    creator: preview.manifest.creator,
  }
  addToRegistry(packsDir, registryEntry)

  return {
    installed: newEngrams.length,
    name: sourceName,
    conflicts,
    security: preview.security,
    registry: registryEntry,
    integrity_check: preview.integrity,
  }
}

/**
 * Install a pack from a local directory path or an http/https URL.
 *
 * When `source` is a URL, the archive is downloaded to a temp directory,
 * extracted, passed through the existing security scan and install pipeline,
 * then the temp directory is removed. The registry records the original URL
 * as the source so it is visible in `plur packs list`.
 */
export async function installPack(
  packsDir: string,
  source: string,
  existingEngrams?: Engram[],
  opts: InstallOptions = {},
): Promise<InstallResult> {
  if (isPackUrl(source)) {
    const { packDir, tmpRoot } = await downloadAndExtractPack(source)
    try {
      const result = _installPackDir(packsDir, packDir, existingEngrams, opts)
      // Overwrite the registry source with the original URL so `plur packs list`
      // shows where the pack came from, not an ephemeral /tmp path.
      result.registry.source = source
      setRegistrySource(packsDir, result.registry.name, source)
      return result
    } finally {
      cleanupDownloadedPack(tmpRoot)
    }
  }
  return _installPackDir(packsDir, source, existingEngrams, opts)
}

/**
 * Resolve `name` as a direct child of `packsDir`, or throw.
 *
 * A pack name is a caller-supplied string that reaches here from `plur packs
 * uninstall <name>` and from the `plur_packs_uninstall` MCP tool. It used to be
 * joined straight onto `packsDir`, which made `..` resolve to the PLUR ROOT —
 * and `uninstallPack` ends in `fs.rmSync(packDir, { recursive: true })`.
 *
 * Demonstrated before this guard: `uninstallPack(packsDir, '..')` deleted
 * engrams.yaml, config.yaml and the whole root, and returned `{removed: true}`.
 * `../..` reached the parent. The install path had the mirror flaw, since a
 * source ending in `/..` has basename `..`, so pack files were copied over a
 * live engrams.yaml before any write guard could see them (#811).
 *
 * Containment is checked on the RESOLVED path rather than by pattern-matching
 * the name: `a/../..`, an absolute path, and a name with embedded separators
 * all normalise away, and a denylist of shapes would have to enumerate them.
 * Resolution answers the only question that matters — does this end up inside
 * the packs directory.
 */
function resolveInside(packsDir: string, name: string, op: string): string {
  const base = path.resolve(packsDir)
  const candidate = path.resolve(base, name)
  const contained = candidate !== base && candidate.startsWith(base + path.sep)
  if (!contained || name.includes('/') || name.includes('\\')) {
    throw new Error(
      `[plur] refusing to ${op} pack "${name}": a pack name must be a single directory ` +
      `inside ${packsDir}, and this one resolves to ${candidate}.\n` +
      `Names containing path separators or ".." are rejected — they would let this operation ` +
      `read or delete outside the packs directory.`,
    )
  }
  return candidate
}

// --- Uninstall ---

export interface UninstallResult {
  name: string
  /**
   * Always `true` — the literal type is the point (#545).
   *
   * `boolean` implied `false` was reachable, and a caller wrote the branch it
   * implies: `plur-mcp packs uninstall` had an `else` that printed "Pack not
   * found" and exited 1, which could never run. `uninstallPack` THROWS when the
   * pack is absent, so a returned result is already proof of removal.
   *
   * Kept as a field rather than deleted so existing readers keep compiling, but
   * narrowed so a `removed === false` branch is now a type error instead of
   * dead code that reads like handled behaviour.
   */
  removed: true
  engram_count: number
}

export function uninstallPack(packsDir: string, name: string): UninstallResult {
  // Find the pack — try exact name, then case-insensitive
  let packDir = resolveInside(packsDir, name, 'uninstall')
  if (!fs.existsSync(packDir)) {
    // Try case-insensitive scan
    const entries = fs.existsSync(packsDir) ? fs.readdirSync(packsDir) : []
    const match = entries.find(e => e.toLowerCase() === name.toLowerCase())
    if (match) {
      packDir = path.join(packsDir, match)
    } else {
      throw new Error(`Pack not found: ${name}. Use 'plur packs list' to see installed packs.`)
    }
  }

  // Count engrams and get manifest name before removal
  const engramsPath = path.join(packDir, 'engrams.yaml')
  let count = 0
  // Legitimately best-effort: this number is only for the removal report, and a
  // pack whose engrams.yaml is unreadable is still removable. `loadEngrams` now
  // THROWS on an unreadable file rather than returning [] — deliberately, because
  // the write path treats [] as "empty" and would then destroy the store — so
  // this catch is the explicit opt-in to "unknown, and that is fine here".
  try { count = loadEngrams(engramsPath).length } catch { count = 0 }
  let manifestName: string | undefined
  try { manifestName = loadPack(packDir).manifest.name } catch {}

  // Remove from registry (try both directory name and manifest name)
  removeFromRegistry(packsDir, name)
  if (manifestName && manifestName !== name) removeFromRegistry(packsDir, manifestName)

  // Remove recursively
  fs.rmSync(packDir, { recursive: true, force: true })

  return { name, removed: true, engram_count: count }
}

// --- List ---

export interface PackInfo {
  name: string
  path: string
  engram_count: number
  manifest?: PackManifest
  integrity?: string
  installed_at?: string
  source?: string
  integrity_ok?: boolean
  /**
   * Explicit integrity verdict (#805, F11) — the reason `integrity_ok` alone is
   * not enough to act on.
   *
   *   'ok'          the pack hashes to what the registry recorded at install
   *   'modified'    it does not — the contents changed after install
   *   'unverified'  there is NO registry entry, so the question cannot be answered
   *
   * `integrity_ok === undefined` carried the third case, and every consumer
   * treated it as "nothing to report" — the CLI printed a warning only for an
   * explicit `false`. So a pack whose baseline had been destroyed looked exactly
   * like a pack that was fine. A verdict that cannot be reached must be as
   * visible as a verdict that failed, because the two have the same cause more
   * often than not: something tampered with the pack directory.
   */
  integrity_status?: 'ok' | 'modified' | 'unverified'
  /**
   * Why this pack could not be read, when it could not (audit 2026-08-03,
   * finding 13). A damaged pack is listed with what is known about it rather
   * than aborting the listing or appearing as a healthy pack with 0 engrams.
   */
  load_error?: string
}

export function listPacks(packsDir: string): PackInfo[] {
  if (!fs.existsSync(packsDir)) return []

  const registry = loadRegistry(packsDir)
  const registryMap = new Map(registry.map(r => [r.name, r]))

  const result: PackInfo[] = []
  for (const entry of fs.readdirSync(packsDir)) {
    const packDir = path.join(packsDir, entry)
    if (!fs.statSync(packDir).isDirectory()) continue

    try {
      const pack = loadPack(packDir)
      const currentIntegrity = `sha256:${computePackHash(packDir)}`
      const reg = registryMap.get(pack.manifest.name)
      result.push({
        name: pack.manifest.name,
        path: packDir,
        engram_count: pack.engrams.length,
        manifest: pack.manifest,
        integrity: currentIntegrity,
        installed_at: reg?.installed_at,
        source: reg?.source,
        integrity_ok: reg ? reg.integrity === currentIntegrity : undefined,
        integrity_status: reg ? (reg.integrity === currentIntegrity ? 'ok' : 'modified') : 'unverified',
      })
    } catch (manifestErr) {
      // Per-pack fallback: the manifest would not load, so report what can
      // still be established rather than dropping the pack from the listing.
      //
      // `loadEngrams` THROWS on an unreadable corpus by design, and this call
      // used to sit outside any try — so one pack with a corrupt engrams.yaml
      // aborted the ENTIRE listing (audit 2026-08-03, finding 13). A fallback
      // that is itself capable of throwing is not a fallback; the whole point
      // of this branch is that this pack is already known to be damaged.
      const engramsPath = path.join(packDir, 'engrams.yaml')
      let count = 0
      let loadError = (manifestErr as Error).message
      try {
        if (fs.existsSync(engramsPath)) count = loadEngrams(engramsPath).length
      } catch (corpusErr) {
        loadError = (corpusErr as Error).message
      }
      const reg = registryMap.get(entry)
      result.push({
        name: entry,
        path: packDir,
        engram_count: count,
        installed_at: reg?.installed_at,
        source: reg?.source,
        // No manifest loaded means no hash was computed, so the integrity
        // question cannot be answered — a state to report, not to omit (#805).
        integrity_status: 'unverified',
        load_error: loadError,
      })
    }
  }
  return result
}

// --- Export ---

export interface ExportOptions {
  /**
   * Write provenance records alongside the pack (#972). **On by default.**
   *
   * A pack is how engrams leave one machine and reach another, so this is the
   * trust boundary — the one place a provenance record defends against anyone.
   * It follows the practice every software supply chain settled on: a bill of
   * materials is produced as part of the build and travels inside the artifact,
   * rather than being something a publisher remembers to ask for.
   *
   * This deliberately does NOT follow the `provenance.generate` config setting,
   * which governs per-engram records inside your own store and defaults to
   * `never`. Those are two different questions. Pass `false` to opt out.
   */
  provenance?: boolean
  name: string
  version: string
  description?: string
  creator?: string
  domain?: string
  scope?: string
  tags?: string[]
  type?: string
}

export interface PrivacyScanResult {
  clean: boolean
  issues: PrivacyIssue[]
}

export interface PrivacyIssue {
  engram_id: string
  type: 'secret' | 'private_visibility' | 'personal_path' | 'email' | 'ip_address' | 'prompt_injection'
  detail: string
}

/**
 * Strip fields that let a third-party pack engram override the host's behavior:
 * `pinned` (bypasses the relevance gate — always injected) and a `locked`
 * commitment (resists dedup/correction). Returns sanitized engrams plus a count
 * of how many were pinned. (Security audit 2026-06-10, finding #2.)
 */
export function sanitizePackEngrams(engrams: Engram[]): { engrams: Engram[]; pinnedStripped: number; changed: boolean } {
  let pinnedStripped = 0
  let changed = false
  const out = engrams.map(e => {
    const c = { ...e } as Record<string, unknown>
    if (c.pinned === true) { pinnedStripped++; changed = true }
    if ('pinned' in c) delete c.pinned
    if (c.commitment === 'locked') {
      c.commitment = 'decided'
      delete c.locked_at
      delete c.locked_reason
      changed = true
    }
    return c as unknown as Engram
  })
  return { engrams: out, pinnedStripped, changed }
}

const PERSONAL_PATH_RE = /(?:\/Users\/\w+|\/home\/\w+|~\/|C:\\Users\\\w+)/
// Bounded quantifiers ({1,64}/{1,255}/{2,24}, within RFC limits) so the domain
// part can't backtrack catastrophically. Unbounded `+` made this quadratic on a
// long dotted run after `@` (#389 review: 8-17s on a crafted engram); the cap in
// scanPrivacy bounds the input length and these bounds bound the per-start work.
const EMAIL_RE = /[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,255}\.[a-zA-Z]{2,24}/
const IP_RE = /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/

// Fields excluded from the serialized secret/PII scan: exportPack strips these
// (relations/associations/knowledge_anchors never reach a pack), or they are
// internal/numeric bookkeeping that can't carry a meaningful credential and
// would only cause false rejections (local paths inside knowledge_anchors, the
// activation numbers, the id). EVERY other field — including future additions —
// is scanned, so the export gap can't silently reopen the way an enumerated
// field list does (#381 root cause, #389 review).
const SECRET_SCAN_EXCLUDE = new Set<string>([
  'relations', 'associations', 'knowledge_anchors', 'activation',
  'embedding', 'id', 'created', 'updated', 'last_accessed',
])

/**
 * Serialize the secret/PII-bearing content of an engram for scanning. Scans the
 * SERIALIZED payload (not a hand-maintained field list) so a future caller-
 * settable field (tags, structured_data, contraindications, …) can't silently
 * reopen the export leak. PLUR-internal `_`-prefixed structured_data keys
 * (_outbox/_demoted) are dropped — they carry system host topology, never user
 * content, and would false-trip the scan.
 */
function serializeForSecretScan(e: Engram): string {
  const scan: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(e as Record<string, unknown>)) {
    if (SECRET_SCAN_EXCLUDE.has(k)) continue
    if (k === 'structured_data' && v && typeof v === 'object' && !Array.isArray(v)) {
      const userSd: Record<string, unknown> = {}
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        if (!sk.startsWith('_')) userSd[sk] = sv
      }
      scan[k] = userSd
    } else {
      scan[k] = v
    }
  }
  return JSON.stringify(scan)
}

export function scanPrivacy(engrams: Engram[]): PrivacyScanResult {
  const issues: PrivacyIssue[] = []

  for (const e of engrams) {
    // Check visibility — private engrams should never be exported. Record the
    // flag but DON'T skip the rest of the scan: on install, private engrams are
    // still loaded and injected, so a pack can't use visibility:private to
    // smuggle secrets or injection text past the gate (finding #2).
    if (e.visibility === 'private') {
      issues.push({
        engram_id: e.id,
        type: 'private_visibility',
        detail: `Engram marked as private — excluded from export, still scanned`,
      })
    }

    // SECRET / PII scan covers the SERIALIZED engram payload — every caller-
    // settable, exported field — not a hand-picked list. exportPack serializes
    // the whole engram, so enumerating a subset here is the same enumerate-vs-
    // serialize drift that caused #381, one level out (#389 review): `tags`,
    // `structured_data`, `contraindications` are all exported verbatim. Scanning
    // the serialized payload means a future field can't silently reopen the gap.
    // Cap the scan input BEFORE any regex touches it. serializeForSecretScan
    // returns the whole-engram JSON (unbounded — a long statement or
    // structured_data value), and EMAIL_RE / IP_RE / PERSONAL_PATH_RE below run
    // on secretText directly. Uncapped, EMAIL_RE backtracks quadratically on a
    // crafted pack (#389 review measured 8-17s), hanging preview/install/export.
    // detectSensitive re-applies the same cap internally; this also bounds the
    // privacy regexes that don't go through it.
    const fullText = serializeForSecretScan(e)
    const secretText = truncateToScanLimit(fullText)

    // Secret AND infrastructure-sensitive patterns. detectSensitive is a superset
    // of detectSecrets that also catches public IPv4/IPv6, internal hosts,
    // basic-auth URLs and host:port — the infra family detectSecrets missed and
    // the exact class of the 2026-06 leak. Without it, an infra leak in
    // summary/tags/source was exported clean.
    //
    // #425: pass the FULL serialized text, NOT the pre-truncated `secretText`.
    // detectSensitive caps its own regex work internally (ReDoS-safe) AND emits
    // the #386 `scan_truncated` fail-closed hit when the input exceeds 1 MiB.
    // Pre-truncating here hid the over-cap from it, so a >1 MiB engram with
    // sensitive content past byte 1 MiB exported/installed CLEAN. The raw PII
    // regexes below still run on the bounded `secretText`.
    const secrets = detectSensitive(fullText)
    for (const s of secrets) {
      issues.push({
        engram_id: e.id,
        type: 'secret',
        detail: `${s.pattern}: ${s.match}`,
      })
    }

    // Prompt-injection / instruction-override is FIELD-based: only fields
    // rendered into agent context can carry an effective injection — statement +
    // rationale + source (formatLayer3), summary (formatLayer1), domain
    // (formatLayer3). Scanning arbitrary serialized metadata for injection would
    // add false positives without a real attack surface.
    const injectionText = truncateToScanLimit(
      [e.statement, e.rationale, e.source, e.summary, e.domain].filter(Boolean).join(' '),
    )
    const injections = detectPromptInjection(injectionText)
    for (const inj of injections) {
      issues.push({
        engram_id: e.id,
        type: 'prompt_injection',
        detail: `${inj.pattern}: "${inj.match}"`,
      })
    }

    // Personal paths
    if (PERSONAL_PATH_RE.test(secretText)) {
      issues.push({
        engram_id: e.id,
        type: 'personal_path',
        detail: `Contains personal path: ${secretText.match(PERSONAL_PATH_RE)?.[0]}`,
      })
    }

    // Email addresses
    const emailMatch = secretText.match(EMAIL_RE)
    if (emailMatch) {
      issues.push({
        engram_id: e.id,
        type: 'email',
        detail: `Contains email: ${emailMatch[0]}`,
      })
    }

    // Private IP addresses
    const ipMatch = secretText.match(IP_RE)
    if (ipMatch) {
      issues.push({
        engram_id: e.id,
        type: 'ip_address',
        detail: `Contains private IP: ${ipMatch[0]}`,
      })
    }
  }

  return { clean: issues.length === 0, issues }
}

function deriveMatchTerms(engrams: Engram[]): string[] {
  // Collect all tags and domains, deduplicate, return top terms
  const termCounts = new Map<string, number>()

  for (const e of engrams) {
    // Tags
    if (e.tags) {
      for (const t of e.tags) {
        termCounts.set(t, (termCounts.get(t) || 0) + 1)
      }
    }
    // Domain parts
    if (e.domain) {
      for (const part of e.domain.split('.')) {
        if (part.length > 2) {
          termCounts.set(part, (termCounts.get(part) || 0) + 1)
        }
      }
    }
    // Type
    if (e.type) {
      termCounts.set(e.type, (termCounts.get(e.type) || 0) + 1)
    }
  }

  // Return terms that appear in 2+ engrams, sorted by frequency
  return [...termCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([term]) => term)
}

export interface ExportResult {
  /** Provenance files written, relative to the pack directory. Empty when off. */
  provenance_files?: string[]
  path: string
  engram_count: number
  privacy: PrivacyScanResult
  match_terms: string[]
  integrity: string
}

/**
 * Reject a pack name that would escape the directory it is meant to go in.
 *
 * The name becomes a directory under the output path, so `../escape` walks out
 * of it. A tester ran `plur packs export "../plur-escape-test"` and wrote a
 * full pack straight into their home directory.
 *
 * The name also becomes part of the identifiers inside the provenance record
 * (`engram:pack/<name>@<version>`), where a slash or a space is not legal.
 *
 * Rejecting is right rather than quietly rewriting: a pack that lands somewhere
 * other than where its name said is worse than one that refuses to be built.
 */
function assertSafePackName(name: string): void {
  if (!name || !name.trim()) {
    throw new Error('A pack needs a name.')
  }
  if (name !== name.trim()) {
    throw new Error(`Pack name "${name}" starts or ends with a space.`)
  }
  if (/[/\\]/.test(name) || name === '.' || name === '..' || name.startsWith('.')) {
    throw new Error(
      `Pack name "${name}" is not usable as a directory name. `
      + 'It must not contain "/" or "\\", and must not start with ".". '
      + 'The name becomes a folder under the output directory, so a name like '
      + '"../thing" would write outside it.',
    )
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) {
    throw new Error(`Pack name "${name}" contains control characters.`)
  }
}

export function exportPack(
  engrams: Engram[],
  outputDir: string,
  manifest: ExportOptions,
): ExportResult {
  assertSafePackName(manifest.name)

  // Privacy scan — filter out problematic engrams
  const allPrivacy = scanPrivacy(engrams)

  // A pack is a SHARED artifact, so exclude EVERY engram scanPrivacy flagged —
  // not only secrets and private-tagged ones, but also PII (personal paths,
  // emails, private IPs) and prompt-injection (#398). scanPrivacy only flags
  // content that has no place in a shared pack, so ANY issue is disqualifying.
  // The full scan is still returned in `privacy`, so the caller sees exactly
  // which engrams were held back and why.
  const blockedIds = new Set(allPrivacy.issues.map(i => i.engram_id))
  const safeEngrams = engrams.filter(e => !blockedIds.has(e.id))

  // Derive match_terms from engram tags and domains
  const matchTerms = deriveMatchTerms(safeEngrams)

  // Create output directory
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })

  // Write manifest as SKILL.md frontmatter
  const frontmatter = yaml.dump({
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    creator: manifest.creator,
    metadata: {
      injection_policy: 'on_match',
      match_terms: matchTerms,
      engram_count: safeEngrams.length,
    },
  })
  fs.writeFileSync(
    path.join(outputDir, 'SKILL.md'),
    `---\n${frontmatter}---\n\n# ${manifest.name}\n\n${manifest.description || ''}\n`
  )

  // Strip internal references that are meaningless outside the original store
  const exportEngrams = safeEngrams.map(e => {
    const cleaned = { ...e }
    // Strip conflict references (internal cross-refs to other engrams)
    if (cleaned.relations) {
      cleaned.relations = {
        ...cleaned.relations,
        conflicts: [],
        related: [],
        // #240: supersedes edges are store-internal cross-refs too — a stale
        // edge in a foreign store could falsely suppress tension detection
        // between unrelated engrams on ID collision.
        supersedes: [],
        superseded_by: [],
      }
    }
    // Strip associations (co-access edges are store-specific)
    if (cleaned.associations) {
      cleaned.associations = []
    }
    // Strip knowledge_anchors (local file paths)
    if (cleaned.knowledge_anchors) {
      cleaned.knowledge_anchors = []
    }
    // Reset activation to fresh state (recipient builds their own usage)
    if (cleaned.activation) {
      cleaned.activation = {
        ...cleaned.activation,
        frequency: 0,
        retrieval_strength: 0.7,
      }
    }
    // Strip feedback_signals (recipient starts fresh)
    if (cleaned.feedback_signals) {
      cleaned.feedback_signals = { positive: 0, negative: 0, neutral: 0 }
    }
    // Strip host-overriding fields (finding #6): never export an always-load
    // directive or a locked commitment into a shareable pack. Mirrors the
    // clamp applied on install.
    const c = cleaned as Record<string, unknown>
    if ('pinned' in c) delete c.pinned
    if (c.commitment === 'locked') {
      c.commitment = 'decided'
      delete c.locked_at
      delete c.locked_reason
    }
    return cleaned
  })

  // Write engrams
  const content = yaml.dump({ engrams: exportEngrams }, { lineWidth: 120, noRefs: true, quotingType: '"' })
  fs.writeFileSync(path.join(outputDir, 'engrams.yaml'), content)

  // Compute and write integrity hash
  const integrity = computePackHash(outputDir)
  fs.writeFileSync(path.join(outputDir, 'INTEGRITY'), `sha256:${integrity}\n`)

  // Provenance (#972), written after the integrity hash so the pack record can
  // carry it.
  //
  // The hash covers SKILL.md and engrams.yaml only, per the standard, so these
  // files are NOT covered by it. The dependency therefore runs the other way:
  // the record commits to the pack. Change the pack and the hash inside the
  // record stops matching.
  //
  // Only engrams that survived the privacy scan appear. Provenance must never
  // become a way to ship something the content path already refused.
  const provenanceFiles: string[] = []
  if (manifest.provenance !== false) {
    const provDir = path.join(outputDir, 'provenance')
    fs.mkdirSync(provDir, { recursive: true })

    const packRecord = buildPackProvenanceRecord(
      {
        name: manifest.name,
        version: manifest.version,
        creator: manifest.creator,
        integrity: `sha256:${integrity}`,
      },
      safeEngrams,
    )
    fs.writeFileSync(path.join(provDir, 'pack.jsonld'), serializeProvenanceRecord(packRecord))
    provenanceFiles.push(path.join('provenance', 'pack.jsonld'))

    for (const engram of safeEngrams) {
      // Portable by default: a record that stands on its own, names no other
      // engram, and carries no session identifier.
      const record = buildProvenanceRecord(engram, [], { mode: 'portable' })
      const file = path.join('provenance', `${engram.id}.jsonld`)
      fs.writeFileSync(path.join(outputDir, file), serializeProvenanceRecord(record))
      provenanceFiles.push(file)
    }
  }

  return {
    path: outputDir,
    engram_count: safeEngrams.length,
    privacy: allPrivacy,
    match_terms: matchTerms,
    integrity: `sha256:${integrity}`,
    ...(manifest.provenance !== false ? { provenance_files: provenanceFiles } : {}),
  }
}

// --- Integrity ---

/** What a pack's shipped integrity value says, checked against its contents. */
export interface IntegrityCheck {
  /** 'ok' — matched. 'modified' — did not match. 'absent' — the pack shipped none. */
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
 * Export writes the hash into an `INTEGRITY` file. Install recomputed its own
 * hash, recorded that, and never once looked at the shipped value — so a pack
 * edited after it was built installed cleanly, and `plur packs list` then
 * reported `integrity_ok: true`. `integrity_ok` meant "we computed a hash", not
 * "the hash matched", which is the opposite of what anybody reads it as.
 *
 * Hash the pack AS RECEIVED. Install later hashes the staged, sanitised copy,
 * which legitimately differs when the privacy scan drops an engram; comparing
 * against that would raise a mismatch on packs nobody touched.
 *
 * A pack that ships no `INTEGRITY` is 'absent', not 'ok'. Nothing was checked,
 * and saying otherwise is how the original defect read.
 *
 * This detects accidental corruption and casual editing. It is NOT a defence
 * against a determined sender, who edits the contents and the `INTEGRITY` file
 * together — nothing here is signed. Say that plainly wherever this is shown.
 */
export function verifyPackIntegrity(packDir: string): IntegrityCheck {
  const computed = `sha256:${computePackHash(packDir)}`
  const file = path.join(packDir, 'INTEGRITY')

  if (!fs.existsSync(file)) {
    return {
      status: 'absent',
      computed,
      note: 'This pack shipped no integrity value, so there was nothing to check it against.',
    }
  }

  const shipped = fs.readFileSync(file, 'utf8').trim()
  if (shipped === computed) {
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
 * Compute SHA256 hash of pack contents per ENGRAM-STANDARD-v1.md §5.5:
 *   H = SHA256( bytes(SKILL.md) || bytes(engrams.yaml) )
 * Deterministic — same content always produces same hash; usable as a
 * content-addressable identifier (like a Swarm hash).
 *
 * SKILL.md is the canonical pack manifest. `manifest.yaml` is deprecated (#325)
 * and does NOT contribute to the hash; installPack auto-upgrades a manifest.yaml
 * pack to SKILL.md before this is computed over the installed copy, so the
 * integrity hash always reflects SKILL.md + engrams.yaml.
 */
export function computePackHash(packDir: string): string {
  const hash = crypto.createHash('sha256')

  // Hash the SKILL.md manifest. No manifest.yaml fallback.
  const skillMd = path.join(packDir, 'SKILL.md')
  if (fs.existsSync(skillMd)) {
    hash.update(fs.readFileSync(skillMd))
  }

  // Hash engrams
  const engramsPath = path.join(packDir, 'engrams.yaml')
  if (fs.existsSync(engramsPath)) {
    hash.update(fs.readFileSync(engramsPath))
  }

  return hash.digest('hex')
}
