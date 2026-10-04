/**
 * R2-Retrieval NEEDS-FILE, applied by R2-CoreA (spec/formal/findings/r2-retrieval.md
 * item 4 residual): importer dry-run parity on a DELEGATING primary store
 * (Postgres/PGLite shape: the duplicate check runs in the store).
 *
 * learn() on such a store checks the primary store for the SAME scope only, so a
 * statement stored under a different scope is imported by the real run — but the
 * dry run's scope-blind hash map reported it `skipped`. `Plur.wouldDeduplicate()`
 * answers with learn()'s own dedup code path; the dry run uses it.
 *
 * In-memory store with the delegation seams; no network.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Plur } from '../src/index.js'
import { runImport } from '../src/importers/engine.js'
import type { Engram } from '../src/schemas/engram.js'

class DelegatingStore {
  readonly kind = 'memory' as const
  readonly location = null
  rows: Engram[] = []
  async load() { return this.rows.map(e => structuredClone(e)) }
  async loadCached() { return this.load() }
  async save(es: Engram[]) { this.rows = es.map(e => structuredClone(e)) }
  invalidate() {}
  async append(e: Engram) { this.rows.push(structuredClone(e)) }
  async updateMany(es: Engram[]) {
    for (const e of es) {
      const i = this.rows.findIndex(r => r.id === e.id)
      if (i === -1) this.rows.push(structuredClone(e)); else this.rows[i] = structuredClone(e)
    }
  }
  async loadByIds(ids: string[]) { return this.rows.filter(e => ids.includes(e.id)).map(e => structuredClone(e)) }
  async findActiveByContentHash(h: string, s: string) {
    const x = this.rows.find(e => e.status === 'active' && (e as any).content_hash === h && e.scope === s)
    return x ? structuredClone(x) : null
  }
  async nextEngramId(p: string) {
    const n = this.rows.filter(e => e.id.startsWith(p)).length + 1
    return `${p}${String(n).padStart(3, '0')}`
  }
}

const dirs: string[] = []
const fresh = async (store?: DelegatingStore) => {
  const d = mkdtempSync(join(tmpdir(), 'plur-r2corea-imp-'))
  dirs.push(d)
  const p = new Plur({ path: d, ...(store ? { store } : {}), autoDiscover: false } as any)
  await p.learn('Run the linter before every commit', { scope: 'project:a' })
  return p
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

const records = [{ statement: 'Run the linter before every commit' }]

describe('importer dry run predicts the real run on every backend', () => {
  it('delegating store: a statement stored under another scope — dry run agrees with the real run', async () => {
    const dry = await runImport(await fresh(new DelegatingStore()), records, { from: 'generic', dryRun: true, scope: 'project:b' })
    const real = await runImport(await fresh(new DelegatingStore()), records, { from: 'generic', scope: 'project:b' })
    expect(real.imported).toBe(1)
    expect([dry.imported, dry.skipped]).toEqual([real.imported, real.skipped])
  })

  // A personal scope: #1268 decision A1 never absorbs a team (project:*) save.
  it('YAML store: the same case is skipped in both (cross-scope recurrence)', async () => {
    const dry = await runImport(await fresh(), records, { from: 'generic', dryRun: true, scope: 'user:b' })
    const real = await runImport(await fresh(), records, { from: 'generic', scope: 'user:b' })
    expect(real.skipped).toBe(1)
    expect([dry.imported, dry.skipped]).toEqual([real.imported, real.skipped])
  })

  it('wouldDeduplicate names the engram a same-scope learn() would resolve to', async () => {
    const plur = await fresh(new DelegatingStore())
    const [existing] = await plur.list()
    expect(await plur.wouldDeduplicate('Run the linter before every commit', { scope: 'project:a' })).toBe(existing.id)
    expect(await plur.wouldDeduplicate('Something never learned', { scope: 'project:a' })).toBeNull()
  })
})
