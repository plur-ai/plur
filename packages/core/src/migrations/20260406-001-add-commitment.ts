import type { Migration } from './types.js'
import type { Engram } from '../schemas/engram.js'

/**
 * Migration: Add commitment field.
 * Sets existing active engrams to 'decided' (preserves current priority).
 * Non-active engrams get 'leaning' as default.
 */
export const migration: Migration = {
  id: '20260406-001-add-commitment',
  description: 'Add commitment field (default: decided for existing, leaning for new)',
  up(engrams: Engram[]): Engram[] {
    return engrams.map(e => {
      const clone = { ...e } as any
      if (!clone.commitment) {
        clone.commitment = e.status === 'active' ? 'decided' : 'leaning'
      }
      return clone as Engram
    })
  },
  down(engrams: Engram[]): Engram[] {
    return engrams.map(e => {
      const clone = { ...e } as any
      delete clone.commitment
      delete clone.locked_at
      delete clone.locked_reason
      return clone as Engram
    })
  },
}
