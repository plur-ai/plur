/**
 * Where provenance records are kept (#965).
 *
 * Deliberately separate from the code that builds them. Enterprise will store
 * records in a database later, and should be able to do that without touching
 * the generator. So the contract here is two operations and nothing else.
 *
 * Anchoring a record to Swarm or a blockchain is NOT part of this. That is a
 * separate step, and the Swarm provenance toolkit already covers it.
 */
import * as fs from 'node:fs'
import { join } from 'node:path'
import { logger } from './logger.js'

export interface ProvenanceStore {
  /** Save a record for an engram. Returns a reference that `get` accepts. */
  put(engramId: string, record: unknown): Promise<string>
  /** Read a record back. Returns undefined when there is none. */
  get(reference: string): Promise<unknown | undefined>
  /** References for one engram, newest first. Empty when there are none. */
  list(engramId: string): Promise<string[]>
}

/**
 * Records as files on disk, the default.
 *
 * One directory per engram, one file per record, named by the time it was
 * written. Records accumulate rather than overwrite: a record is a snapshot of
 * state that keeps changing, so a later one does not make an earlier one wrong.
 */
export class FileProvenanceStore implements ProvenanceStore {
  constructor(private readonly root: string) {}

  private dirFor(engramId: string): string {
    // Engram identifiers are constrained to ^(ENG|ABS|META)-[A-Za-z0-9-]+$ by
    // the schema, so they cannot climb out of the directory. Belt and braces
    // anyway, because this builds a filesystem path.
    const safe = engramId.replace(/[^A-Za-z0-9-]/g, '_')
    return join(this.root, 'provenance', safe)
  }

  async put(engramId: string, record: unknown): Promise<string> {
    const dir = this.dirFor(engramId)
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const path = join(dir, `${stamp}.jsonld`)
    fs.writeFileSync(path, JSON.stringify(record, null, 2) + '\n', 'utf8')
    return path
  }

  async get(reference: string): Promise<unknown | undefined> {
    try {
      return JSON.parse(fs.readFileSync(reference, 'utf8'))
    } catch (err) {
      logger.debug?.(`provenance record unreadable at ${reference}: ${String(err)}`)
      return undefined
    }
  }

  async list(engramId: string): Promise<string[]> {
    const dir = this.dirFor(engramId)
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.jsonld'))
      .sort()
      .reverse()
      .map(f => join(dir, f))
  }
}

/** Records in memory, for tests. Nothing reaches disk. */
export class MemoryProvenanceStore implements ProvenanceStore {
  private readonly byEngram = new Map<string, string[]>()
  private readonly byRef = new Map<string, unknown>()
  private seq = 0

  async put(engramId: string, record: unknown): Promise<string> {
    const ref = `memory:${engramId}:${this.seq++}`
    this.byRef.set(ref, record)
    this.byEngram.set(engramId, [ref, ...(this.byEngram.get(engramId) ?? [])])
    return ref
  }

  async get(reference: string): Promise<unknown | undefined> {
    return this.byRef.get(reference)
  }

  async list(engramId: string): Promise<string[]> {
    return this.byEngram.get(engramId) ?? []
  }
}

/**
 * When to write a provenance record (#966).
 *
 * The config schema is `.partial()`, so an absent key yields undefined rather
 * than a default. The default therefore lives here, in one place, instead of
 * being re-derived at each call site with a different fallback.
 *
 * `never` is the default. A record per engram duplicates the history log, and
 * the trust boundary is the moment an engram leaves, not the moment it is
 * written.
 */
export type ProvenanceMode = 'never' | 'on_export' | 'always'

export function provenanceMode(config: unknown): ProvenanceMode {
  const mode = (config as { provenance?: { generate?: unknown } } | undefined)?.provenance?.generate
  return mode === 'always' || mode === 'on_export' ? mode : 'never'
}
