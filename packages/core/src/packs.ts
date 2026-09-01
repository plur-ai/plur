import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import * as os from 'os'
import { execFileSync } from 'child_process'
import yaml from 'js-yaml'
import { loadPack, loadEngrams, saveEngrams } from './engrams.js'
import { atomicWrite, fsyncDir, withLock } from './sync.js'
import { detectSensitive, detectPromptInjection, truncateToScanLimit } from './secrets.js'
import { sanitizeInline } from './sanitize-inline.js'
import type { Engram } from './schemas/engram.js'
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
}

function _previewPackDir(source: string): PreviewResult {
  if (!fs.existsSync(source)) throw new Error(`Pack source not found: ${source}`)

  const pack = loadPack(source)
  const security = scanPrivacy(pack.engrams)

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

  return { installed: newEngrams.length, name: sourceName, conflicts, security: preview.security, registry: registryEntry }
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
 * Fields a pack engram may carry that are rendered verbatim into agent context.
 *
 * Enumerated from the renderer (formatLayer1/2/3 in inject.ts), not guessed. A
 * field added to the renderer without being added here is the same
 * enumerate-vs-serialize drift that produced #381 and #389, one layer out.
 *
 * This list is defence in depth, so drift here is not a hole: the RENDER
 * boundary folds every field unconditionally and is what actually holds the
 * invariant. The drift guard that would catch a new rendered field is
 * `injection-render-boundary.test.ts` describe R5, which poisons every string
 * leaf generically rather than enumerating — so it fails on a field nobody
 * remembered to add, here or there.
 */
const PACK_RENDERED_TEXT_FIELDS = ['statement', 'rationale', 'summary', 'domain'] as const

/**
 * Strip or neutralise everything a third-party pack engram can use to override
 * the host's behavior.
 *
 * Two distinct classes:
 *
 *  - HOST OVERRIDE: `pinned` (bypasses the relevance gate — always injected)
 *    and a `locked` commitment (resists dedup/correction).
 *    (Security audit 2026-06-10, finding #2.)
 *
 *  - STRUCTURAL FORGERY: a line terminator in any rendered field. The renderer
 *    joins engrams with a newline and the consumers paste the block into a
 *    prompt, so a newline inside pack text mints a second engram at
 *    system-prompt authority (#940, #1004). The render boundary collapses these
 *    too — that is the guarantee, and it covers packs installed before this
 *    existed — but a pack is the one input we KNOW is third-party, and letting
 *    it write forged structure into the store means every non-rendering reader
 *    (export, `plur list`, the viewer, a downstream re-pack) sees it. Neutralise
 *    at the boundary as well as at the render.
 *
 * @param engrams - engrams as loaded from the pack.
 * @returns sanitized engrams, how many were pinned, and whether anything changed.
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
    for (const field of PACK_RENDERED_TEXT_FIELDS) {
      const value = c[field]
      if (typeof value !== 'string') continue
      const folded = sanitizeInline(value)
      if (folded !== value) { c[field] = folded; changed = true }
    }
    // `temporal.valid_until` reaches the EXPIRED marker, which interpolates it
    // into the same line as the statement — a second forgery vector, and one
    // the schema does not constrain (it is a bare optional string, no date
    // format). Fold it for the same reason as the fields above.
    const temporal = c.temporal
    if (temporal !== null && typeof temporal === 'object') {
      const t = { ...(temporal as Record<string, unknown>) }
      let touched = false
      for (const key of ['valid_from', 'valid_until']) {
        const value = t[key]
        if (typeof value !== 'string') continue
        const folded = sanitizeInline(value)
        if (folded !== value) { t[key] = folded; touched = true }
      }
      if (touched) { c.temporal = t; changed = true }
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
  path: string
  engram_count: number
  privacy: PrivacyScanResult
  match_terms: string[]
  integrity: string
}

export function exportPack(
  engrams: Engram[],
  outputDir: string,
  manifest: ExportOptions,
): ExportResult {
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

  return {
    path: outputDir,
    engram_count: safeEngrams.length,
    privacy: allPrivacy,
    match_terms: matchTerms,
    integrity: `sha256:${integrity}`,
  }
}

// --- Integrity ---

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
