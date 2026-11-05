import type { Migration } from './types.js'
import type { Engram } from '../schemas/engram.js'
import { computeContentHash, isHashable } from '../content-hash.js'

/**
 * Recompute `content_hash` under the Unicode-aware normalizer (v2), folding
 * `Plur.repairContentHashes` into `plur migrate` (corpus lock, backup, rollback).
 * MUST agree with `repairContentHashes` — change these rules together or not at all:
 * 1. Skip statement-less rows.
 * 2. Skip unhashable statements (normalize to empty; they would all share SHA-256("")).
 *    An existing SHA-256("") value is left in place — every matcher ignores it.
 * 3. Only rewrite when the value changes (ASCII statements hash identically under v1/v2).
 * down() is a no-op: v1 hashes were wrong and cannot be recovered from v2.
 */
export const migration: Migration = {
  id: '20260813-006-recompute-content-hashes',
  description: 'Recompute content_hash with the Unicode-aware normalizer',
  up(engrams: Engram[]): Engram[] {
    return engrams.map(e => {
      if (!e.statement || !isHashable(e.statement)) return e
      const correct = computeContentHash(e.statement)
      if ((e as { content_hash?: string }).content_hash === correct) return e
      return { ...e, content_hash: correct } as Engram
    })
  },
  down(engrams: Engram[]): Engram[] {
    return engrams
  },
}
