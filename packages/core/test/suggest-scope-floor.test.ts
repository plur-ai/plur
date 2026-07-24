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
})
