import type { Migration } from './types.js'
import type { Engram } from '../schemas/engram.js'

/**
 * Migration: Add content_hash field.
 * Stub — will be populated by SP2 (Content Deduplication).
 * Computes SHA256 of normalized statement for each engram.
 */
export const migration: Migration = {
  id: '20260406-002-add-content-hash',
  description: 'Add content_hash field (SHA256 of normalized statement)',
  up(engrams: Engram[]): Engram[] {
    // Stub: SP2 will populate this with actual logic
    return engrams
  },
  down(engrams: Engram[]): Engram[] {
    // Stub: SP2 will populate this with actual rollback logic
    return engrams
  },
}
