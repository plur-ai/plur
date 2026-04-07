import type { Migration } from './types.js'
import type { Engram } from '../schemas/engram.js'

/**
 * Migration: Add content_hash field.
 * Computes SHA256 of normalized statement for each engram.
 */
import { computeContentHash } from '../content-hash.js'

export const migration: Migration = {
  id: '20260406-002-add-content-hash',
  description: 'Add content_hash field (SHA256 of normalized statement)',
  up(engrams: Engram[]): Engram[] {
    return engrams.map(e => {
      const clone = { ...e } as any
      if (!clone.content_hash) {
        clone.content_hash = computeContentHash(e.statement)
      }
      return clone as Engram
    })
  },
  down(engrams: Engram[]): Engram[] {
    return engrams.map(e => {
      const clone = { ...e } as any
      delete clone.content_hash
      return clone as Engram
    })
  },
}
