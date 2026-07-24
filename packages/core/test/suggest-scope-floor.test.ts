import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'

// #670 — keyword floor on the SUGGESTION surface. suggestScope() accepts a
// minConfidence option (explicit option > config.scope_routing.min_confidence
// > 0), floors the advisory candidate list, and leaves the auto-route gate
// (match_threshold) untouched.
describe('suggestScope minConfidence floor (#670)', () => {
  let dir: string

  const writeConfig = (extra = ''): void => {
    writeFileSync(join(dir, 'config.yaml'),
      `index: false\n` +
      extra +
      `stores:\n` +
      `  - path: ${join(dir, 'team.yaml')}\n` +
      `    scope: "group:acme/engineering"\n` +
      `    shared: true\n` +
      `    description: "Engineering"\n` +
      `    covers: ["acme.engineering", "benchmarking", "kubernetes"]\n`,
    )
  }

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-floor-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  // A statement hitting exactly ONE cover keyword scores ≈0.12 — the noise
  // band the floor exists to clip.
  const LONE_KEYWORD = { statement: 'we briefly mentioned benchmarking at lunch' }

  it('default (no option, no config): lone keyword hit is still returned (floor 0)', () => {
    writeConfig()
    const plur = new Plur({ path: dir })
    const candidates = plur.suggestScope(LONE_KEYWORD)
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates[0].confidence).toBeLessThan(0.15)
  })

  it('explicit option floors the list', () => {
    writeConfig()
    const plur = new Plur({ path: dir })
    expect(plur.suggestScope(LONE_KEYWORD, { minConfidence: 0.15 })).toHaveLength(0)
  })

  it('config scope_routing.min_confidence is honored when no option is passed', () => {
    writeConfig('scope_routing:\n  min_confidence: 0.15\n')
    const plur = new Plur({ path: dir })
    expect(plur.suggestScope(LONE_KEYWORD)).toHaveLength(0)
    // Explicit option (including 0) overrides the config floor.
    expect(plur.suggestScope(LONE_KEYWORD, { minConfidence: 0 }).length).toBeGreaterThan(0)
  })

  it('a domain match (0.5) survives the display floor', () => {
    writeConfig()
    const plur = new Plur({ path: dir })
    const candidates = plur.suggestScope(
      { statement: 'storage layer notes', domain: 'acme.engineering.storage' },
      { minConfidence: 0.15 },
    )
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates[0].scope).toBe('group:acme/engineering')
    expect(candidates[0].confidence).toBeGreaterThanOrEqual(0.15)
  })

  it('the floor is inclusive: a candidate EXACTLY at the floor survives', () => {
    writeConfig()
    const plur = new Plur({ path: dir })
    // A pure domain-prefix match squashes to exactly 0.5.
    const signals = { statement: 'x', domain: 'acme.engineering.storage' }
    expect(plur.suggestScope(signals, { minConfidence: 0.5 }).length).toBeGreaterThan(0)
    expect(plur.suggestScope(signals, { minConfidence: 0.5001 })).toHaveLength(0)
  })

  it('NaN does not silently disable the floor semantics (treated as no-floor, not a filter of nothing)', () => {
    writeConfig()
    const plur = new Plur({ path: dir })
    // Number.isFinite guard: NaN behaves exactly like "no floor" — the full
    // advisory list comes back rather than an exception or an empty list.
    const candidates = plur.suggestScope(LONE_KEYWORD, { minConfidence: NaN })
    expect(candidates.length).toBeGreaterThan(0)
  })

  it('an out-of-range config value drops only the field — stores and siblings survive (#670 review)', () => {
    // min_confidence: 1.5 violates .max(1). Field-level .catch(undefined) must
    // drop ONLY that field: the store (and its covers) stays registered and a
    // valid sibling match_threshold is preserved — previously the whole config
    // parse failed and loadConfig fell back to full defaults, silently
    // dropping every store.
    writeConfig('scope_routing:\n  min_confidence: 1.5\n  match_threshold: 0.9\n')
    const plur = new Plur({ path: dir })
    expect(plur.listScopeMetadata().length).toBeGreaterThan(0)
    expect(plur.getScopeRoutingConfig().min_confidence).toBeUndefined()
    expect(plur.getScopeRoutingConfig().match_threshold).toBe(0.9)
    // And the suggestion surface behaves as if the bad field were absent.
    expect(plur.suggestScope(LONE_KEYWORD).length).toBeGreaterThan(0)
  })
})
