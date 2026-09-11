/** Allocation is durable state, independent of corpus retention and diagnostic
 * history. Reserve before publishing a row; a failed write may leave a gap,
 * but compaction, restart and another process can never recycle that identity. */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateEngramId } from '../engrams.js'
import { mintedIdsWithPrefix } from '../history.js'
import type { Engram } from '../schemas/engram.js'
import { atomicWrite, fsyncDir, withLock } from '../sync.js'

export function legacyAllocatedIds(root: string, now: Date): string[] {
  const day = now.toISOString().slice(0, 10)
  return mintedIdsWithPrefix(root, day.slice(0, 7), [
    `ENG-${day}-`, `ENG-${day.slice(0, 4)}-${day.slice(5, 7)}${day.slice(8, 10)}-`,
  ])
}

export function reserveLocalEngramId(root: string, existing: Engram[]): string {
  const now = new Date()
  const day = now.toISOString().slice(0, 10)
  const directory = join(root, 'state', 'id-allocations')
  const created = mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (created) {
    // A durable leaf file also needs the new state/directory entries to exist
    // after a power failure. The Plur storage root is already established.
    fsyncDir(join(root, 'state'))
    fsyncDir(root)
  }
  const path = join(directory, `${day}.json`)
  return withLock(path, () => {
    let allocated: string[]
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      if (!raw || typeof raw.id !== 'string' || !new RegExp(`^ENG-${day}-[0-9]{3,}$`).test(raw.id)) {
        throw new Error('Invalid allocation state')
      }
      allocated = [raw.id]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read durable ID allocation state; repair it before writing')
      // Upgrade seed only. After the first reservation, history is diagnostic
      // and may disappear without releasing any post-upgrade identities.
      allocated = legacyAllocatedIds(root, now)
    }
    const id = generateEngramId(existing, allocated, now)
    atomicWrite(path, JSON.stringify({ id }), { mode: 0o600 })
    return id
  })
}
