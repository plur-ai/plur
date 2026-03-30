import { describe, it, expect } from 'vitest'
import { ftsTokenize, ftsScore, searchEngrams, computeIdf, engramSearchText } from '../src/fts.js'
import { EngramSchema } from '../src/schemas/engram.js'

const makeEngram = (overrides: Partial<any> = {}) => EngramSchema.parse({
  id: 'ENG-2026-0330-001',
  statement: 'test statement',
  type: 'behavioral',
  scope: 'global',
  status: 'active',
  ...overrides,
})

describe('ftsTokenize', () => {
  it('tokenizes text into lowercase words, filters short and stop words', () => {
    const tokens = ftsTokenize('The quick BROWN fox jumps')
    expect(tokens).toContain('quick')
    expect(tokens).toContain('brown')
    expect(tokens).toContain('fox')
    expect(tokens).toContain('jumps')
    expect(tokens).not.toContain('the')
  })
})

describe('computeIdf', () => {
  it('gives higher weight to rare terms than common terms', () => {
    const engrams = [
      makeEngram({ id: 'ENG-2026-0330-001', statement: 'deploy the app using kubernetes' }),
      makeEngram({ id: 'ENG-2026-0330-002', statement: 'deploy the service to production' }),
      makeEngram({ id: 'ENG-2026-0330-003', statement: 'kubernetes cluster configuration' }),
    ]
    const tokens = ftsTokenize('deploy kubernetes')
    const idf = computeIdf(engrams, tokens)
    expect(idf.size).toBe(2)
    expect(idf.get('deploy')).toBeDefined()
    expect(idf.get('kubernetes')).toBeDefined()
  })

  it('rare terms get higher IDF than common terms', () => {
    const engrams = [
      makeEngram({ id: 'ENG-2026-0330-001', statement: 'always deploy carefully' }),
      makeEngram({ id: 'ENG-2026-0330-002', statement: 'always test before commit' }),
      makeEngram({ id: 'ENG-2026-0330-003', statement: 'always review pull requests' }),
      makeEngram({ id: 'ENG-2026-0330-004', statement: 'deploy with blue-green strategy' }),
    ]
    // 'always' appears in 3/4 engrams, 'deploy' in 2/4
    const tokens = ftsTokenize('always deploy')
    const idf = computeIdf(engrams, tokens)
    expect(idf.get('deploy')!).toBeGreaterThan(idf.get('always')!)
  })

  it('clamps IDF to zero for universal terms (no negative weights)', () => {
    const engrams = [
      makeEngram({ id: 'ENG-2026-0330-001', statement: 'always deploy carefully' }),
      makeEngram({ id: 'ENG-2026-0330-002', statement: 'always test carefully' }),
    ]
    const tokens = ftsTokenize('always')
    const idf = computeIdf(engrams, tokens)
    expect(idf.get('always')).toBe(0)
  })

  it('returns empty map for empty engram list', () => {
    const idf = computeIdf([], ftsTokenize('anything'))
    expect(idf.size).toBe(0)
  })
})

describe('ftsScore with IDF', () => {
  it('scores higher when matching rare terms', () => {
    const engrams = [
      makeEngram({ id: 'ENG-2026-0330-001', statement: 'always deploy carefully' }),
      makeEngram({ id: 'ENG-2026-0330-002', statement: 'always test before commit' }),
      makeEngram({ id: 'ENG-2026-0330-003', statement: 'always review pull requests' }),
      makeEngram({ id: 'ENG-2026-0330-004', statement: 'deploy with kubernetes orchestration' }),
    ]
    const queryTokens = ftsTokenize('always deploy kubernetes')
    const idf = computeIdf(engrams, queryTokens)

    // Engram 4 matches 'deploy' + 'kubernetes' (both rarer than 'always')
    const score4 = ftsScore(engrams[3], queryTokens, idf)
    // Engram 1 matches 'always' (common) + 'deploy'
    const score1 = ftsScore(engrams[0], queryTokens, idf)

    expect(score4).toBeGreaterThan(score1)
  })
})

describe('searchEngrams', () => {
  it('ranks results using IDF-weighted scoring', () => {
    const engrams = [
      makeEngram({ id: 'ENG-2026-0330-001', statement: 'always validate user input data' }),
      makeEngram({ id: 'ENG-2026-0330-002', statement: 'always log error messages' }),
      makeEngram({ id: 'ENG-2026-0330-003', statement: 'validate schema with zod library' }),
    ]
    const results = searchEngrams(engrams, 'validate input')
    expect(results.length).toBeGreaterThan(0)
    // First result should be the one matching both 'validate' and 'input'
    expect(results[0].id).toBe('ENG-2026-0330-001')
  })
})

describe('BM25 term frequency saturation', () => {
  it('repeated terms score higher than single mention', () => {
    const engrams = [
      makeEngram({ id: 'ENG-2026-0330-001', statement: 'deploy deploy deploy carefully' }),
      makeEngram({ id: 'ENG-2026-0330-002', statement: 'deploy the application' }),
    ]
    const results = searchEngrams(engrams, 'deploy')
    expect(results[0].id).toBe('ENG-2026-0330-001')
  })

  it('term frequency saturates (diminishing returns)', () => {
    const engrams = [
      makeEngram({ id: 'ENG-2026-0330-001', statement: 'deploy deploy deploy deploy deploy deploy deploy deploy' }),
      makeEngram({ id: 'ENG-2026-0330-002', statement: 'deploy deploy deploy' }),
    ]
    const queryTokens = ftsTokenize('deploy')
    const idf = computeIdf(engrams, queryTokens)
    const avgdl = engrams.reduce((sum, e) => sum + ftsTokenize(engramSearchText(e)).length, 0) / engrams.length
    const score1 = ftsScore(engrams[0], queryTokens, idf, avgdl)
    const score2 = ftsScore(engrams[1], queryTokens, idf, avgdl)
    // 8x mentions should NOT give 8x the score due to saturation
    expect(score1 / score2).toBeLessThan(2)
    expect(score1).toBeGreaterThan(score2)
  })
})

describe('BM25 document length normalization', () => {
  it('short doc with rare term beats long doc with same term', () => {
    const engrams = [
      makeEngram({ id: 'ENG-2026-0330-001', statement: 'kubernetes orchestration' }),
      makeEngram({ id: 'ENG-2026-0330-002', statement: 'kubernetes is used for container orchestration management and deployment scaling configuration monitoring' }),
      makeEngram({ id: 'ENG-2026-0330-003', statement: 'something completely unrelated to anything' }),
    ]
    const results = searchEngrams(engrams, 'kubernetes')
    // Short doc should rank higher — same term match but normalized by length
    expect(results[0].id).toBe('ENG-2026-0330-001')
  })
})
