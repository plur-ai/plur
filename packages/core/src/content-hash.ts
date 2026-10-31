import { createHash } from 'crypto'

/**
 * Normalize a statement for hash comparison:
 * - lowercase
 * - strip punctuation
 * - collapse whitespace
 *
 * The character class is Unicode-aware (`\p{L}\p{N}\p{M}`: letters, numbers
 * and combining marks in any script), not ASCII `\w`. With `\w`, every
 * statement in a non-Latin script normalizes to the empty string, so unrelated
 * statements share one hash and get merged by dedup. `\p{M}` matters on its
 * own: without it, Devanagari and Thai vowel signs are stripped from words
 * whose consonants survive, merging distinct words. `_` is kept so
 * `snake_case` identifiers are preserved.
 *
 * For ASCII letters, digits, `_` and punctuation the output equals the ASCII
 * `\w` version. Any other letter hashes differently from a hash stored under
 * that version; `plur reindex-hashes` repairs stale stored hashes.
 */
/**
 * Version of the `normalizeStatement` output contract.
 *
 * v1 — ASCII `\w`; stripped diacritics and every non-Latin script.
 * v2 — `\p{L}\p{N}\p{M}_`; preserves them.
 *
 * Bump this on any change that alters normalized output for a statement that
 * normalized to something non-empty, and add a migration alongside it: every
 * stored `content_hash` written under the old contract becomes stale, and
 * nothing else in the store records which contract it was written under.
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
