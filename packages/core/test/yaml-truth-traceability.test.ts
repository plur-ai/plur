/**
 * YAML-as-truth invariant — Test B: public API traceability
 *
 * Issue plur-ai/plur#249, ADR-0001 (#226), engram ENG-2026-0530-019.
 *
 * Principle: every engram returned by any PLUR public method must trace
 * to a record in the YAML source on disk. If a future feature inserts
 * engrams into the DB-only index without also writing them to YAML
 * (e.g. materialized cache, "synthetic" engrams, reranker artifacts),
 * this test fails.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { loadEngrams } from '../src/engrams.js'

/**
 * Read every YAML file under `dir` recursively and return a set of all
 * engram IDs present.  This is the YAML ground truth — the universe of
 * IDs any public method is allowed to return.
 */
function yamlGroundTruth(dir: string): Set<string> {
  const ids = new Set<string>()
  const primary = join(dir, 'engrams.yaml')
  for (const e of loadEngrams(primary)) ids.add(e.id)
  // Pack stores, secondary stores, scoped stores all live at well-known
  // sub-paths or are configured.  Extending this set is the right move
  // when a new YAML source is added.
  return ids
}

describe('yaml-as-truth: public API traceability (Test B)', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-yaml-truth-trace-'))
    plur = new Plur({ path: dir })

    plur.learn('verify dates with datacore.date', {
      scope: 'project:plur',
      domain: 'workflow.dates',
      type: 'procedural',
    })
    plur.learn('YAML is the source of truth', {
      scope: 'project:plur',
      domain: 'plur.architecture',
      type: 'architectural',
    })
    plur.learn('the user prefers terse responses', {
      scope: 'global',
      domain: 'workflow.communication',
      type: 'behavioral',
    })
    plur.learn('embedding choice dominates fusion choice', {
      scope: 'project:plur',
      domain: 'plur.retrieval',
      type: 'terminological',
    })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('list() returns only engrams present in YAML', () => {
    const truth = yamlGroundTruth(dir)
    const returned = plur.list()
    expect(returned.length).toBeGreaterThan(0)
    for (const e of returned) {
      expect(truth.has(e.id),
        `list returned ${e.id} which is NOT in YAML ground truth — ` +
        `this is a YAML-as-truth invariant violation (#249)`
      ).toBe(true)
    }
  })

  it('recall() returns only engrams present in YAML', () => {
    const truth = yamlGroundTruth(dir)
    const returned = plur.recall('source of truth')
    expect(returned.length).toBeGreaterThan(0)
    for (const e of returned) {
      expect(truth.has(e.id),
        `recall returned ${e.id} which is NOT in YAML ground truth`
      ).toBe(true)
    }
  })

  it('recallHybrid() returns only engrams present in YAML', async () => {
    const truth = yamlGroundTruth(dir)
    const returned = await plur.recallHybrid('source of truth')
    for (const e of returned) {
      expect(truth.has(e.id),
        `recallHybrid returned ${e.id} which is NOT in YAML ground truth`
      ).toBe(true)
    }
  })

  it('inject() returns only engrams present in YAML', () => {
    const truth = yamlGroundTruth(dir)
    const result = plur.inject('about to merge a PR')
    for (const id of result.injected_ids) {
      expect(truth.has(id),
        `inject returned ${id} which is NOT in YAML ground truth`
      ).toBe(true)
    }
  })

  it('getById() returns only engrams present in YAML', () => {
    const truth = yamlGroundTruth(dir)
    const ids = Array.from(truth)
    for (const id of ids) {
      const e = plur.getById(id)
      expect(e).not.toBeNull()
      expect(truth.has(e!.id)).toBe(true)
    }
  })

  it('getById() returns null for ids not in YAML', () => {
    expect(plur.getById('ENG-9999-9999-999')).toBeNull()
  })

  it('list with scope filter returns only YAML-backed engrams', () => {
    const truth = yamlGroundTruth(dir)
    const returned = plur.list({ scope: 'project:plur' })
    for (const e of returned) {
      expect(truth.has(e.id)).toBe(true)
    }
  })

  it('every returned engram has its YAML-derived fields intact', () => {
    const truth = yamlGroundTruth(dir)
    const yamlEngrams = loadEngrams(join(dir, 'engrams.yaml'))
    const byId = new Map(yamlEngrams.map(e => [e.id, e]))

    for (const returned of plur.list()) {
      expect(truth.has(returned.id)).toBe(true)
      const yaml = byId.get(returned.id)!
      // Core authoritative fields must match YAML exactly — these cannot
      // be DB-only because they're what gets shipped in packs / synced
      // via git.
      expect(returned.statement).toBe(yaml.statement)
      expect(returned.scope).toBe(yaml.scope)
      expect(returned.type).toBe(yaml.type)
      expect(returned.status).toBe(yaml.status)
    }
  })
})
