import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { engramSearchText, ftsTokenize, ftsScore } from '../src/fts.js'
import { loadEngrams, saveEngrams } from '../src/engrams.js'
import { detectPlurStorage } from '../src/storage.js'

describe('enriched search — schema fields improve retrieval', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-enriched-'))
    plur = new Plur({ path: dir })
  })

  afterEach(() => { rmSync(dir, { recursive: true }) })

  it('engramSearchText includes entities in searchable text', () => {
    plur.learn('The database migration was completed successfully', { type: 'behavioral' })
    const paths = detectPlurStorage(dir)
    const engrams = loadEngrams(paths.engrams)
    // Add entities to the engram
    engrams[0].entities = [
      { name: 'PostgreSQL', type: 'technology' },
      { name: 'Gregor', type: 'person' },
    ]
    saveEngrams(paths.engrams, engrams)

    const text = engramSearchText(engrams[0])
    expect(text).toContain('PostgreSQL')
    expect(text).toContain('Gregor')
    expect(text).toContain('technology')
    expect(text).toContain('person')
  })

  it('engramSearchText includes temporal validity', () => {
    plur.learn('The API uses v2 endpoints', { type: 'behavioral' })
    const paths = detectPlurStorage(dir)
    const engrams = loadEngrams(paths.engrams)
    engrams[0].temporal = {
      learned_at: '2026-03-22',
      valid_from: '2026-01-01',
      valid_until: '2026-12-31',
    }
    saveEngrams(paths.engrams, engrams)

    const text = engramSearchText(engrams[0])
    expect(text).toContain('2026-01-01')
    expect(text).toContain('2026-12-31')
  })

  it('engramSearchText includes rationale', () => {
    plur.learn('Always use prepared statements for SQL', { type: 'behavioral' })
    const paths = detectPlurStorage(dir)
    const engrams = loadEngrams(paths.engrams)
    engrams[0].rationale = 'Prevents SQL injection attacks'
    saveEngrams(paths.engrams, engrams)

    const text = engramSearchText(engrams[0])
    expect(text).toContain('injection')
    expect(text).toContain('attacks')
  })

  it('entity-enriched engram scores higher for entity name queries', () => {
    plur.learn('The team decided to use a new framework', { type: 'architectural' })
    plur.learn('We migrated the database to a new server', { type: 'architectural' })
    const paths = detectPlurStorage(dir)
    const engrams = loadEngrams(paths.engrams)

    // Add entity to first engram only
    engrams[0].entities = [{ name: 'React', type: 'technology' }]
    saveEngrams(paths.engrams, engrams)

    const queryTokens = ftsTokenize('React framework')
    const score0 = ftsScore(engrams[0], queryTokens)
    const score1 = ftsScore(engrams[1], queryTokens)

    expect(score0).toBeGreaterThan(score1)
  })

  it('BM25 recall finds engrams by entity name', () => {
    plur.learn('The project uses a specific database', { type: 'architectural' })
    const paths = detectPlurStorage(dir)
    const engrams = loadEngrams(paths.engrams)
    engrams[0].entities = [
      { name: 'MongoDB', type: 'technology' },
      { name: 'Atlas', type: 'tool' },
    ]
    saveEngrams(paths.engrams, engrams)

    // Reload plur to pick up the modified engrams
    const plur2 = new Plur({ path: dir })
    const results = plur2.recall('MongoDB')
    expect(results.length).toBe(1)
    expect(results[0].entities?.[0]?.name).toBe('MongoDB')
  })

  it('BM25 recall finds engrams by rationale content', () => {
    plur.learn('Use TypeScript strict mode', { type: 'behavioral' })
    const paths = detectPlurStorage(dir)
    const engrams = loadEngrams(paths.engrams)
    engrams[0].rationale = 'Catches null pointer exceptions at compile time'
    saveEngrams(paths.engrams, engrams)

    const plur2 = new Plur({ path: dir })
    const results = plur2.recall('null pointer exceptions')
    expect(results.length).toBe(1)
  })

  it('temporal dates make engrams findable by date queries', () => {
    plur.learn('Conference keynote presentation', { type: 'behavioral' })
    const paths = detectPlurStorage(dir)
    const engrams = loadEngrams(paths.engrams)
    engrams[0].temporal = {
      learned_at: '2026-03-22',
      valid_from: '2026-07-01',
    }
    engrams[0].entities = [{ name: 'EthCC', type: 'event' }]
    saveEngrams(paths.engrams, engrams)

    const plur2 = new Plur({ path: dir })
    const results = plur2.recall('EthCC')
    expect(results.length).toBe(1)
  })

  it('enriched text does not break when optional fields are absent', () => {
    plur.learn('Simple engram with no extras', { type: 'behavioral' })
    const paths = detectPlurStorage(dir)
    const engrams = loadEngrams(paths.engrams)
    const text = engramSearchText(engrams[0])
    expect(text).toContain('Simple engram')
    expect(text).not.toContain('undefined')
  })
})
