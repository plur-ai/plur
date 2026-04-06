import type { Migration } from './types.js'
import type { Engram } from '../schemas/engram.js'

/**
 * Migration: Populate knowledge_type.memory_class based on engram type.
 * Stub — will be populated by SP3 (Knowledge Taxonomy).
 * Maps: behavioral → semantic, procedural → procedural, etc.
 */
export const migration: Migration = {
  id: '20260406-003-populate-memory-class',
  description: 'Populate existing knowledge_type.memory_class based on type',
  up(engrams: Engram[]): Engram[] {
    // Stub: SP3 will populate this with actual logic
    return engrams
  },
  down(engrams: Engram[]): Engram[] {
    // Stub: SP3 will populate this with actual rollback logic
    return engrams
  },
}
