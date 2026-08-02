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

  it('keeps ASCII behavior unchanged when text contains no CJK', () => {
    const tokens = ftsTokenize('docker compose deployment')
    expect(tokens).toEqual(['docker', 'compose', 'deployment'])
  })

  it('indexes pure-Chinese text as character bigrams (was: empty tokens)', () => {
    const tokens = ftsTokenize('测试部署应该用')
    expect(tokens).toContain('测试')
    expect(tokens).toContain('试部')
    expect(tokens).toContain('部署')
    expect(tokens).toContain('应该')
    expect(tokens).toContain('该用')
    // every Han char participates in two bigrams (except run edges)
    expect(tokens.length).toBeGreaterThanOrEqual(4)
  })

  it('mixed Chinese + English keeps both term kinds', () => {
    const tokens = ftsTokenize('测试部署应该用 docker compose')
    expect(tokens).toContain('docker')
    expect(tokens).toContain('compose')
    expect(tokens).toContain('部署')
    expect(tokens).toContain('该用')
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

describe('BM25 reverse substring junk matching (#721)', () => {
  // qt.includes(t) allowed any document token that is a non-prefix substring of
  // the query to score a TF hit. e.g. "deploying".includes("yin") = true, so
  // an engram about "yin yang" matched the query "deploying" and could outscore
  // the correct "deploy" stem (which had higher df → lower IDF).
  // Fix: require qt.startsWith(t) so only true morphological prefixes match.

  it('"yin" is a non-prefix substring of "deploying" and must not produce a result', () => {
    // With the bug: 'deploying'.includes('yin') = true → tf=1 → engram surfaces
    // With the fix: 'deploying'.startsWith('yin') = false → tf=0 → no result
    const yin = makeEngram({ id: 'ENG-2026-0330-010', statement: 'yin yang balance practice' })
    const results = searchEngrams([yin], 'deploying')
    expect(results).toHaveLength(0)
  })

  it('"res" is a non-prefix substring of "postgres" and must not produce a result', () => {
    // "postgres"[5:8] = "res" — 'postgres'.includes('res') = true (non-prefix)
    // "res" must be a standalone token: use "res judicata" so it survives ftsTokenize
    const res = makeEngram({ id: 'ENG-2026-0330-012', statement: 'res judicata legal doctrine principle' })
    const results = searchEngrams([res], 'postgres')
    expect(results).toHaveLength(0)
  })

  it('morphological prefix "deploy" still matches query "deploying"', () => {
    // "deploy" is a true prefix of "deploying" → must survive the fix
    const deploy = makeEngram({ id: 'ENG-2026-0330-014', statement: 'deploy application server production' })
    const results = searchEngrams([deploy], 'deploying')
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('ENG-2026-0330-014')
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

describe('CJK search (Chinese engrams)', () => {
  const engrams = [
    makeEngram({ id: 'ENG-2026-0330-001', statement: '测试部署应该用 docker compose' }),
    makeEngram({ id: 'ENG-2026-0330-002', statement: 'unit tests must run before commit' }),
  ]

  it('retrieves a Chinese engram for a Chinese query', () => {
    const results = searchEngrams(engrams, '部署流程')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].id).toBe('ENG-2026-0330-001')
  })

  it('does not retrieve a Chinese engram for an unrelated Chinese query', () => {
    const results = searchEngrams(engrams, '单位不要')
    // zero term overlap → empty result (no noise from unrelated CJK queries)
    expect(results).toHaveLength(0)
  })
})
