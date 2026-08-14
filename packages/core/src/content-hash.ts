import { createHash } from 'crypto'

/**
 * Version of the normalizeStatement output contract.
 * v1: ASCII-only \w (bug — stripped diacritics and non-Latin scripts before hashing).
 * v2: Unicode-aware \p{L}\p{N}\p{M} — preserves accented/non-Latin characters correctly.
 * Bump on any change that alters normalized output; migration 20260813-006 recomputes
 * stored content_hash values when upgrading from v1.
 */
export const HASH_NORMALIZER_VERSION = 2

/**
 * Normalize a statement for hash comparison:
 * - lowercase
 * - collapse whitespace
 * - strip non-letter/digit/mark characters (Unicode-aware; fixes #896)
 */
export function normalizeStatement(statement: string): string {
  return statement
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Compute SHA256 content hash of a normalized statement.
 * Used for fast exact-duplicate detection (Idea 29).
 */
export function computeContentHash(statement: string): string {
  const normalized = normalizeStatement(statement)
  return createHash('sha256').update(normalized).digest('hex')
}
