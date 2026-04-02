import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import yaml from 'js-yaml'
import { loadPack, loadEngrams } from './engrams.js'
import { detectSecrets } from './secrets.js'
import type { Engram } from './schemas/engram.js'
import type { PackManifest } from './schemas/pack.js'
import { logger } from './logger.js'

export { loadAllPacks } from './engrams.js'

// --- Install ---

export interface InstallResult {
  installed: number
  name: string
  conflicts: ConflictItem[]
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

export function installPack(packsDir: string, source: string, existingEngrams?: Engram[]): InstallResult {
  if (!fs.existsSync(source)) throw new Error(`Pack source not found: ${source}`)

  const sourceName = path.basename(source)
  const destDir = path.join(packsDir, sourceName)

  // Copy pack directory
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true })

  const files = fs.readdirSync(source)
  for (const file of files) {
    const srcPath = path.join(source, file)
    const destPath = path.join(destDir, file)
    if (fs.statSync(srcPath).isFile()) {
      fs.copyFileSync(srcPath, destPath)
    }
  }

  // Load and count engrams
  const engramsPath = path.join(destDir, 'engrams.yaml')
  const newEngrams = fs.existsSync(engramsPath) ? loadEngrams(engramsPath) : []

  // Detect conflicts with existing engrams
  const conflicts = existingEngrams ? detectConflicts(newEngrams, existingEngrams) : []

  return { installed: newEngrams.length, name: sourceName, conflicts }
}

// --- Uninstall ---

export interface UninstallResult {
  name: string
  removed: boolean
  engram_count: number
}

export function uninstallPack(packsDir: string, name: string): UninstallResult {
  // Find the pack — try exact name, then case-insensitive
  let packDir = path.join(packsDir, name)
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

  // Count engrams before removal
  const engramsPath = path.join(packDir, 'engrams.yaml')
  let count = 0
  try { count = loadEngrams(engramsPath).length } catch {}

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
}

export function listPacks(packsDir: string): PackInfo[] {
  if (!fs.existsSync(packsDir)) return []

  const result: PackInfo[] = []
  for (const entry of fs.readdirSync(packsDir)) {
    const packDir = path.join(packsDir, entry)
    if (!fs.statSync(packDir).isDirectory()) continue

    try {
      const pack = loadPack(packDir)
      result.push({
        name: pack.manifest.name,
        path: packDir,
        engram_count: pack.engrams.length,
        manifest: pack.manifest,
        integrity: computePackHash(packDir),
      })
    } catch {
      const engramsPath = path.join(packDir, 'engrams.yaml')
      const engrams = fs.existsSync(engramsPath) ? loadEngrams(engramsPath) : []
      result.push({
        name: entry,
        path: packDir,
        engram_count: engrams.length,
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
  type: 'secret' | 'private_visibility' | 'personal_path' | 'email' | 'ip_address'
  detail: string
}

const PERSONAL_PATH_RE = /(?:\/Users\/\w+|\/home\/\w+|~\/|C:\\Users\\\w+)/
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/
const IP_RE = /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/

export function scanPrivacy(engrams: Engram[]): PrivacyScanResult {
  const issues: PrivacyIssue[] = []

  for (const e of engrams) {
    // Check visibility — private engrams should never be exported
    if (e.visibility === 'private') {
      issues.push({
        engram_id: e.id,
        type: 'private_visibility',
        detail: `Engram marked as private — skipped from export`,
      })
      continue
    }

    const text = `${e.statement} ${e.rationale ?? ''} ${e.source ?? ''}`

    // Secret patterns (API keys, passwords, tokens)
    const secrets = detectSecrets(text)
    for (const s of secrets) {
      issues.push({
        engram_id: e.id,
        type: 'secret',
        detail: `${s.pattern}: ${s.match}`,
      })
    }

    // Personal paths
    if (PERSONAL_PATH_RE.test(text)) {
      issues.push({
        engram_id: e.id,
        type: 'personal_path',
        detail: `Contains personal path: ${text.match(PERSONAL_PATH_RE)?.[0]}`,
      })
    }

    // Email addresses
    const emailMatch = text.match(EMAIL_RE)
    if (emailMatch) {
      issues.push({
        engram_id: e.id,
        type: 'email',
        detail: `Contains email: ${emailMatch[0]}`,
      })
    }

    // Private IP addresses
    const ipMatch = text.match(IP_RE)
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

  // Remove private and secret-containing engrams from export
  const blockedIds = new Set(
    allPrivacy.issues
      .filter(i => i.type === 'secret' || i.type === 'private_visibility')
      .map(i => i.engram_id)
  )
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

  // Write engrams
  const content = yaml.dump({ engrams: safeEngrams }, { lineWidth: 120, noRefs: true, quotingType: '"' })
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
 * Compute SHA256 hash of pack contents (SKILL.md + engrams.yaml).
 * Deterministic — same content always produces same hash.
 * Can be used as a content-addressable identifier (like Swarm hash).
 */
export function computePackHash(packDir: string): string {
  const hash = crypto.createHash('sha256')

  // Hash manifest
  const skillMd = path.join(packDir, 'SKILL.md')
  const manifestYaml = path.join(packDir, 'manifest.yaml')
  if (fs.existsSync(skillMd)) {
    hash.update(fs.readFileSync(skillMd))
  } else if (fs.existsSync(manifestYaml)) {
    hash.update(fs.readFileSync(manifestYaml))
  }

  // Hash engrams
  const engramsPath = path.join(packDir, 'engrams.yaml')
  if (fs.existsSync(engramsPath)) {
    hash.update(fs.readFileSync(engramsPath))
  }

  return hash.digest('hex')
}
