import type { Migration } from './types.js'
import type { Engram } from '../schemas/engram.js'

/**
 * Migration: Add commitment field.
 * Stub — will be populated by SP1 (Commitment Levels).
 * Default: 'decided' for existing engrams, 'leaning' for new ones.
 */
export const migration: Migration = {
  id: '20260406-001-add-commitment',
  description: 'Add commitment field (default: decided for existing, leaning for new)',
  up(engrams: Engram[]): Engram[] {
    // Stub: SP1 will populate this with actual logic
    return engrams
  },
  down(engrams: Engram[]): Engram[] {
    // Stub: SP1 will populate this with actual rollback logic
    return engrams
  },
}
