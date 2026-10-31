import { createHash } from 'crypto'

/**
 * Normalize a statement for hash comparison: lowercase, strip punctuation,
 * collapse whitespace. Unicode-aware (`\p{L}\p{N}\p{M}_`), not ASCII `\w`,
 * which would empty non-Latin statements and merge them in dedup.
 */
/**
 * Version of the `normalizeStatement` output contract (v1: ASCII `\w`; v2: the
 * Unicode class). Bump on any change to non-empty normalized output, with a
 * migration: stored `content_hash` values go stale (`plur reindex-hashes`).
 */
export const HASH_NORMALIZER_VERSION = 2

const NON_WORD = /[^\p{L}\p{N}\p{M}_\s]/gu

export function normalizeStatement(statement: string): string {
  return statement
    .toLowerCase()
    .replace(NON_WORD, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Compute SHA256 content hash of a normalized statement.
 * Used for fast exact-duplicate detection.
 *
 * A statement that normalizes to the empty string (all punctuation, all emoji)
 * hashes to the SHA-256 of `''`, shared by every such statement, so the value
 * is not usable for dedup. Callers that write or match on hashes must treat
 * "normalizes to empty" as "no hash"; see {@link isHashable} and
 * `Plur.repairContentHashes`.
 */
export function computeContentHash(statement: string): string {
  const normalized = normalizeStatement(statement)
  return createHash('sha256').update(normalized).digest('hex')
}

/**
 * Whether a statement has enough content for its hash to identify it.
 *
 * False only for statements that normalize away entirely.
 */
export function isHashable(statement: string): boolean {
  return normalizeStatement(statement).length > 0
}
