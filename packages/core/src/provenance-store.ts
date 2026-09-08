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
import { join, resolve, sep } from 'node:path'
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
/**
 * A record's content, with the moment it was written removed.
 *
 * Every record stamps its own generation time, so two records that say exactly
 * the same thing about the same engram never match byte for byte. Comparing raw
 * bytes would make the identical-record check dead code that always writes.
 * What matters is whether the SUBSTANCE changed, not when it was restated.
 */
function substance(body: string): string {
  try {
    const doc = JSON.parse(body)
    for (const node of doc['@graph'] ?? []) {
      const type = node['@type']
      if (Array.isArray(type) && type.includes('prov:Bundle')) delete node['prov:generatedAtTime']
    }
    return JSON.stringify(doc)
  } catch {
    // Unparseable on disk: treat it as different, so a new record gets written
    // rather than a corrupt one being silently kept.
    return body
  }
}

export class FileProvenanceStore implements ProvenanceStore {
  /**
   * `subdir` is `config.provenance.path`. It was declared with a default of
   * 'provenance' and read nowhere, so the setting was documented but inert —
   * the directory name was hardcoded below. Threading it through here is what
   * makes the config key mean something; the default keeps every existing
   * store on the same path it already uses.
   */
  /** Where records go: `root/<subdir>`, checked to be inside `root`. */
  private readonly base: string

  constructor(private readonly root: string, subdir: string = 'provenance') {
    // The configured subdirectory is arbitrary operator-supplied text. It used
    // to be sanitised by character class, which kept `.` and so let `..` through
    // untouched: `provenance.path: ".."` wrote every record one level ABOVE the
    // store. Containment is decided on the RESOLVED path instead, the way the
    // pack installer decides it (`resolveInside` in packs.ts): whatever the text
    // is, the only question is whether it ends up strictly inside the root.
    const base = resolve(root)
    const candidate = resolve(base, subdir.trim() || 'provenance')
    if (candidate === base || !candidate.startsWith(base + sep)) {
      throw new Error(
        `[plur] refusing provenance.path "${subdir}": records must live in a directory inside the store `
        + `(${base}), and this one resolves to ${candidate}. Use a relative name such as "provenance".`,
      )
    }
    this.base = candidate
  }

  private dirFor(engramId: string): string {
    // Engram identifiers are constrained to ^(ENG|ABS|META)-[A-Za-z0-9-]+$ by
    // the schema, so they cannot climb out of the directory. Belt and braces
    // anyway, because this builds a filesystem path.
    const safe = engramId.replace(/[^A-Za-z0-9-]/g, '_')
    return join(this.base, safe)
  }

  async put(engramId: string, record: unknown): Promise<string> {
    const dir = this.dirFor(engramId)
    fs.mkdirSync(dir, { recursive: true })
    const body = JSON.stringify(record, null, 2) + '\n'

    // Records are kept as a timestamped series, because a record made before an
    // engram was revised genuinely differs from one made after. An IDENTICAL
    // record is not a version — it is the same answer asked for twice. A tester
    // ran the command five times and got five identical files, which turns a
    // useful history into a directory nobody trusts.
    const newest = this.newestIn(dir)
    if (newest && substance(fs.readFileSync(newest, 'utf8')) === substance(body)) return newest

    // Two records written in the same millisecond would otherwise land on the
    // same filename, and the second would silently overwrite the first. That
    // loses a real version rather than a duplicate, so disambiguate instead.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    let path = join(dir, `${stamp}.jsonld`)
    for (let n = 2; fs.existsSync(path); n++) path = join(dir, `${stamp}-${n}.jsonld`)
    fs.writeFileSync(path, body, 'utf8')
    return path
  }

  /** Newest record already on disk for this engram, by filename. */
  private newestIn(dir: string): string | undefined {
    if (!fs.existsSync(dir)) return undefined
    // Filenames are ISO timestamps, so a plain sort is chronological — except
    // for the "-2", "-3" suffixes added on a same-millisecond collision, which
    // sort correctly among themselves but ahead of the unsuffixed name. Compare
    // on modification time, which is right in every case.
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonld'))
    if (!files.length) return undefined
    return files
      .map(f => join(dir, f))
      .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
      .pop()
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
