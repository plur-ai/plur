/**
 * Audit of #1228, finding 2 (LOW, regression): a PATH-store row whose id
 * already carries the store prefix (ENG-GPL-… in a group:plur/eng store — a
 * row that came from another client, a sync, or an export) must stay
 * reachable. Namespacing on load is idempotent now, so the loaded id IS the
 * stored id; `_findEngramStore` stripped the prefix once and looked for the
 * bare id, which is not in the file → forget said "Engram not found", and
 * `_hitHolder` called the row readonly, so Decision A stored a duplicate
 * instead of counting the recurrence against it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import yaml from 'js-yaml'
import { Plur, computeContentHash } from '../src/index.js'
import { storePrefix } from '../src/engrams.js'

const SCOPE = 'group:plur/eng'
const P = storePrefix(SCOPE)
const PREFIXED = `ENG-${P}-2026-09-01-001`

function row(id: string, statement: string) {
  return {
    id, version: 2, status: 'active', consolidated: false, type: 'behavioral',
    scope: SCOPE, visibility: 'public', statement,
    activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 0, last_accessed: '2026-09-01' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    associations: [], derivation_count: 1, tags: [], pack: null, abstract: null,
    derived_from: null, reference_count: 1, sources: [],
    content_hash: computeContentHash(statement),
  }
}

describe('audit #1228 finding 2 — a path-store row whose stored id carries the store prefix', () => {
  let dir: string
  let storeDir: string
  let storePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-audit-prefixed-'))
    storeDir = mkdtempSync(join(tmpdir(), 'plur-audit-prefixed-store-'))
    storePath = join(storeDir, 'engrams.yaml')
    writeFileSync(storePath, yaml.dump({ engrams: [row(PREFIXED, 'the engineering team deploys on tuesdays only')] }))
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ path: storePath, scope: SCOPE, readonly: false }],
      index: false,
    }))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(storeDir, { recursive: true, force: true })
  })

  const stored = () => (yaml.load(readFileSync(storePath, 'utf8')) as { engrams: any[] }).engrams
  const primary = (): any[] => {
    try { return (yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')) as { engrams?: any[] } | null)?.engrams ?? [] } catch { return [] }
  }

  it('the loaded id is the stored id (idempotent namespacing)', async () => {
    const plur = new Plur({ path: dir })
    const all = await plur.list()
    expect(all.map(e => e.id)).toContain(PREFIXED)
  })

  it('forget() finds and retires it in its own store', async () => {
    const plur = new Plur({ path: dir })
    await plur.forget(PREFIXED, 'superseded')
    const r = stored().find(e => e.id === PREFIXED)
    expect(r?.status).toBe('retired')
  })

  it('a re-learn in the same scope counts against the store row, not a new primary row', async () => {
    const plur = new Plur({ path: dir })
    await plur.learn('the engineering team deploys on tuesdays only', { scope: SCOPE, type: 'behavioral' })
    expect(primary().filter(e => e.status !== 'retired'), 'Decision A stored a duplicate').toHaveLength(0)
    expect(stored()).toHaveLength(1)
  })
})
