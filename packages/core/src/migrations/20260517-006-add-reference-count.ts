import type { Migration } from './types.js'
import type { Engram } from '../schemas/engram.js'

/**
 * Migration: Add reference_count and sources fields (#107).
 * Backfills reference_count=1 and sources=[] on all existing engrams.
 * Duplicate detection during backfill is not in scope here — handled by
 * the startup hash-dedup path in learn().
 */
export const migration: Migration = {
  id: '20260517-006-add-reference-count',
  description: 'Add reference_count and sources fields for content-addressed deduplication (#107)',
  up(engrams: Engram[]): Engram[] {
    return engrams.map(e => {
      const clone = { ...e } as any
      if (clone.reference_count === undefined || clone.reference_count === null) {
        clone.reference_count = 1
      }
      if (clone.sources === undefined || clone.sources === null) {
        clone.sources = []
      }
      return clone as Engram
    })
  },
  down(engrams: Engram[]): Engram[] {
    return engrams.map(e => {
      const clone = { ...e } as any
      delete clone.reference_count
      delete clone.sources
      return clone as Engram
    })
  },
}
