import * as fs from 'fs'
import * as path from 'path'
import yaml from 'js-yaml'
import { loadPack, loadEngrams } from './engrams.js'
import type { Engram } from './schemas/engram.js'
import type { PackManifest } from './schemas/pack.js'
import { logger } from './logger.js'

export { loadAllPacks } from './engrams.js'

export interface InstallResult {
  installed: number
  name: string
}

export function installPack(packsDir: string, source: string): InstallResult {
  // Source can be a directory path
  if (!fs.existsSync(source)) throw new Error(`Pack source not found: ${source}`)

  const sourceName = path.basename(source)
  const destDir = path.join(packsDir, sourceName)

  // Copy pack directory
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true })

  const files = fs.readdirSync(source)
  let copied = 0
  for (const file of files) {
    const srcPath = path.join(source, file)
    const destPath = path.join(destDir, file)
    if (fs.statSync(srcPath).isFile()) {
      fs.copyFileSync(srcPath, destPath)
      copied++
    }
  }

  // Count engrams
  const engramsPath = path.join(destDir, 'engrams.yaml')
  const engrams = fs.existsSync(engramsPath) ? loadEngrams(engramsPath) : []

  return { installed: engrams.length, name: sourceName }
}

export interface PackInfo {
  name: string
  path: string
  engram_count: number
  manifest?: PackManifest
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
      })
    } catch {
      // Count engrams directly if manifest fails
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

export interface ExportResult {
  path: string
  engram_count: number
}

export function exportPack(
  engrams: Engram[],
  outputDir: string,
  manifest: { name: string; version: string; description?: string; creator?: string },
): ExportResult {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })

  // Write manifest as SKILL.md frontmatter
  const frontmatter = yaml.dump({
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    creator: manifest.creator,
    metadata: {
      injection_policy: 'on_match',
      match_terms: [],
      engram_count: engrams.length,
    },
  })
  fs.writeFileSync(
    path.join(outputDir, 'SKILL.md'),
    `---\n${frontmatter}---\n\n# ${manifest.name}\n\n${manifest.description || ''}\n`
  )

  // Write engrams
  const content = yaml.dump({ engrams }, { lineWidth: 120, noRefs: true, quotingType: '"' })
  fs.writeFileSync(path.join(outputDir, 'engrams.yaml'), content)

  return { path: outputDir, engram_count: engrams.length }
}
