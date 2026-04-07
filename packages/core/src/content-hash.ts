import { createHash } from 'crypto'

/**
 * Normalize a statement for hash comparison:
 * - lowercase
 * - collapse whitespace
 * - strip punctuation
 */
export function normalizeStatement(statement: string): string {
  return statement
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
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
