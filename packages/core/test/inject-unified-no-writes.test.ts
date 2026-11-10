/**
 * R5 (overhaul): the unified injection searches without recall's bookkeeping.
 * No co_accessed edges, no frequency or last_accessed changes — injection
 * keeps exactly its own single set of writes (the co_injection history event
 * and injection_count).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, loadEngrams } from '../src/index.js'
import { EngramSchema, type Engram } from '../src/schemas/engram.js'
import { writeFixtureStore } from './helpers/injection-fixture.js'

const mk = (id: string, statement: string): Engram => EngramSchema.parse({
  id, statement, type: 'behavioral', scope: 'global', status: 'active', version: 2, tags: [],
  activation: { retrieval_strength: 0.9, storage_strength: 1, frequency: 3, last_accessed: '2026-01-02' },
}) as Engram

describe('unified injection writes no recall bookkeeping (R5)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-unified-nowrite-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('no co_accessed edges, no frequency or last_accessed change; injection_count goes up once per injection', async () => {
    const engrams = [
      mk('ENG-2026-1101-001', 'deploy the billing service with the release script'),
      mk('ENG-2026-1101-002', 'deploy the billing service after the smoke tests pass'),
      mk('ENG-2026-1101-003', 'deploy the billing service from the release branch'),
    ]
    writeFixtureStore(dir, engrams, 'injection:\n  mode: unified\n')
    const plur = new Plur({ path: dir })
    const r1 = await plur.inject('deploy the billing service')
    const r2 = await plur.inject('deploy the billing service release')
    expect(r1.injected_ids.length).toBe(3)
    expect(r2.injected_ids.length).toBe(3)

    const after = loadEngrams(join(dir, 'engrams.yaml'))
    for (const e of after) {
      expect((e.associations ?? []).filter(a => a.type === 'co_accessed'), `${e.id} gained co_accessed edges`).toEqual([])
      expect(e.activation.frequency, `${e.id} frequency moved`).toBe(3)
      expect(e.activation.last_accessed, `${e.id} last_accessed moved`).toBe('2026-01-02')
      expect((e as { injection_count?: number }).injection_count).toBe(2)
    }
  })

  it('recall, by contrast, does its bookkeeping (control: the store is writable)', async () => {
    const engrams = [
      mk('ENG-2026-1101-011', 'rotate the signing keys monthly'),
      mk('ENG-2026-1101-012', 'rotate the signing keys with the script'),
    ]
    writeFixtureStore(dir, engrams)
    const plur = new Plur({ path: dir })
    await plur.recall('rotate the signing keys')
    const after = loadEngrams(join(dir, 'engrams.yaml'))
    expect(after.some(e => e.activation.frequency !== 3 || e.activation.last_accessed !== '2026-01-02')).toBe(true)
  })
})
