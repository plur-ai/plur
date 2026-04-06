import type { Migration } from './types.js'
import type { Engram } from '../schemas/engram.js'

/**
 * Migration: Populate knowledge_type.cognitive_level based on engram type.
 * Stub — will be populated by SP3 (Knowledge Taxonomy).
 * Maps: behavioral → apply, terminological → remember, etc.
 */
export const migration: Migration = {
  id: '20260406-004-populate-cognitive-level',
  description: 'Populate existing knowledge_type.cognitive_level based on type',
  up(engrams: Engram[]): Engram[] {
    // Stub: SP3 will populate this with actual logic
    return engrams
  },
  down(engrams: Engram[]): Engram[] {
    // Stub: SP3 will populate this with actual rollback logic
    return engrams
  },
}
