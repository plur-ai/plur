import type { Migration } from './types.js'
import type { Engram } from '../schemas/engram.js'

/**
 * Migration: Add version: 1 to all engrams that lack it.
 * Stub — will be populated by SP history tracking.
 * Ensures all engrams have a version field for change tracking.
 */
export const migration: Migration = {
  id: '20260406-005-add-version-field',
  description: 'Add version: 1 to all engrams',
  up(engrams: Engram[]): Engram[] {
    // Stub: will be populated with actual logic
    return engrams
  },
  down(engrams: Engram[]): Engram[] {
    // Stub: will be populated with actual rollback logic
    return engrams
  },
}
