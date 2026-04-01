import * as fs from 'fs'
import * as yaml from 'js-yaml'
import { EngramSchema, type Engram } from './schemas/engram.js'
import { PackManifestSchema, type PackManifest } from './schemas/pack.js'
import { logger } from './logger.js'
import { atomicWrite } from './sync.js'

export function loadEngrams(filePath: string): Engram[] {
  if (!fs.existsSync(filePath)) return []
  try {
    const raw = yaml.load(fs.readFileSync(filePath, 'utf8')) as any
    if (!raw?.engrams || !Array.isArray(raw.engrams)) return []
    const valid: Engram[] = []
    let skipped = 0
    for (const entry of raw.engrams) {
      const result = EngramSchema.safeParse(entry)
      if (result.success) valid.push(result.data)
      else skipped++
    }
    if (skipped > 0) logger.warning(`Skipped ${skipped} invalid engram(s) in ${filePath}`)
    return valid
  } catch (err) {
    logger.error(`Failed to parse engrams file ${filePath}: ${err}`)
    return []
  }
}

export function saveEngrams(filePath: string, engrams: Engram[]): void {
  const content = yaml.dump({ engrams }, { lineWidth: 120, noRefs: true, quotingType: '"' })
  atomicWrite(filePath, content)
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

  let rawManifest: Record<string, any>
  if (fs.existsSync(skillMdPath)) {
    rawManifest = parseSkillMdFrontmatter(skillMdPath)
  } else if (fs.existsSync(manifestYamlPath)) {
    rawManifest = yaml.load(fs.readFileSync(manifestYamlPath, 'utf8')) as Record<string, any>
  } else {
    throw new Error(`No SKILL.md or manifest.yaml found in ${packDir}`)
  }

  const manifest = PackManifestSchema.parse(rawManifest)
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

export function generateEngramId(existing: Engram[]): string {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, '')
  const prefix = `ENG-${date.slice(0, 4)}-${date.slice(4)}-`
  const existingNums = existing
    .filter(e => e.id.startsWith(prefix))
    .map(e => parseInt(e.id.slice(prefix.length), 10))
    .filter(n => !isNaN(n))
  const next = existingNums.length > 0 ? Math.max(...existingNums) + 1 : 1
  return `${prefix}${String(next).padStart(3, '0')}`
}
