import type { Migration } from './types.js'
import type { Engram } from '../schemas/engram.js'

/**
 * Migration: Add engram_version: 1 and episode_ids: [] to all engrams.
 * SP2 Idea 8 (version lineage) + Idea 24 (episodic anchoring).
 */
export const migration: Migration = {
  id: '20260406-005-add-version-field',
  description: 'Add engram_version: 1 and episode_ids: [] to all engrams',
  up(engrams: Engram[]): Engram[] {
    return engrams.map(e => {
      const raw = e as any
      return {
        ...e,
        engram_version: raw.engram_version ?? 1,
        episode_ids: raw.episode_ids ?? [],
      } as Engram
    })
  },
  down(engrams: Engram[]): Engram[] {
    return engrams.map(e => {
      const raw = e as any
      const { engram_version, episode_ids, previous_version_ref, ...rest } = raw
      return rest as Engram
    })
  },
}
