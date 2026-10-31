import * as fs from 'fs'
import yaml from 'js-yaml'
import * as path from 'path'
import { isTransientPackDir, loadEngrams, loadPack } from './engrams.js'
import { logger } from './logger.js'
import { FLAT_ARCHIVE_DIRNAME, MAX_PACK_ENTRIES, MAX_PACK_FILE_BYTES, cleanupDownloadedPack, downloadAndExtractPack, isPackUrl } from './packs/download.js'
import { INTEGRITY_V2_RE, type IntegrityCheck, computePackIntegrity, packIntegrityMatches, verifyPackIntegrity } from './packs/integrity.js'
import { type PrivacyIssue, type PrivacyScanResult, scanPrivacy } from './packs/privacy.js'
import { type RegistryEntry, addToRegistry, findRegistryRowIndex, isAmbiguousLegacyRow, isDirNow, loadRegistry, onDiskEntryName, removeFromRegistry, setRegistrySource } from './packs/registry.js'
import { fsyncTree, normalizeStagedPack } from './packs/staging.js'
import type { LicenseSource } from './provenance.js'
import { LICENSE_SOURCES } from './provenance.js'
import type { Engram } from './schemas/engram.js'
import type { PackManifest } from './schemas/pack.js'
import { detectPromptInjection, detectSecrets, detectSensitive, truncateToScanLimit } from './secrets.js'
import { fsyncDir } from './atomic-write.js'
export { FLAT_ARCHIVE_DIRNAME, MAX_PACK_ARCHIVE_BYTES, MAX_PACK_DOWNLOAD_BYTES, PACK_DOWNLOAD_TIMEOUT_MS, cleanupDownloadedPack, downloadAndExtractPack, isPackUrl } from './packs/download.js'
export { type ExportOptions, type ExportResult, exportPack } from './packs/export.js'
export { type IntegrityCheck, PACK_INTEGRITY_V2_PARTS, type PackIntegrityMigrationAction, type PackIntegrityMigrationReport, computePackHash, computePackIntegrity, computePackIntegrityLike, migratePackIntegrity, packIntegrityMatches, shortPackIntegrity, verifyPackIntegrity } from './packs/integrity.js'
export { type PrivacyIssue, type PrivacyScanResult, containsEmail, sanitizePackEngrams, scanPrivacy } from './packs/privacy.js'
export { PackRegistryUnreadableError, type RegistryEntry } from './packs/registry.js'


export { loadAllPacks } from './engrams.js'

// `isTransientPackDir` lives in engrams.ts so `loadAllPacks` can use it
// without importing this module back; re-exported here.
export { isTransientPackDir }

// --- Preview ---

export interface PreviewResult {
  manifest: PackManifest
  engram_count: number
  engrams: Array<{ id: string; type: string; statement: string; domain?: string; tags: string[] }>
  security: PrivacyScanResult
  warnings: string[]
  /** What the pack says about where its engrams came from. */
  provenance: PackProvenanceView
  /** Whether the contents match the integrity value the pack shipped. */
  integrity: IntegrityCheck
}

/**
 * What a pack claims about the origin of its contents, read BEFORE installing:
 * an indicator, then a summary, then the full document, each optional.
 * **These are claims, not proof.** Nothing in a pack is signed, so the reader is told
 * nobody has checked it — never show a reassuring tick on an unverified record.
 */
export interface PackProvenanceView {
  /** Does the pack carry provenance at all? */
  present: boolean
  /** Records found, and how many engrams they cover. */
  record_count: number
  /**
   * Record files that exist but could not be read as a provenance record:
   * malformed JSON, a document with no `@graph` array, one too large to read.
   * Counted rather than skipped: a record that promised to say where an
   * engram came from and cannot be read is a finding, not an absence.
   */
  unreadable_records: number
  /**
   * Records under `provenance/` whose file name is not the id of any engram the
   * pack ships (profile §5.4.2). A record about something the recipient is not
   * receiving is the signature of a pack assembled from a larger set, and it
   * MUST be reported rather than skipped. Counted by name, never opened: what
   * such a file says is about an engram that is not here.
   */
  orphan_records: number
  /** Engrams in the pack with no record of their own. */
  engrams_without_record: number
  /** Has any of this been cryptographically verified? Always false for now. */
  verified: boolean
  /** Why `verified` is false, in words a reader can act on. */
  verification_note: string
  /**
   * Distinct licences the pack's engrams carry, most common first. `chosen`: did anybody
   * decide this. `sources`: the four-state `engram:licenseSource` values seen (empty when
   * absent). Closed set (profile §8.4): values outside `LICENSE_SOURCES` never appear here,
   * so a stranger's free text is never surfaced as a typed fact.
   */
  licences: Array<{ name: string; count: number; chosen: boolean; sources: LicenseSource[] }>
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
 * Every entry under a pack directory, without following anything. Uses `lstat` semantics
 * (`isSymbolicLink()`): skipping a link as "not a file" would let `installPack` copy
 * THROUGH it (tar preserves symlinks). Iterative and bounded by entry count, not depth;
 * a pack past the bound is reported, never partially scanned in silence.
 */
function walkPack(packDir: string): {
  files: string[]
  symlinks: Array<{ path: string; target: string }>
  special: string[]
  truncated: boolean
} {
  const files: string[] = []
  const symlinks: Array<{ path: string; target: string }> = []
  const special: string[] = []
  let seen = 0
  let truncated = false
  const pending = [packDir]
  while (pending.length) {
    const dir = pending.pop()!
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (++seen > MAX_PACK_ENTRIES) { truncated = true; return { files, symlinks, special, truncated } }
      const full = path.join(dir, e.name)
      const rel = path.relative(packDir, full)
      if (e.isSymbolicLink()) {
        let target = '?'
        try { target = fs.readlinkSync(full) } catch { /* reported as unknown */ }
        symlinks.push({ path: rel, target })
        continue
      }
      if (e.isDirectory()) { pending.push(full); continue }
      if (!e.isFile()) { special.push(rel); continue }
      files.push(full)
    }
  }
  return { files, symlinks, special, truncated }
}

/**
 * Refuse a pack that contains a symbolic link, before anything reads it. Every pack
 * reader would follow a link (a manifest could point outside the pack), and no pack
 * legitimately ships one — so this runs first and refuses naming the link.
 */
function refuseSymlinks(packDir: string, op: string): void {
  const { symlinks } = walkPack(packDir)
  if (!symlinks.length) return
  const listed = symlinks.slice(0, 5).map(l => `  ${l.path} -> ${l.target}`).join('\n')
  const more = symlinks.length > 5 ? `\n  … and ${symlinks.length - 5} more` : ''
  throw new Error(
    `[plur] refusing to ${op} pack ${packDir}: it contains symbolic links, and a pack must ship plain files.\n`
    + `${listed}${more}\n`
    + 'A link would make the scan read one file and the install copy another, and an absolute link '
    + 'reaches outside the pack. Replace each link with the file it points at, then retry.',
  )
}

/**
 * Scan every text file the pack ships for secrets and instruction-override text.
 *
 * `SKILL.md` and other files are not inert: they are loaded and covered by the
 * integrity hash, so a recipient reasonably assumes they were checked. Issues
 * are reported against the file rather than an engram, so the message names
 * where to look. The scan input is capped exactly as the engram scan is,
 * because the same catastrophic-backtracking risk applies to a crafted file.
 */
function scanPackFiles(packDir: string): PrivacyIssue[] {
  const issues: PrivacyIssue[] = []

  // EVERY text file the pack ships, not a chosen few: a README.md holding a
  // credential or instruction-override text would otherwise be copied into the
  // store unread. A pack is an archive from a stranger, and the recipient's
  // assistant may read any of it.
  //
  // engrams.yaml is skipped here because scanPrivacy already reads it as
  // structured data, which catches more than scanning its raw text would.
  const walked = walkPack(packDir)
  // Anything the scan could not read is REPORTED, never silently skipped. A
  // skipped file is a place to hide things; a flagged one blocks the install
  // until somebody looks. `refuseSymlinks` normally runs first, so links only
  // reach here when this is called on its own.
  for (const link of walked.symlinks) {
    issues.push({ engram_id: link.path, type: 'unscannable', unscannable_reason: 'symlink', detail: `${link.path} is a symbolic link to ${link.target} — not scanned, not installable` })
  }
  for (const rel of walked.special) {
    issues.push({ engram_id: rel, type: 'unscannable', unscannable_reason: 'special', detail: `${rel} is not a regular file — not scanned, not installable` })
  }
  if (walked.truncated) {
    issues.push({
      engram_id: '(pack)', type: 'unscannable', unscannable_reason: 'entry_limit',
      detail: `the pack has more than ${MAX_PACK_ENTRIES} entries — the scan stopped, so the rest was not checked`,
    })
  }

  for (const file of walked.files.sort()) {
    const label = path.relative(packDir, file)
    if (label === 'engrams.yaml') continue
    let text: string
    try {
      const stat = fs.lstatSync(file)
      if (stat.size > MAX_PACK_FILE_BYTES) {
        issues.push({ engram_id: label, type: 'unscannable', unscannable_reason: 'oversize', detail: `${label} is ${stat.size} bytes, more than the ${MAX_PACK_FILE_BYTES}-byte scan limit — not scanned` })
        continue
      }
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      issues.push({ engram_id: label, type: 'unscannable', unscannable_reason: 'read_error', detail: `${label} could not be read: ${(err as Error).message}` })
      continue
    }
    // Binary-ish content: the infra heuristics (dotted numbers, host-like
    // runs) produce noise on it, not findings. The credential and the
    // instruction-override detectors are precise enough to run anyway, so a
    // text file with one NUL byte in front of it cannot carry either past
    // the scan into the store.
    if (text.includes('\u0000')) {
      const stripped = truncateToScanLimit(text.replace(/\u0000/g, ''))
      for (const hit of detectSecrets(stripped)) {
        issues.push({ engram_id: label, type: 'secret', detail: `in ${label} — ${hit.pattern}: ${hit.match}` })
      }
      for (const hit of detectPromptInjection(stripped)) {
        issues.push({ engram_id: label, type: 'prompt_injection', detail: `in ${label} — ${hit.pattern}: ${hit.match}` })
      }
      continue
    }

    // The FULL text goes to detectSensitive: it caps its own regex work and
    // emits the fail-closed `scan_truncated` hit past 1 MiB, so a credential
    // beyond the cap blocks rather than passing unseen. The injection detector
    // has no cap of its own, so it gets the capped copy.
    for (const hit of detectSensitive(text)) {
      issues.push({ engram_id: label, type: 'secret', detail: `in ${label} — ${hit.pattern}: ${hit.match}` })
    }
    for (const hit of detectPromptInjection(truncateToScanLimit(text))) {
      issues.push({ engram_id: label, type: 'prompt_injection', detail: `in ${label} — ${hit.pattern}: ${hit.match}` })
    }
  }
  return issues
}

/**
 * Read the provenance a pack ships, without judging whether to believe it.
 *
 * `declared` is what the manifest claims in `metadata.provenance`. It is checked
 * against what is actually on disk rather than trusted: the flag is covered by
 * the pack's integrity hash, but the records it points at are not, so a pack can
 * declare provenance and ship none (corruption, a broken build, or somebody
 * stripping the directory after the fact). Saying so is the whole value of
 * having the flag; silently reporting "no provenance" for a pack that promised
 * some would hide exactly the case worth seeing.
 */
export function readPackProvenance(
  packDir: string,
  engrams: Engram[],
  declared?: boolean,
): PackProvenanceView {
  const view: PackProvenanceView = {
    present: false,
    record_count: 0,
    unreadable_records: 0,
    orphan_records: 0,
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
    view.notes.push(declared === true
      ? 'This pack DECLARES provenance in its manifest, and ships none. The records are missing, '
        + 'not merely absent — the pack was built to carry them. Treat the pack as damaged or altered '
        + 'and check where you got it from.'
      : 'This pack carries no provenance. That is not a fault — most packs do not — but nothing here says where its contents came from.')
    return view
  }
  view.present = true
  if (declared === false) {
    view.notes.push('This pack ships provenance records that its manifest does not declare. Nothing is wrong '
      + 'with the records, but the manifest and the contents disagree, and the manifest is the part covered '
      + 'by the integrity hash.')
  }

  // The identifier comes from a file a stranger wrote. The schema constrains it
  // to ^(ENG|ABS|META)-[A-Za-z0-9-]+$ and quarantines anything else before it
  // gets here, so an id cannot climb out of this directory. Sanitise anyway:
  // this builds a filesystem path from untrusted input, and if that validation
  // is ever loosened or another caller skips it, the cost of being wrong is an
  // arbitrary file read.
  //
  // Every value read below comes from a stranger's file, so nothing about its
  // SHAPE is assumed either: a record is a plain object with an array `@graph`,
  // and anything else (`{"@graph": {}}`, `{"@graph": [null]}`) is counted as
  // unreadable rather than crashing preview or install.
  const readJson = (name: string): 'absent' | 'unreadable' | Record<string, unknown> => {
    const safe = name.replace(/[^A-Za-z0-9._-]/g, '_')
    const file = path.join(dir, safe)
    let stat: fs.Stats
    try { stat = fs.lstatSync(file) } catch { return 'absent' }
    // A link is refused at the pack boundary; here it is simply not a record.
    if (!stat.isFile() || stat.size > MAX_PACK_FILE_BYTES) return 'unreadable'
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unreadable'
      return parsed as Record<string, unknown>
    } catch { return 'unreadable' }
  }
  /** The nodes of a record's graph: only the plain objects, or none at all. */
  const graphOf = (record: Record<string, unknown>): Array<Record<string, unknown>> | undefined => {
    const graph = record['@graph']
    if (!Array.isArray(graph)) return undefined
    return graph.filter((n): n is Record<string, unknown> => !!n && typeof n === 'object' && !Array.isArray(n))
  }
  const unreadable: string[] = []

  // The pack record is handed back verbatim, so its shape is checked the same
  // way: an object with an array graph, or it is unreadable.
  const packRead = readJson('pack.jsonld')
  const packRecord = typeof packRead === 'object' && graphOf(packRead) ? packRead : undefined
  if (packRecord) view.pack_record = packRecord
  else if (packRead !== 'absent') unreadable.push('pack.jsonld')

  const licences = new Map<string, { count: number; chosen: boolean; sources: LicenseSource[] }>()
  const parties = new Set<string>()
  let unrecognisedSources = 0

  // Records that name an engram the pack does not ship (profile §5.4.2). The
  // loop below opens a record per engram, so a record about anything else would
  // never be opened at all. Counted from the directory listing by NAME only: a
  // file called `<id>.jsonld` claims to be about `<id>`, and if `<id>` is not
  // in the pack, that claim is the finding. Its contents are not read.
  const shipped = new Set(engrams.map(e => `${e.id}.jsonld`))
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === 'pack.jsonld') continue
      // A name outside this class is not a record, so it is neither an orphan
      // nor read, which makes it invisible in the report. That is only safe
      // while the engram id grammar (§3.3) cannot produce such a name; if ids
      // ever admit a character outside `[A-Za-z0-9._-]`, this line starts
      // hiding real records and must widen with it.
      if (!/^[A-Za-z0-9._-]+\.jsonld$/.test(entry.name)) continue
      if (!shipped.has(entry.name)) view.orphan_records++
    }
  } catch { /* an unlistable directory is reported below as one with no readable records */ }

  // By DISTINCT id, not per engram. A record is found by name (`<id>.jsonld`),
  // so two engrams sharing an id name one file; reading it once per engram
  // would count the same file twice and could drive `engrams_without_record`
  // (a subtraction below) to zero or negative. §5.6.5 asks how many records
  // were present; a file is one record however many engrams point at it.
  const distinctIds = [...new Set(engrams.map(e => e.id))]
  for (const engramId of distinctIds) {
    const engram = engrams.find(e => e.id === engramId)!
    const name = `${engram.id}.jsonld`
    const record = readJson(name)
    if (record === 'absent') continue
    // One bad record must not abort the reading of the rest: the per-record
    // body is fenced so a crafted file counts as unreadable and nothing more.
    try {
      const graph = record === 'unreadable' ? undefined : graphOf(record)
      if (!graph) { unreadable.push(name); continue }
      view.record_count++

      const subject = graph.find(n => n['@id'] === `engram:${engram.id}`)
      if (!subject) continue

      const licence = subject['engram:license']
      if (typeof licence === 'string') {
        // Read the four-state `engram:licenseSource` (chosen, pack-inherited, configured
        // default, schema default), not the boolean: the last two are different facts that
        // `engram:licenseIsDefault` collapses. Falls back to the boolean when absent.
        // Guarded: the record is a stranger's file, so unknown values are not passed through.
        const rawSource = subject['engram:licenseSource']
        // Closed set, not merely a string (profile §8.4). A string outside the
        // four values is a stranger's free text; it is counted, reported, and
        // then treated exactly like a missing field, so the coarser boolean
        // decides — never passed through to a typed surface.
        const source = typeof rawSource === 'string' && LICENSE_SOURCES.has(rawSource as LicenseSource)
          ? rawSource as LicenseSource
          : undefined
        if (rawSource !== undefined && !source) unrecognisedSources++
        const chosen = source
          ? (source === 'chosen' || source === 'configuredDefault')
          : subject['engram:licenseIsDefault'] !== true
        const seen = licences.get(licence)
        // One engram that CHOSE a licence is enough to stop calling it defaulted.
        if (seen) {
          seen.count++
          seen.chosen = seen.chosen || chosen
          if (source && !seen.sources.includes(source)) seen.sources.push(source)
        } else {
          licences.set(licence, { count: 1, chosen, sources: source ? [source] : [] })
        }
      }

      const attributed = subject['prov:wasAttributedTo']
      const who = attributed && typeof attributed === 'object' ? (attributed as Record<string, unknown>)['@id'] : undefined
      if (typeof who === 'string') {
        const party = who.replace(/^engram:agent\//, '')
        if (party !== 'unidentified') { view.attributed_count++; parties.add(party) }
      }
    } catch {
      unreadable.push(name)
    }
  }

  view.unreadable_records = unreadable.length
  if (unreadable.length) {
    view.notes.push(
      `${unreadable.length} provenance record(s) could not be read (${unreadable.slice(0, 3).join(', ')}`
      + `${unreadable.length > 3 ? ', …' : ''}). A record that cannot be read says nothing, and a pack `
      + 'that ships one may have been damaged or altered — check where you got it from.',
    )
  }

  if (view.orphan_records > 0) {
    view.notes.push(
      `${view.orphan_records} provenance record(s) describe engrams this pack does not contain. `
      + 'That is the signature of a pack assembled from a larger set: the records were written '
      + 'about something you are not receiving.',
    )
  }
  if (unrecognisedSources > 0) {
    view.notes.push(
      `${unrecognisedSources} record(s) carry an engram:licenseSource value this reader does not recognise; `
      + 'the coarser engram:licenseIsDefault flag decided for them.',
    )
  }

  // Against DISTINCT ids, for the same reason the loop above runs over them:
  // records are named by id, so a pack shipping two engrams under one id has
  // one id that either has a record or does not. Subtracting from
  // `engrams.length` could go negative, which is not a count of anything.
  view.engrams_without_record = distinctIds.length - view.record_count
  // Said here, not above, because it depends on how many per-engram records
  // turned up.
  if (!packRecord) {
    view.notes.push(view.record_count > 0
      ? 'There are records for individual engrams but none for the pack as a whole.'
      : 'The pack has a provenance directory but no readable records in it.')
  }
  view.asserted_by = [...parties].sort()
  view.licences = [...licences.entries()]
    .map(([name, v]) => ({ name, count: v.count, chosen: v.chosen, sources: v.sources.sort() }))
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

/**
 * Is there anything here to preview? Decided with `lstat` and without reading,
 * BEFORE the directory is walked: `previewPack` takes a path an LLM may have
 * chosen, and walking an arbitrary directory to list its links in an error
 * message would turn "not a pack" into a directory listing of the host.
 */
function assertLooksLikeAPack(source: string): void {
  const present = (name: string) => { try { fs.lstatSync(path.join(source, name)); return true } catch { return false } }
  if (!present('SKILL.md') && !present('manifest.yaml')) {
    throw new Error(`No SKILL.md found in ${source} — a knowledge pack must ship a SKILL.md (manifest.yaml is deprecated)`)
  }
  // The manifest, the engrams and the integrity value are read whole by
  // `loadPack` and `computePackHash`, before the file scan applies its size
  // limit. A multi-gigabyte SKILL.md must be refused here, not read.
  for (const name of ['SKILL.md', 'manifest.yaml', 'engrams.yaml', 'INTEGRITY']) {
    let size = 0
    try { size = fs.lstatSync(path.join(source, name)).size } catch { continue }
    if (size > MAX_PACK_FILE_BYTES) {
      throw new Error(`[plur] refusing to read pack ${source}: ${name} is ${size} bytes, more than the ${MAX_PACK_FILE_BYTES}-byte limit for a pack file.`)
    }
  }
}

/**
 * The ids of engrams whose shipped `engrams.yaml` says `visibility: private`
 * in so many words. Read from the raw document, because the parsed engram
 * cannot tell a declared value from the default the schema filled in.
 *
 * Defensive on every axis: the file was already size-capped and refused as a
 * link by the caller, the YAML load is js-yaml's safe default, and nothing but
 * a plain object with a string `id` and the literal value counts.
 */
function declaredPrivateIds(source: string): Set<string> {
  const ids = new Set<string>()
  const file = path.join(source, 'engrams.yaml')
  if (!fs.existsSync(file)) return ids
  let raw: unknown
  try { raw = yaml.load(fs.readFileSync(file, 'utf8')) } catch { return ids }
  const list = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).engrams
    : undefined
  if (!Array.isArray(list)) return ids
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const e = item as Record<string, unknown>
    if (e.visibility === 'private' && typeof e.id === 'string') ids.add(e.id)
  }
  return ids
}

function _previewPackDir(source: string): PreviewResult {
  if (!fs.existsSync(source)) throw new Error(`Pack source not found: ${source}`)
  assertLooksLikeAPack(source)
  // Before ANY read. `loadPack` below reads SKILL.md and engrams.yaml, and a
  // link in their place would make it read whatever the link names.
  refuseSymlinks(source, 'preview')

  const pack = loadPack(source)
  const security = scanPrivacy(pack.engrams)
  // A private engram the producer DECLARED is not the same finding as one the
  // consumer's default assigned. `visibility` defaults to `private` (§4.4), so
  // a hand-written pack that says nothing about visibility loads as private
  // here: that is this side's conservative assignment, and it means only that
  // the engram will not be re-exported. `visibility: private` written INTO the
  // shipped file is the producer's own record that the engram was not cleared
  // to leave, shipped anyway; §5.6.1 step 2 refuses that, and the scan marks
  // which of the two it saw so the gate can tell them apart.
  const declaredPrivate = declaredPrivateIds(source)
  for (const issue of security.issues) {
    if (issue.type !== 'private_visibility') continue
    issue.declared = declaredPrivate.has(issue.engram_id)
    issue.detail = issue.declared
      ? 'Engram declares visibility: private — a pack must not ship it (§5.4); install is refused'
      : 'Engram has no visibility field and defaults to private here — it will not be re-exported'
  }
  // The pack ships more than engrams; scan the other files too.
  const fileIssues = scanPackFiles(source)
  if (fileIssues.length) {
    security.issues.push(...fileIssues)
    security.clean = false
  }
  // Read what the pack claims about its own origins, BEFORE anything installs.
  // The gate belongs at the boundary; afterwards it changes nothing.
  const provenance = readPackProvenance(
    source,
    pack.engrams,
    (pack.manifest.metadata as { provenance?: boolean } | undefined)?.provenance,
  )
  // Check the SHIPPED value against the contents, before anything installs.
  const integrity = verifyPackIntegrity(source)

  const warnings: string[] = []
  // Flag pinned engrams: they bypass the relevance gate (always injected).
  // Install strips these, but the preview should be honest about intent.
  const pinnedCount = pack.engrams.filter(e => (e as any).pinned === true).length
  if (pinnedCount > 0) warnings.push(`${pinnedCount} engram(s) marked pinned — these bypass relevance filters; install will strip the flag`)
  // Same for a locked commitment: it resists dedup and correction, so it hands
  // the producer a claim the recipient cannot revise. Install downgrades it;
  // the preview says so, as it does for pinned (§5.4, §5.6.1 step 3).
  const lockedCount = pack.engrams.filter(e => (e as any).commitment === 'locked').length
  if (lockedCount > 0) warnings.push(`${lockedCount} engram(s) carry commitment: locked — these resist correction; install will downgrade them to decided`)
  // Flag a declared private engram before install refuses it, so a reader is
  // told at preview rather than at the gate.
  // Counted from the issues, not the raw set: an entry the loader quarantined
  // is not an engram, installs nothing, and must not be warned about as one.
  const declaredCount = security.issues.filter(i => i.type === 'private_visibility' && i.declared === true).length
  if (declaredCount > 0) {
    warnings.push(`${declaredCount} engram(s) declare visibility: private — a pack must not ship these; install is refused`)
  }
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
  /**
   * Directories of other copies of this same pack that this install removed:
   * stale copies installed beside it under a collision-suffixed name (see
   * `staleCollisionCopies`). Empty when there were none.
   */
  superseded: string[]
  conflicts: ConflictItem[]
  security: PrivacyScanResult
  registry: RegistryEntry
  /**
   * What checking the shipped integrity value found. Reported even when it
   * passed, so a caller can tell "matched" from "there was nothing to match
   * against".
   */
  integrity_check: IntegrityCheck
  /**
   * Host-overriding fields the install neutralized (ENGRAM-STANDARD-v1 §5.6.1
   * step 3), by field. Zero is reported too: an install that changed nothing
   * must be distinguishable from one that changed something and said nothing.
   */
  neutralized: NeutralizedCounts
  /**
   * Provenance-record counts for the pack (ENGRAM-STANDARD-v1 §5.6.5, profile §5.4.2),
   * reported at install because the obligation is on the consumer. Orphan records signal
   * a pack cut from a larger set. Absent when there is no `provenance/` directory —
   * "nothing to report" differs from "all zero".
   */
  provenance?: InstallProvenanceCounts
}

/** The four counts §5.6.5 requires a consumer to report about a pack's records. */
export interface InstallProvenanceCounts {
  /** Records read successfully. */
  record_count: number
  /** Engrams the pack ships, so `record_count` has something to be "against". */
  engrams_total: number
  /** Record files present but unreadable (profile §5.4.2). */
  unreadable_records: number
  /** Records naming an engram the pack does not ship. */
  orphan_records: number
  /** Engrams with no record of their own. */
  engrams_without_record: number
  /**
   * Records the consumer did not retain, because it could not check them
   * (profile §5.4.1). Reported so that "we dropped this" stays distinguishable
   * from "there was nothing here"; the file names are in `security.issues`.
   */
  not_retained: number
}

/** How many engrams a consumer changed on import, and which field (§5.6.5). */
export interface NeutralizedCounts {
  /** `pinned` removed. */
  pinned_stripped: number
  /** `commitment: locked` downgraded to `decided`, with `locked_at`/`locked_reason` removed. */
  locked_downgraded: number
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
  /**
   * Override the prompt-injection block. Secrets and private-visibility engrams
   * are ALWAYS blocked regardless; there is no option for those, by design
   * (ENGRAM-STANDARD-v1 §5.6.1 step 2).
   */
  allowInjection?: boolean
  /**
   * Install even though the contents do not match the integrity value the pack
   * shipped. Off by default: a pack that changed after it was built is
   * exactly the case somebody should have to look at before proceeding.
   */
  allowModified?: boolean
}

function _installPackDir(
  packsDir: string,
  source: string,
  existingEngrams?: Engram[],
  opts: InstallOptions = {},
): InstallResult {
  if (!fs.existsSync(source)) throw new Error(`Pack source not found: ${source}`)

  // Preflight the registry BEFORE doing any filesystem work. The registry is
  // only WRITTEN at the end of this function, so an unreadable registry would
  // otherwise abort the install after the pack directory is already live,
  // leaving it installed but unrecorded (`integrity_status: 'unverified'`).
  loadRegistry(packsDir)

  // Security scan BEFORE copying: always runs, not opt-out
  const preview = _previewPackDir(source)

  // Does the pack still match the integrity value its author shipped?
  // Blocking is the right default. Unlike the injection scan, there is no
  // legitimate reason for a pack to differ from its own recorded hash: either
  // it was damaged in transit or somebody changed it, and both deserve a look.
  if (preview.integrity.status === 'modified' && !opts.allowModified) {
    throw new Error(
      `This pack does not match the integrity value it shipped.\n`
      + `  shipped:  ${preview.integrity.shipped}\n`
      + `  contents: ${preview.integrity.computed}\n`
      + `It has been changed since it was built. Install it only if you know why it differs.`,
    )
  }
  // No override for either of the next two, on purpose (ENGRAM-STANDARD-v1
  // §5.6.1 step 2). Both are things §5.4 forbids a producer to ship, so their
  // presence means the pack was built wrong or built to mislead, and the remedy
  // is a corrected pack, not an installer who looks away. A false positive in
  // the secret scan is fixed by editing the pack; this consumer's scan surface
  // is documented in `docs/pack-scan-surface.md` (the patterns themselves are
  // `detectSecrets` / `detectSensitive` in `secrets.ts`), as §5.6.1 asks.
  const secretIssues = preview.security.issues.filter(i => i.type === 'secret')
  if (secretIssues.length > 0) {
    const details = secretIssues.map(i => `  ${i.engram_id}: ${i.detail}`).join('\n')
    throw new Error(`Pack contains secrets — install blocked:\n${details}`)
  }
  // A private engram is somebody's memory that was never cleared to leave their
  // machine. Installing it makes the recipient hold it, and hold it under a
  // visibility that then forbids passing it on, so the leak becomes permanent
  // on this side too. Visibility is a permission boundary, not a hint.
  const privateIssues = preview.security.issues.filter(i => i.type === 'private_visibility' && i.declared === true)
  if (privateIssues.length > 0) {
    const ids = privateIssues.map(i => `  ${i.engram_id}`).join('\n')
    throw new Error(
      `Pack contains ${privateIssues.length} engram(s) that declare visibility: private — install refused:\n${ids}\n`
      + 'A private engram must not be in a pack (ENGRAM-STANDARD-v1 §5.4). Ask whoever built it to export again without them.',
    )
  }
  // A file the scan could not read cannot be installed — no override; fix the pack.
  // Narrow carve-out (provenance profile §5.4.2): an `oversize` / `read_error` file under
  // `provenance/` with the §5.3.1 record name counts as one unreadable record and must not
  // abort install. Symlinks, special files and truncated walks still block everywhere.
  // The exempted file is reported and skipped by the copy, so nothing unchecked lands.
  const isUnreadableProvenanceRecord = (i: PrivacyIssue): boolean =>
    (i.unscannable_reason === 'oversize' || i.unscannable_reason === 'read_error')
    && /^provenance\/[A-Za-z0-9._-]+\.jsonld$/.test(i.engram_id.split(path.sep).join('/'))
  const unscannable = preview.security.issues.filter(i => i.type === 'unscannable')
  const blocking = unscannable.filter(i => !isUnreadableProvenanceRecord(i))
  if (blocking.length > 0) {
    const details = blocking.map(i => `  ${i.detail}`).join('\n')
    throw new Error(`Pack contains files the security scan could not read — install blocked:\n${details}`)
  }
  // Names of the provenance records the scan could not check, so the copy below
  // leaves them behind. Normalized to forward slashes to match the copy loop.
  const unreadableProvenanceFiles = new Set(
    unscannable.filter(isUnreadableProvenanceRecord)
      .map(i => i.engram_id.split(path.sep).join('/').slice('provenance/'.length)),
  )
  // Prompt-injection text is blocked unless explicitly overridden.
  const injectionIssues = preview.security.issues.filter(i => i.type === 'prompt_injection')
  if (injectionIssues.length > 0 && !opts.allowInjection) {
    const details = injectionIssues.map(i => `  ${i.engram_id}: ${i.detail}`).join('\n')
    throw new Error(
      `Pack contains prompt-injection / instruction-override text — install blocked:\n${details}\n` +
      `Re-run with allowInjection if this is intentional (e.g. a security-knowledge pack).`,
    )
  }

  // Destination name is the source basename, EXCEPT for a flat URL archive.
  // Those extract to a directory literally called `extracted`, so every flat
  // archive would install to `packs/extracted` and overwrite the previous one.
  // Only that generic name is overridden, and only with a manifest name safe
  // to use as a directory.
  const rawName = path.basename(source)
  const manifestName = preview.manifest.name?.trim()
  const safeManifestName = manifestName && /^[A-Za-z0-9._-]+$/.test(manifestName) && !/^\.+$/.test(manifestName) ? manifestName : undefined
  const preferredName = rawName === FLAT_ARCHIVE_DIRNAME && safeManifestName ? safeManifestName : rawName
  // Refuse a traversal name before any directory is inspected.
  resolveInside(packsDir, preferredName, 'install')
  // Two DIFFERENT packs downloaded into same-named folders (`a/pack`, `b/pack`)
  // must not share `packs/pack`. The basename is kept while the directory is
  // free or holds the same pack (same manifest name: a reinstall or upgrade).
  // When it holds a different pack, the manifest name is tried, then
  // `<name>-2`, `-3`, ...
  const sourceName = pickInstallDirName(packsDir, preferredName, safeManifestName, manifestName)
  // The name the directory already has, if a case-variant of it is installed
  // on a case-insensitive filesystem: the swap below then keeps that name and
  // the registry row follows the directory.
  const destDir = resolveInside(packsDir, onDiskEntryName(packsDir, sourceName), 'install')
  // Stale collision-suffixed copies of this same pack beside the one being
  // upgraded. Decided now, from the registry as it was before this install
  // rewrites the target's row; removed only after the swap succeeds.
  const obsoleteCopies = staleCollisionCopies(packsDir, path.basename(destDir), manifestName)

  // STAGE the whole install, then swap it in.
  //
  // Copying file-by-file into the live destination would let a copy error, a
  // crash, or a concurrent install leave a HYBRID of the old and new pack, with
  // an integrity hash matching neither. Everything below builds the pack in a
  // staging directory; the live directory is not touched until the content is
  // complete and sanitized.
  const staging = `${destDir}.installing-${process.pid}-${Date.now()}`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })

  // Plain files only, and checked again HERE with `lstat`, not `stat`: the
  // preview above refuses links, but this copy is the last step before bytes
  // reach the store and must not trust that the check ran. `stat().isFile()`
  // is true for a symlink to a file, so a `stat`-based copy would follow it.
  const copyPlainFile = (srcPath: string, destPath: string, label: string) => {
    const st = fs.lstatSync(srcPath)
    if (st.isSymbolicLink()) {
      throw new Error(`[plur] refusing to install pack: ${label} is a symbolic link, and a pack must ship plain files.`)
    }
    if (!st.isFile()) return
    fs.copyFileSync(srcPath, destPath)
  }
  for (const file of fs.readdirSync(source)) {
    copyPlainFile(path.join(source, file), path.join(staging, file), file)
  }

  // The provenance records travel with the pack, so a preview of the installed
  // copy does not call it damaged. Only `*.jsonld` plain files, only one level
  // deep, and only under the name the export gave them: the record for an
  // engram is found by `<id>.jsonld`, so a name that does not fit that shape is
  // not a record.
  const provSrc = path.join(source, 'provenance')
  if (fs.existsSync(provSrc) && fs.lstatSync(provSrc).isDirectory()) {
    const provDest = path.join(staging, 'provenance')
    for (const file of fs.readdirSync(provSrc)) {
      if (!/^[A-Za-z0-9._-]+\.jsonld$/.test(file)) continue
      // A record the scan could not check does not travel. The install was
      // allowed to proceed past it (profile §5.4.2: an unreadable record must
      // not abort the pack), which is only defensible while the file itself
      // stays out of the installed copy: the rule that nothing unchecked lands
      // is not relaxed, only the rule that everything must be installable.
      // It is counted as unreadable in the preview and reported at install.
      if (unreadableProvenanceFiles.has(file)) continue
      fs.mkdirSync(provDest, { recursive: true })
      copyPlainFile(path.join(provSrc, file), path.join(provDest, file), path.join('provenance', file))
    }
  }

  // `normalizeStagedPack` upgrades a deprecated manifest.yaml to SKILL.md and clamps
  // host-overriding fields (pinned / locked commitment), re-saving the copy — before
  // computePackIntegrity, so the integrity covers what is actually installed.
  // Shared with `migratePackIntegrity` so it reproduces the installed form (§5.5).
  const { upgradedManifest, engrams: newEngrams, sanitized } = normalizeStagedPack(staging, preview.manifest)
  if (upgradedManifest) {
    logger.warning(
      `installPack: pack '${preview.manifest.name}' shipped a deprecated manifest.yaml — upgraded to SKILL.md in the installed copy`,
    )
  }
  if (sanitized.changed) {
    // Each field on its own line (§5.6.5: "which field was changed"), so no
    // neutralization happens in silence.
    if (sanitized.pinnedStripped > 0) {
      logger.warning(`installPack: stripped 'pinned' from ${sanitized.pinnedStripped} engram(s) in pack '${preview.manifest.name}'`)
    }
    if (sanitized.lockedDowngraded > 0) {
      logger.warning(`installPack: downgraded 'commitment: locked' to 'decided' on ${sanitized.lockedDowngraded} engram(s) in pack '${preview.manifest.name}'`)
    }
  }
  const neutralized: NeutralizedCounts = {
    pinned_stripped: sanitized.pinnedStripped,
    locked_downgraded: sanitized.lockedDowngraded,
  }

  // Detect conflicts with existing engrams
  const conflicts = existingEngrams ? detectConflicts(newEngrams, existingEngrams) : []

  // Compute integrity over the STAGED, sanitized content: the bytes that are
  // about to become the pack. Hashing the live directory before the swap would
  // record the hash of the previous install.
  const integrity = computePackIntegrity(staging)

  // Make the staged content durable BEFORE it becomes the live pack. The
  // registry entry written afterwards IS durable, so without this a power loss
  // could leave a durable registry pointing at a pack that is missing,
  // truncated or half-copied, with the previous version already deleted.
  // Atomic-to-readers is not the same property as crash-durable.
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

  const registryEntry: RegistryEntry & { dir: string } = {
    name: preview.manifest.name,
    dir: path.basename(destDir),
    installed_at: new Date().toISOString(),
    source: path.resolve(source),
    integrity,
    version: preview.manifest.version,
    creator: preview.manifest.creator,
  }
  addToRegistry(packsDir, registryEntry)

  // One authoritative installation: the copies found above are removed with
  // their registry rows, each moved aside first so a reader never loads a
  // half-deleted pack. A failure is reported, not hidden; the new version is
  // already in place either way.
  const superseded: string[] = []
  for (const dir of obsoleteCopies) {
    const live = path.join(packsDir, dir)
    const aside = `${live}.replacing-${process.pid}-${Date.now()}`
    try {
      fs.renameSync(live, aside)
      removeFromRegistry(packsDir, dir, manifestName)
      fs.rmSync(aside, { recursive: true, force: true })
      superseded.push(dir)
    } catch (err) {
      logger.warning(`installPack: could not remove the obsolete copy of '${manifestName}' in ${dir}: ${(err as Error).message}`)
    }
  }

  return {
    installed: newEngrams.length,
    superseded,
    name: sourceName,
    conflicts,
    security: preview.security,
    registry: registryEntry,
    integrity_check: preview.integrity,
    neutralized,
    // Carried from the preview this install already ran (§5.6.5). Only when the
    // pack actually shipped a `provenance/` directory; see the field's note on
    // why "nothing to report" is not the same as four zeros.
    provenance: preview.provenance.present
      ? {
          record_count: preview.provenance.record_count,
          engrams_total: newEngrams.length,
          unreadable_records: preview.provenance.unreadable_records,
          orphan_records: preview.provenance.orphan_records,
          engrams_without_record: preview.provenance.engrams_without_record,
          not_retained: unreadableProvenanceFiles.size,
        }
      : undefined,
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
      setRegistrySource(packsDir, result.registry.dir!, source)
      return result
    } finally {
      cleanupDownloadedPack(tmpRoot)
    }
  }
  return _installPackDir(packsDir, source, existingEngrams, opts)
}

function pickInstallDirName(
  packsDir: string,
  preferred: string,
  safeManifestName: string | undefined,
  manifestName: string | undefined,
): string {
  // A directory may receive this pack when it is free, or when it already
  // holds a pack with the same manifest name. A directory whose manifest cannot
  // be read is replaced: reinstalling over a damaged copy is how it gets
  // repaired.
  const accepts = (name: string): boolean => {
    const dir = path.join(packsDir, onDiskEntryName(packsDir, name))
    if (!fs.existsSync(dir)) return true
    if (!manifestName) return true
    let installed: string | undefined
    try { installed = loadPack(dir).manifest.name?.trim() } catch { return true }
    return !installed || installed === manifestName
  }
  // A pack already installed in one of the directories THIS install could be
  // given is replaced where it is. Choosing by which directory happened to be
  // free first would let a pack once displaced into a fallback directory
  // (`bob-tips`, `x-2`) be installed a second time into the preferred one as
  // soon as that came free, leaving the old version loadable beside the new.
  // Only this install's own candidates count (preferred, manifest name,
  // `<base>-N`): two folders that happen to ship the same manifest name under
  // different basenames stay two installations (registry rows keyed by dir).
  const base = safeManifestName ?? preferred
  const numberOf = (e: string): number =>
    e.startsWith(`${base}-`) && /^[0-9]+$/.test(e.slice(base.length + 1)) ? Number(e.slice(base.length + 1)) : NaN
  const existing = installedDirsNamed(packsDir, manifestName)
  for (const want of [preferred, safeManifestName]) {
    if (!want) continue
    const hit = existing.find(e => e === onDiskEntryName(packsDir, want))
    if (hit) return hit
  }
  const fallback = existing
    .filter(e => numberOf(e) >= 2)
    .sort((a, b) => numberOf(a) - numberOf(b))[0]
  if (fallback) return fallback
  if (accepts(preferred)) return preferred
  if (safeManifestName && safeManifestName !== preferred && accepts(safeManifestName)) return safeManifestName
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (accepts(candidate)) return candidate
  }
}

/**
 * Other installed copies of the pack, left behind by a collision, that this install into
 * `target` supersedes. A same-name directory is obsolete when its registry row says it was
 * displaced from `target`, or the target's row says the target was displaced from it.
 * Always kept: a different manifest name, a copy with no `dir` row, a URL install, and a
 * copy in the directory its own source asked for (deliberate parallel installs).
 */
function staleCollisionCopies(packsDir: string, target: string, manifestName: string | undefined): string[] {
  if (!manifestName) return []
  let entries: RegistryEntry[]
  try { entries = loadRegistry(packsDir) } catch { return [] }
  const askedFor = (dir: string): string | undefined => {
    const row = entries.find(e => e.dir === dir)
    if (!row || typeof row.source !== 'string' || isPackUrl(row.source)) return undefined
    const raw = path.basename(row.source)
    const name = row.name?.trim()
    const wanted = raw === FLAT_ARCHIVE_DIRNAME && name && /^[A-Za-z0-9._-]+$/.test(name) ? name : raw
    return wanted === dir ? undefined : wanted
  }
  const targetWanted = askedFor(target)
  return installedDirsNamed(packsDir, manifestName).filter(dir =>
    dir !== target && (askedFor(dir) === target || targetWanted === dir))
}

/** Directories in `packsDir` holding a pack whose manifest name is `manifestName`, sorted. */
function installedDirsNamed(packsDir: string, manifestName: string | undefined): string[] {
  if (!manifestName || !fs.existsSync(packsDir)) return []
  return fs.readdirSync(packsDir).filter(e => {
    if (isTransientPackDir(e)) return false
    const d = path.join(packsDir, e)
    try {
      if (!fs.statSync(d).isDirectory()) return false
      return loadPack(d).manifest.name?.trim() === manifestName
    } catch { return false }
  }).sort()
}

/**
 * Resolve `name` as a direct child of `packsDir`, or throw. The name is caller-supplied
 * (CLI and MCP uninstall); `..` would reach the PLUR root, which uninstall then `rmSync`s.
 * Containment is checked on the RESOLVED path, not by pattern-matching the name.
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
   * Always `true`; the literal type is the point.
   *
   * `uninstallPack` THROWS when the pack is absent, so a returned result is
   * already proof of removal. A `boolean` would imply `false` is reachable and
   * invite dead "not found" branches in callers; the literal type makes a
   * `removed === false` branch a type error.
   */
  removed: true
  engram_count: number
}

export function uninstallPack(packsDir: string, name: string): UninstallResult {
  // Find the pack: try exact name, then case-insensitive. Either way the
  // directory is addressed by the name it has ON DISK, so the registry row
  // keyed by it is found.
  resolveInside(packsDir, name, 'uninstall')
  let packDir = resolveInside(packsDir, onDiskEntryName(packsDir, name), 'uninstall')
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
  // pack whose engrams.yaml is unreadable is still removable. `loadEngrams`
  // THROWS on an unreadable file rather than returning [] (the write path
  // treats [] as "empty" and would then destroy the store), so this catch is
  // the explicit opt-in to "unknown, and that is fine here".
  try { count = loadEngrams(engramsPath).length } catch { count = 0 }
  let manifestName: string | undefined
  try { manifestName = loadPack(packDir).manifest.name } catch {}

  // Remove THIS directory's row only: by `dir`, or, for a legacy row, by
  // manifest name, and then only when no other installed directory carries the
  // same name. The directory name stands in for the manifest name when the
  // manifest cannot be read. Removing by name alone would erase the baseline of
  // every other pack sharing it.
  removeFromRegistry(packsDir, path.basename(packDir), manifestName ?? path.basename(packDir))

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
   * Explicit integrity verdict:
   *   'ok'          the pack hashes to what the registry recorded at install
   *   'modified'    the contents changed after install
   *   'unverified'  there is NO registry entry, so the question cannot be answered
   * Exists because `integrity_ok === undefined` reads as "nothing to report", while an
   * unreachable verdict often has the same cause as a failed one: tampering.
   */
  integrity_status?: 'ok' | 'modified' | 'unverified'
  /**
   * `'carried-from-v1'` when the registry's v2 baseline was carried forward
   * from a v1 row without re-verifying the pack against its source (§5.5,
   * `RegistryEntry.integrity_carried_from`). `integrity_status: 'ok'` then
   * means "unchanged since the migration", not "matches what was installed":
   * an edit v1 could not see, made before the migration, is inside the
   * baseline. Absent for a baseline written by an install or re-verified
   * against the source.
   */
  baseline?: 'carried-from-v1'
  /**
   * `true` when the only registry row for this pack is a legacy row (no
   * equally own (two same-name packs installed before rows were keyed by
   * directory). `integrity_status` is then `'unverified'`: which pack
   * the recorded value belongs to cannot be told. Reinstalling the pack gives
   * it a row of its own.
   */
  registry_ambiguous?: true
  /**
   * Why this pack could not be read, when it could not. A damaged pack is
   * listed with what is known about it rather than aborting the listing or
   * appearing as a healthy pack with 0 engrams.
   */
  load_error?: string
}

export function listPacks(packsDir: string): PackInfo[] {
  if (!fs.existsSync(packsDir)) return []

  const registry = loadRegistry(packsDir)
  // By directory first; a legacy row (no `dir`) by manifest name.
  const rowFor = (dir: string, name: string | undefined): RegistryEntry | undefined => {
    const idx = findRegistryRowIndex(registry, dir, name)
    return idx >= 0 ? registry[idx] : undefined
  }
  // A legacy row that another installed directory could equally own is not
  // this pack's baseline to verify against: comparing an untouched pack with
  // its same-name neighbour's hash would report a false `modified`. Report it
  // as unanswerable, the same verdict migration reaches.
  const ambiguous = (dir: string, name: string, reg: RegistryEntry | undefined): boolean =>
    isAmbiguousLegacyRow(packsDir, dir, name, reg, registry)

  const result: PackInfo[] = []
  for (const entry of fs.readdirSync(packsDir)) {
    if (isTransientPackDir(entry)) continue
    const packDir = path.join(packsDir, entry)
    if (!isDirNow(packDir)) continue

    try {
      const pack = loadPack(packDir)
      const matched = rowFor(entry, pack.manifest.name)
      const registryAmbiguous = ambiguous(entry, pack.manifest.name, matched)
      const reg = registryAmbiguous ? undefined : matched
      // Compared in the version the registry recorded: a v1 row still
      // verifies as it did (§5.5). The reported value is always v2, the
      // current form.
      const integrityOk = reg ? packIntegrityMatches(reg.integrity, packDir) : undefined
      result.push({
        name: pack.manifest.name,
        path: packDir,
        engram_count: pack.engrams.length,
        manifest: pack.manifest,
        integrity: computePackIntegrity(packDir),
        installed_at: reg?.installed_at,
        source: reg?.source,
        integrity_ok: integrityOk,
        integrity_status: reg ? (integrityOk ? 'ok' : 'modified') : 'unverified',
        ...(reg?.integrity_carried_from === 'v1' && INTEGRITY_V2_RE.test(reg.integrity)
          ? { baseline: 'carried-from-v1' as const }
          : {}),
        ...(registryAmbiguous ? { registry_ambiguous: true as const } : {}),
      })
    } catch (manifestErr) {
      // Per-pack fallback: the manifest would not load, so report what can
      // still be established rather than dropping the pack from the listing.
      //
      // `loadEngrams` THROWS on an unreadable corpus by design, so it is
      // guarded here too: one pack with a corrupt engrams.yaml must not abort
      // the ENTIRE listing. This branch already knows the pack is damaged.
      const engramsPath = path.join(packDir, 'engrams.yaml')
      let count = 0
      let loadError = (manifestErr as Error).message
      try {
        if (fs.existsSync(engramsPath)) count = loadEngrams(engramsPath).length
      } catch (corpusErr) {
        loadError = (corpusErr as Error).message
      }
      const reg = rowFor(entry, entry)
      result.push({
        name: entry,
        path: packDir,
        engram_count: count,
        installed_at: reg?.installed_at,
        source: reg?.source,
        // No manifest loaded means no hash was computed, so the integrity
        // question cannot be answered: a state to report, not to omit.
        integrity_status: 'unverified',
        load_error: loadError,
      })
    }
  }
  return result
}
