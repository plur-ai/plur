import * as fs from 'fs'
import * as path from 'path'
import { computePackHash } from './packs.js'

/**
 * Pack integrity checksum per ENGRAM-STANDARD-v1.md §5.5:
 *
 *   H = SHA256( bytes(SKILL.md) || bytes(engrams.yaml) )
 *
 * Delegates to {@link computePackHash} so there is a SINGLE §5.5 hashing
 * implementation (#316). Knowledge packs MUST ship a SKILL.md; there is no
 * `manifest.yaml` fallback (the divergence this once had — a manifest-only pack
 * hashing only `engrams.yaml` — is gone because manifest-only packs are rejected
 * by loadPack and not hashed against manifest.yaml here).
 *
 * Keeps the `null`-on-empty contract: a directory with neither a SKILL.md nor an
 * `engrams.yaml` has no content to attest, so verification callers get `null`
 * rather than the hash of an empty input.
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
