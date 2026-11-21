import * as fs from 'fs'
import yaml from 'js-yaml'
import * as path from 'path'
import { loadEngrams, saveEngrams } from '../engrams.js'
import type { Engram } from '../schemas/engram.js'
import type { PackManifest } from '../schemas/pack.js'
import { fsyncDir } from '../atomic-write.js'
import { sanitizePackEngrams } from './privacy.js'


/**
 * Serialize a parsed manifest back to SKILL.md content (frontmatter + body).
 * Used to auto-upgrade a deprecated `manifest.yaml` pack to the canonical
 * SKILL.md form on install. 1:1 with PackManifestSchema, so it re-parses.
 */
export function manifestToSkillMd(m: PackManifest): string {
  const fm: Record<string, unknown> = { name: m.name, version: m.version }
  if (m.description) fm.description = m.description
  if (m.creator) fm.creator = m.creator
  if (m.license) fm.license = m.license
  if (m.tags && m.tags.length) fm.tags = m.tags
  if (m.metadata) fm.metadata = m.metadata
  const legacy = (m as Record<string, unknown>)['x-datacore']
  if (legacy) fm['x-datacore'] = legacy
  // Unknown root fields survive the upgrade too (§10.3 rule 2). The schema
  // passes them through; dropping them here would make the one path that
  // rewrites a manifest the one path that loses what the producer wrote.
  //
  // `Object.hasOwn`, not `k in fm`: `in` walks the prototype chain, so a
  // producer field literally named `constructor`, `toString`, `valueOf` or
  // `hasOwnProperty` would read as already-present and be dropped.
  for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
    if (!Object.hasOwn(fm, k) && !KNOWN_MANIFEST_KEYS.has(k)) fm[k] = v
  }
  return `---\n${yaml.dump(fm)}---\n\n# ${m.name}\n\n${m.description ?? ''}\n`
}


/** Keys the manifest schema declares; everything else is a producer's own. */
export const KNOWN_MANIFEST_KEYS = new Set(['name', 'version', 'description', 'creator', 'license', 'tags', 'metadata', 'x-datacore'])


/**
 * fsync every file in a staged pack, then the directory itself.
 *
 * Best-effort per entry, like `fsyncDir`: a filesystem that cannot fsync a
 * directory must not fail an otherwise good install. Packs are small (a
 * manifest and an engrams file), so this is a handful of syscalls, paid once
 * manifest and an engrams file), so this is a handful of syscalls, paid once
 * per install, to stop a crash leaving a durable registry entry pointing at
 * content that never reached the disk.
 */
export function fsyncTree(dir: string): void {
  let entries: string[]
  try { entries = fs.readdirSync(dir) } catch { return }
  for (const name of entries) {
    const p = path.join(dir, name)
    try {
      if (fs.statSync(p).isDirectory()) { fsyncTree(p); continue }
      const fd = fs.openSync(p, 'r')
      try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    } catch { /* unreadable or unsupported: skip */ }
  }
  try { fsyncDir(dir) } catch { /* not a syncable directory */ }
}


/**
 * The transformations install applies to a staged copy before hashing it: a
 * deprecated `manifest.yaml`-only pack is upgraded to `SKILL.md`, and
 * host-overriding engram fields are neutralized (§5.6.1 step 3). Mutates
 * `dir`. Shared by install and by `migratePackIntegrity`, which must reproduce
 * the installed form of a source byte for byte to re-verify against it.
 */
export function normalizeStagedPack(dir: string, manifest: PackManifest): {
  upgradedManifest: boolean
  engrams: Engram[]
  sanitized: ReturnType<typeof sanitizePackEngrams>
} {
  const skillMd = path.join(dir, 'SKILL.md')
  const manifestYaml = path.join(dir, 'manifest.yaml')
  let upgradedManifest = false
  if (!fs.existsSync(skillMd) && fs.existsSync(manifestYaml)) {
    fs.writeFileSync(skillMd, manifestToSkillMd(manifest))
    fs.rmSync(manifestYaml)
    upgradedManifest = true
  }
  const engramsPath = path.join(dir, 'engrams.yaml')
  let engrams = fs.existsSync(engramsPath) ? loadEngrams(engramsPath) : []
  const sanitized = sanitizePackEngrams(engrams)
  if (sanitized.changed) {
    engrams = sanitized.engrams
    saveEngrams(engramsPath, engrams)
  }
  return { upgradedManifest, engrams, sanitized }
}
