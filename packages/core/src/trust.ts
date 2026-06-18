import * as fs from 'fs'
import * as path from 'path'
import { computePackHash } from './packs.js'

/**
 * Pack integrity checksum per ENGRAM-STANDARD-v1.md §5.5:
 *   H = SHA256( bytes(SKILL.md) || bytes(engrams.yaml) )
 *
 * Delegates to {@link computePackHash} so there is a SINGLE §5.5 hashing
 * implementation (#316/#325) — the two helpers cannot drift. SKILL.md is the
 * canonical manifest; manifest.yaml is deprecated and does not enter the hash.
 *
 * Keeps the `null`-on-empty contract: a directory with neither a SKILL.md nor an
 * `engrams.yaml` has no content to attest, so callers get `null` rather than the
 * hash of an empty input.
 */
export function computePackChecksum(packDir: string): string | null {
  const hasContent =
    fs.existsSync(path.join(packDir, 'SKILL.md')) ||
    fs.existsSync(path.join(packDir, 'engrams.yaml'))
  if (!hasContent) return null
  return computePackHash(packDir)
}

export function verifyPackChecksum(packDir: string, expected: string): { valid: boolean; actual: string | null } {
  const actual = computePackChecksum(packDir)
  return { valid: actual === expected, actual }
}
