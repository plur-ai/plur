/**
 * YAML-based EngramStore implementation.
 * Refactors existing loadEngrams/saveEngrams from engrams.ts into the store interface.
 * YAML is the DEFAULT store and source of truth.
 * For append(), does load+append+save (YAML cannot be truly appended).
 */
import { existsSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import * as yaml from 'js-yaml'
import { type Engram } from '../schemas/engram.js'
import { parseEngramFile } from '../engrams.js'
import { asyncAtomicWrite } from './async-fs.js'
import { withAsyncLock } from './async-lock.js'
import type { EngramStore } from './types.js'

export class YamlStore implements EngramStore {
  private filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async load(): Promise<Engram[]> {
    return (await this._read()).valid
  }

  async save(engrams: Engram[]): Promise<void> {
    await withAsyncLock(this.filePath, async () => {
      // Carry quarantined entries through, exactly as append/remove do.
      // Without this, `save(await load())` — the most natural way to use this
      // class — permanently deletes every schema-invalid record, because
      // `load()` withholds them by design. The preservation claim in the class
      // docs was true of append/remove and false here (#811 audit, finding 8).
      const { quarantined } = await this._read()
      const ids = new Set(engrams.map(e => e.id))
      const carried = (quarantined as Engram[]).filter(q => {
        const id = (q as { id?: unknown })?.id
        // A record the caller has since re-added properly must not come back
        // as a malformed duplicate.
        return !(typeof id === 'string' && ids.has(id))
      })
      const out = carried.length > 0 ? [...engrams, ...carried] : engrams
      const content = yaml.dump({ engrams: out }, { lineWidth: 120, noRefs: true, quotingType: '"' })
      await asyncAtomicWrite(this.filePath, content)
    })
  }

  async append(engram: Engram): Promise<void> {
    await withAsyncLock(this.filePath, async () => {
      // YAML cannot be truly appended — load, append, save
      const { valid, quarantined } = await this._read()
      const engrams = [...valid, engram, ...(quarantined as Engram[])]
      const content = yaml.dump({ engrams }, { lineWidth: 120, noRefs: true, quotingType: '"' })
      await asyncAtomicWrite(this.filePath, content)
    })
  }

  async getById(id: string): Promise<Engram | null> {
    const engrams = await this.load()
    return engrams.find(e => e.id === id) ?? null
  }

  async remove(id: string): Promise<boolean> {
    return await withAsyncLock(this.filePath, async () => {
      const { valid, quarantined } = await this._read()
      const idx = valid.findIndex(e => e.id === id)
      if (idx === -1) return false
      valid.splice(idx, 1)
      const engrams = [...valid, ...(quarantined as Engram[])]
      const content = yaml.dump({ engrams }, { lineWidth: 120, noRefs: true, quotingType: '"' })
      await asyncAtomicWrite(this.filePath, content)
      return true
    })
  }

  async count(filter?: { status?: string }): Promise<number> {
    const engrams = await this.load()
    if (filter?.status) {
      return engrams.filter(e => e.status === filter.status).length
    }
    return engrams.length
  }

  async close(): Promise<void> {
    // No resources to close for YAML
  }

  /**
   * Read and validate the store, throwing when it is unreadable.
   *
   * This class used to carry its own copy of the parse rules, and the copy went
   * stale: #766 hardened `loadEngrams` to throw on an unparseable file, and
   * this one kept catching and returning `[]` — after which `append`/`remove`
   * rewrote the file from that empty list (audit #794, F14). There is now one
   * definition of the rules, in `parseEngramFile`, and both readers use it.
   *
   * Quarantined entries are returned alongside the valid ones so the mutating
   * methods can write them back instead of dropping them.
   */
  private async _read(): Promise<{ valid: Engram[]; quarantined: unknown[] }> {
    if (!existsSync(this.filePath)) return { valid: [], quarantined: [] }
    const [content, info] = await Promise.all([
      readFile(this.filePath, 'utf8'),
      stat(this.filePath),
    ])
    if (info.isDirectory()) return { valid: [], quarantined: [] }
    return parseEngramFile(this.filePath, content, info.size)
  }
}
