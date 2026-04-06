/**
 * YAML-based EngramStore implementation.
 * Refactors existing loadEngrams/saveEngrams from engrams.ts into the store interface.
 * YAML is the DEFAULT store and source of truth.
 * For append(), does load+append+save (YAML cannot be truly appended).
 */
import { existsSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import * as yaml from 'js-yaml'
import { EngramSchemaPassthrough, type Engram } from '../schemas/engram.js'
import { logger } from '../logger.js'
import { asyncAtomicWrite } from './async-fs.js'
import { withAsyncLock } from './async-lock.js'
import type { EngramStore } from './types.js'

export class YamlStore implements EngramStore {
  private filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async load(): Promise<Engram[]> {
    if (!existsSync(this.filePath)) return []
    try {
      const content = await readFile(this.filePath, 'utf8')
      const raw = yaml.load(content) as any
      if (!raw?.engrams || !Array.isArray(raw.engrams)) return []
      const valid: Engram[] = []
      let skipped = 0
      for (const entry of raw.engrams) {
        const result = EngramSchemaPassthrough.safeParse(entry)
        if (result.success) valid.push(result.data)
        else skipped++
      }
      if (skipped > 0) logger.warning(`Skipped ${skipped} invalid engram(s) in ${this.filePath}`)
      return valid
    } catch (err) {
      logger.error(`Failed to parse engrams file ${this.filePath}: ${err}`)
      return []
    }
  }

  async save(engrams: Engram[]): Promise<void> {
    await withAsyncLock(this.filePath, async () => {
      const content = yaml.dump({ engrams }, { lineWidth: 120, noRefs: true, quotingType: '"' })
      await asyncAtomicWrite(this.filePath, content)
    })
  }

  async append(engram: Engram): Promise<void> {
    await withAsyncLock(this.filePath, async () => {
      // YAML cannot be truly appended — load, append, save
      const engrams = await this._loadRaw()
      engrams.push(engram)
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
      const engrams = await this._loadRaw()
      const idx = engrams.findIndex(e => e.id === id)
      if (idx === -1) return false
      engrams.splice(idx, 1)
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

  /** Raw load without validation — for internal mutate-and-save operations. */
  private async _loadRaw(): Promise<Engram[]> {
    if (!existsSync(this.filePath)) return []
    try {
      const content = await readFile(this.filePath, 'utf8')
      const raw = yaml.load(content) as any
      if (!raw?.engrams || !Array.isArray(raw.engrams)) return []
      const valid: Engram[] = []
      for (const entry of raw.engrams) {
        const result = EngramSchemaPassthrough.safeParse(entry)
        if (result.success) valid.push(result.data)
      }
      return valid
    } catch {
      return []
    }
  }
}
