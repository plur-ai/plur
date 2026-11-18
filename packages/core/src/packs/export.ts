import * as fs from 'fs'
import yaml from 'js-yaml'
import * as path from 'path'
import { userStructuredData } from '../content-fields.js'
import { buildPackProvenanceRecord, buildProvenanceRecord, serializeProvenanceRecord } from '../provenance.js'
import type { Engram } from '../schemas/engram.js'
import { computePackIntegrity } from './integrity.js'
import { type PrivacyScanResult, scanPrivacy } from './privacy.js'


// --- Export ---

export interface ExportOptions {
  /**
   * Write provenance records alongside the pack. **On by default.** A pack is
   * the trust boundary, so its bill of materials travels inside the artifact.
   * Deliberately independent of the `provenance.generate` config setting
   * (per-engram records in your own store, default `never`). Pass `false` to opt out.
   */
  provenance?: boolean
  name: string
  version: string
  description?: string
  creator?: string
  /**
   * The licence on the pack as a collection. **Required:** the one decision
   * export will not make for the author. Falling back to the schema's
   * `cc-by-sa-4.0` would ship a copyleft grant nobody chose; callers with no
   * opinion should set `provenance.default_license` in config. `unlicensed` is
   * accepted and says plainly that no grant is made (unlike omitting the field).
   */
  license?: string
  domain?: string
  scope?: string
  tags?: string[]
  type?: string
}


export function deriveMatchTerms(engrams: Engram[]): string[] {
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
 * Reject a pack name that would escape its output directory (`../escape`) or
 * is not legal inside provenance identifiers (`engram:pack/<name>@<version>`).
 * Rejecting, not rewriting: a pack landing somewhere other than its name says
 * is worse than one that refuses to build.
 */
export function assertSafePackName(name: string): void {
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
  /**
   * The licence configured as this user's default (`provenance.default_license`).
   *
   * Satisfies the requirement below, because it IS a choice, made once, in
   * advance, rather than not at all. The `Plur` wrapper supplies it; a direct
   * caller passes it or names a licence explicitly.
   */
  configuredLicense?: string,
): ExportResult {
  assertSafePackName(manifest.name)

  // Refuse to guess the one field with legal weight.
  //
  // Every other unset field degrades to "not recorded", which a record can say
  // honestly. A licence cannot: the schema supplies `cc-by-sa-4.0` on parse, so
   // silence does not produce silence: it produces a copyleft grant, over other
   // people's memories, to whoever receives the pack, attributed to an author who
   // never agreed to it. Failing here is the only way not to do that quietly.
  const packLicense = manifest.license ?? configuredLicense
  if (!packLicense) {
    throw new Error(
      'A pack needs a licence before it can be exported.\n\n'
      + 'This is the one thing export will not decide for you: a pack is going to a stranger, '
      + 'and leaving it blank does not leave it blank — the schema fills in cc-by-sa-4.0, a '
      + 'share-alike grant nobody chose.\n\n'
      + 'Pass one (for example cc-by-4.0, apache-2.0, cc0-1.0), or set '
      + 'provenance.default_license in your config to choose once and stop being asked. '
      + 'Use "unlicensed" to state plainly that you are granting nothing.',
    )
  }

  // Privacy scan: filter out problematic engrams
  const allPrivacy = scanPrivacy(engrams)

  // A pack is a SHARED artifact, so exclude EVERY engram scanPrivacy flagged:
  // not only secrets and private-tagged ones, but also PII (personal paths,
  // emails, private IPs) and prompt-injection. scanPrivacy only flags
  // content that has no place in a shared pack, so ANY issue is disqualifying.
  // The full scan is still returned in `privacy`, so the caller sees exactly
  // which engrams were held back and why.
  const blockedIds = new Set(allPrivacy.issues.map(i => i.engram_id))
  const safeEngrams = engrams.filter(e => !blockedIds.has(e.id))

  // Derive match_terms from engram tags and domains
  const matchTerms = deriveMatchTerms(safeEngrams)

  // Create output directory
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })

  // Write manifest as SKILL.md frontmatter.
  //
  // `metadata.provenance` is written BEFORE the integrity hash is computed, so
  // the declaration is inside the hash even though the records it points at are
  // not (the §5.5 hash covers the manifest and engrams.yaml only). That is the most
  // a manifest can offer here: a reader learns the directory should be there
  // without probing, and learns it from bytes that cannot be altered without
  // breaking the pack's integrity value. It is still a producer's claim, so
  // `readPackProvenance` verifies the directory rather than trusting the flag.
  const shipsProvenance = manifest.provenance !== false
  const frontmatter = yaml.dump({
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    creator: manifest.creator,
    // Always present: export refuses to run without a chosen licence, so this
    // can never be the schema default masquerading as a decision.
    license: packLicense,
    metadata: {
      injection_policy: 'on_match',
      match_terms: matchTerms,
      engram_count: safeEngrams.length,
      ...(shipsProvenance ? { provenance: true } : {}),
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
        // Supersedes edges are store-internal cross-refs too: a stale
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
    // The same rule for every other identifier only our store can resolve
    // (profile §2.2: "No identifiers only our store can resolve"):
    // `derived_from`, the derivation `chain`, a `provenance.origin` of
    // `session:<episode>`, `episode_ids` and `sources[].session_id` cannot be
    // looked up by a recipient and would name our sessions to them.
    cleaned.derived_from = null
    cleaned.episode_ids = []
    if (cleaned.sources?.length) {
      cleaned.sources = cleaned.sources.map(s => ({ ...s, session_id: null }))
    }
    if (cleaned.provenance) {
      const { origin, license } = cleaned.provenance
      // A session origin means nothing outside this store; `direct` is what
      // an engram with no recorded origin carries.
      cleaned.provenance = {
        origin: typeof origin === 'string' && !origin.startsWith('session:') ? origin : 'direct',
        chain: [],
        signature: null,
        ...(license !== undefined ? { license } : {}),
      } as NonNullable<Engram['provenance']>
    }
    // PLUR's own `structured_data` bookkeeping does not leave either.
    // `PLUR_BOOKKEEPING_KEYS` is exempt from every sensitivity scan (it carries
    // host topology legitimately), so it MUST be stripped from the export: it
    // holds internal hosts, scope names and `_demoted.patterns`. One set decides
    // both halves; user-set keys (even `_`-prefixed) are scanned and kept.
    const userSd = userStructuredData(cleaned.structured_data)
    if (userSd === undefined) delete (cleaned as { structured_data?: unknown }).structured_data
    else cleaned.structured_data = userSd as Record<string, unknown>
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
    // Strip host-overriding fields: never export an always-load directive or a
    // locked commitment into a shareable pack. Mirrors the clamp applied on
    // install.
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
  const integrity = computePackIntegrity(outputDir)
  fs.writeFileSync(path.join(outputDir, 'INTEGRITY'), `${integrity}\n`)

  // Provenance, written after the integrity hash so the pack record can
  // carry it.
  //
  // The hash covers the manifest and engrams.yaml only, per the standard, so these
  // files are NOT covered by it. The dependency therefore runs the other way:
  // the record commits to the pack. Change the pack and the hash inside the
  // record stops matching.
  //
  // Only engrams that survived the privacy scan appear. Provenance must never
  // become a way to ship something the content path already refused.
  const provenanceFiles: string[] = []
  if (shipsProvenance) {
    const provDir = path.join(outputDir, 'provenance')
    fs.mkdirSync(provDir, { recursive: true })

    const packRecord = buildPackProvenanceRecord(
      {
        name: manifest.name,
        version: manifest.version,
        creator: manifest.creator,
        license: packLicense,
        integrity,
      },
      safeEngrams,
    )
    fs.writeFileSync(path.join(provDir, 'pack.jsonld'), serializeProvenanceRecord(packRecord))
    provenanceFiles.push(path.join('provenance', 'pack.jsonld'))

    // The engrams a recipient of this pack CAN resolve: the ones in it. A
    // record may name another member (this one revised that one); it may not
    // name an engram that stays behind.
    const members = new Set(safeEngrams.map(e => e.id))
    for (const engram of safeEngrams) {
      // Portable by default: a record that stands on its own, names no engram
      // outside the pack, and carries no session identifier.
      // A member with no licence of its own inherits the pack's, recorded as
      // inheritance rather than as the engram's own choice: the assembler
      // granted it, and may not hold rights over every engram in the pack.
      const record = buildProvenanceRecord(engram, [], {
        mode: 'portable',
        members,
        packLicense,
        packId: `${manifest.name}@${manifest.version}`,
      })
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
    integrity,
    ...(shipsProvenance ? { provenance_files: provenanceFiles } : {}),
  }
}
