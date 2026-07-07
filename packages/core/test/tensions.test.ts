import { describe, it, expect, vi } from 'vitest'
import {
  scopesOverlap,
  domainSegmentsOverlap,
  stemToken,
  subjectsOverlap,
  statementOverlap,
  getCandidatePairs,
  buildContradictionPrompt,
  parseContradictionResponse,
  buildBatchContradictionPrompt,
  parseBatchContradictionResponse,
  scanForTensions,
  engramDate,
} from '../src/tensions.js'
import type { Engram } from '../src/schemas/engram.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEngram(overrides: Partial<Engram> & { id: string; statement: string; scope?: string }): Engram {
  return {
    version: 2,
    status: 'active',
    consolidated: false,
    type: 'factual',
    scope: 'global',
    visibility: 'private',
    activation: {
      retrieval_strength: 0.7,
      storage_strength: 1,
      frequency: 0,
      last_accessed: '2026-05-16',
    },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' },
    knowledge_anchors: [],
    associations: [],
    derivation_count: 1,
    tags: [],
    content_hash: overrides.id,
    commitment: 'leaning',
    engram_version: 1,
    episode_ids: [],
    polarity: null,
    ...overrides,
  } as Engram
}

// ---------------------------------------------------------------------------
// scopesOverlap
// ---------------------------------------------------------------------------

describe('scopesOverlap', () => {
  it('global + global → overlap', () => {
    expect(scopesOverlap('global', 'global')).toBe(true)
  })

  it('global + project:plur → overlap (global is universal)', () => {
    expect(scopesOverlap('global', 'project:plur')).toBe(true)
    expect(scopesOverlap('project:plur', 'global')).toBe(true)
  })

  it('identical scopes → overlap', () => {
    expect(scopesOverlap('project:plur', 'project:plur')).toBe(true)
  })

  it('same level prefix, different value → no overlap (conservative rule)', () => {
    // Conservative rule: different projects are different namespaces — skip cross-project pairs
    expect(scopesOverlap('project:plur', 'project:datacore')).toBe(false)
  })

  it('different levels → no overlap', () => {
    // "project:" vs "group:" are distinct namespace levels
    expect(scopesOverlap('project:plur', 'group:datafund')).toBe(false)
  })

  it('global vs group → overlap', () => {
    expect(scopesOverlap('global', 'group:datafund')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// domainSegmentsOverlap
// ---------------------------------------------------------------------------

describe('domainSegmentsOverlap', () => {
  it('identical domains → overlap', () => {
    expect(domainSegmentsOverlap('plur.core', 'plur.core')).toBe(true)
  })

  it('shared prefix segment → overlap', () => {
    expect(domainSegmentsOverlap('plur.core.learn', 'plur.mcp')).toBe(true)
  })

  it('no shared segment → no overlap', () => {
    expect(domainSegmentsOverlap('trading.positions', 'plur.core')).toBe(false)
  })

  it('missing domain on one side → overlap (permissive)', () => {
    expect(domainSegmentsOverlap(undefined, 'plur.core')).toBe(true)
    expect(domainSegmentsOverlap('plur.core', undefined)).toBe(true)
  })

  it('missing domain on both sides → overlap', () => {
    expect(domainSegmentsOverlap(undefined, undefined)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// subjectsOverlap
// ---------------------------------------------------------------------------

describe('subjectsOverlap', () => {
  it('identical subjects → overlap', () => {
    expect(subjectsOverlap(
      'The plur CLI uses BM25 for search.',
      'The plur CLI uses embeddings for search.',
    )).toBe(true)
  })

  it('shared key entity → overlap', () => {
    expect(subjectsOverlap(
      'Protocol fee is set to 1% of transaction volume.',
      'Protocol fee was increased to 2% in v3.',
    )).toBe(true)
  })

  it('completely different subjects → no overlap', () => {
    // Classic false-positive from original system: unrelated facts in same domain
    expect(subjectsOverlap(
      'Plur CLI is at v0.8.2.',
      'MemPalace is a competitor product.',
    )).toBe(false)
  })

  it('domain-adjacent but different subjects → no overlap', () => {
    expect(subjectsOverlap(
      'Engrams decay using ACT-R activation model.',
      'Sessions start with plur_session_start call.',
    )).toBe(false)
  })

  it('shared project name → overlap', () => {
    expect(subjectsOverlap(
      'Verity marketplace is built on Ethereum.',
      'Verity marketplace uses Polygon for transactions.',
    )).toBe(true)
  })

  it('plural/singular subject token → overlap via stemming', () => {
    expect(subjectsOverlap(
      'Deployment bots are rate-limited to 5 per hour.',
      'Deployment bot is rate-limited to 10 per hour.',
    )).toBe(true)
  })

  it('plural/singular with -ments suffix → overlap via stemming', () => {
    expect(subjectsOverlap(
      'Environment variables are sourced from .env file.',
      'Environment variable sourcing is handled by dotenv.',
    )).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// stemToken
// ---------------------------------------------------------------------------

describe('stemToken', () => {
  it('strips -s suffix when stem >= 4 chars', () => {
    expect(stemToken('errors')).toBe('error')
    expect(stemToken('bots')).toBe('bots') // stem "bot" = 3 chars → NOT stripped
  })

  it('strips -es suffix', () => {
    expect(stemToken('batches')).toBe('batch')
  })

  it('strips -ies suffix', () => {
    expect(stemToken('deployies')).toBe('deploy')
  })

  it('strips -ment suffix', () => {
    expect(stemToken('deployment')).toBe('deploy')
  })

  it('strips -ments suffix', () => {
    expect(stemToken('deployments')).toBe('deploy')
  })

  it('strips -ing suffix', () => {
    expect(stemToken('processing')).toBe('process')
  })

  it('strips -ings suffix', () => {
    expect(stemToken('settings')).toBe('sett')  // 8-4=4 chars → stripped to 'sett'
    expect(stemToken('greetings')).toBe('greet') // 9-4=5 chars → 'greet'
  })

  it('strips -ion suffix', () => {
    expect(stemToken('validation')).toBe('validat')
  })

  it('strips -er suffix', () => {
    expect(stemToken('builder')).toBe('build')
  })

  it('does not strip when stem would be < 4 chars', () => {
    expect(stemToken('bees')).toBe('bees')  // stem "be" = 2 chars
    expect(stemToken('ones')).toBe('ones')  // stem "on" = 2 chars
    expect(stemToken('runs')).toBe('runs')  // stem "run" = 3 chars
  })

  it('returns unchanged for tokens with no matching suffix', () => {
    expect(stemToken('plur')).toBe('plur')
    expect(stemToken('search')).toBe('search')
  })

  it('strips longest matching suffix first', () => {
    expect(stemToken('deployments')).toBe('deploy')
  })
})

// ---------------------------------------------------------------------------
// subjectsOverlap — labeled 30-pair contradiction suite
// Source: #489 measurement. Stemmed filter gets 27/30 (90% recall).
// Any regression below 27 must be explained and explicitly accepted.
// ---------------------------------------------------------------------------

describe('subjectsOverlap — labeled 30-pair suite', () => {
  const CONTRADICTIONS: [string, string, string][] = [
    ['direct-value', 'The protocol fee is 1% of transaction volume.', 'The protocol fee is 2% of transaction volume.'],
    ['direct-value', 'Rate limit is 100 requests per minute per user.', 'Rate limit is 50 requests per minute per user.'],
    ['direct-value', 'Session tokens expire after 30 days.', 'Session tokens expire after 7 days.'],
    ['direct-value', 'The default log level is INFO.', 'The default log level is DEBUG.'],
    ['direct-value', 'Max file upload size is 10 MB.', 'Max file upload size is 50 MB.'],
    ['boolean-flip', 'Plur uses local embeddings with no API calls.', 'Plur embeddings require an external API call.'],
    ['boolean-flip', 'The CLI supports Windows.', 'The CLI does not support Windows.'],
    ['boolean-flip', 'Sync is enabled by default.', 'Sync is disabled by default.'],
    ['boolean-flip', 'Rate limiting is applied per IP.', 'Rate limiting is applied per user, not per IP.'],
    ['boolean-flip', 'Engrams are stored in SQLite.', 'Engrams are stored in YAML files, not SQLite.'],
    ['mutually-exclusive', 'Use pnpm for package management.', 'Use npm for package management.'],
    ['mutually-exclusive', 'Plur search uses BM25 only.', 'Plur search uses embedding vectors only.'],
    ['mutually-exclusive', 'Authentication uses JWT tokens.', 'Authentication uses session cookies.'],
    ['mutually-exclusive', 'The database backend is PostgreSQL.', 'The database backend is MySQL.'],
    ['mutually-exclusive', 'Errors are handled with Result types.', 'Errors are handled with exceptions.'],
    ['preamble', 'In this codebase, error handling uses Result types.', 'In this codebase, error handling uses exceptions.'],
    ['preamble', 'All API responses are in JSON format.', 'All API responses are in XML format.'],
    ['preamble', 'Tests must pass before merging.', 'Tests are optional before merging.'],
    ['preamble', 'The primary language is TypeScript.', 'The primary language is JavaScript.'],
    ['preamble', 'Commits must include a JIRA ticket reference.', 'Commits do not require a JIRA ticket reference.'],
    ['short-token', 'The CLI uses yaml for output.', 'The CLI uses json for output.'],
    ['short-token', 'The bot API rate limit is 10 rps.', 'The bot API rate limit is 100 rps.'],
    ['short-token', 'PRs need one approving review.', 'PRs need two approving reviews.'],
    ['short-token', 'The app port is 3000 in dev.', 'The app port is 8080 in dev.'],
    ['short-token', 'API keys expire after 90 days.', 'API keys expire after 180 days.'],
    ['domain-generic', 'The project timezone is UTC everywhere.', 'The project timezone is Europe/Ljubljana everywhere.'],
    ['domain-generic', 'User data is retained for 30 days.', 'User data is retained for 7 days.'],
    ['domain-generic', 'System backups are encrypted at rest.', 'System backups are stored unencrypted.'],
    ['domain-generic', 'Datacore modules load lazily on trigger match.', 'Datacore modules load eagerly at session start.'],
    ['domain-generic', 'Always use pnpm for package management.', 'Always use npm for package management.'],
  ]

  it('passes at least 27/30 pairs (90% recall — stemmed baseline)', () => {
    const hits = CONTRADICTIONS.filter(([, a, b]) => subjectsOverlap(a, b))
    expect(hits.length).toBeGreaterThanOrEqual(27)
  })
})

// ---------------------------------------------------------------------------
// engramDate
// ---------------------------------------------------------------------------

describe('engramDate', () => {
  it('returns date from temporal.learned_at (ISO timestamp)', () => {
    const e = makeEngram({ id: 'E1', statement: 'x', temporal: { learned_at: '2026-06-15T12:00:00Z' } })
    expect(engramDate(e)).toBe('2026-06-15')
  })

  it('returns date from temporal.learned_at (date-only string)', () => {
    const e = makeEngram({ id: 'E1', statement: 'x', temporal: { learned_at: '2026-01-03' } })
    expect(engramDate(e)).toBe('2026-01-03')
  })

  it('falls back to ID pattern ENG-YYYY-MM-DD-NNN', () => {
    const e = makeEngram({ id: 'ENG-2026-06-15-001', statement: 'x' })
    expect(engramDate(e)).toBe('2026-06-15')
  })

  it('returns undefined for IDs with no date pattern', () => {
    const e = makeEngram({ id: 'E1', statement: 'x' })
    expect(engramDate(e)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// buildContradictionPrompt — temporal date integration (#240)
// ---------------------------------------------------------------------------

describe('buildContradictionPrompt — temporal dates', () => {
  it('omits date note when dates are missing', () => {
    const prompt = buildContradictionPrompt(
      { id: 'E1', statement: 'A' },
      { id: 'E2', statement: 'B' },
    )
    expect(prompt).not.toContain('days apart')
  })

  it('includes temporal note when both dates are provided and different', () => {
    const prompt = buildContradictionPrompt(
      { id: 'E1', statement: 'X is true.', date: '2026-06-01' },
      { id: 'E2', statement: 'X is false.', date: '2026-06-15' },
    )
    expect(prompt).toContain('14 days apart')
  })

  it('uses singular "day" for 1 day apart', () => {
    const prompt = buildContradictionPrompt(
      { id: 'E1', statement: 'A', date: '2026-01-01' },
      { id: 'E2', statement: 'B', date: '2026-01-02' },
    )
    expect(prompt).toContain('1 day')
    expect(prompt).not.toContain('1 days')
  })

  it('does NOT include temporal note when dates are the same', () => {
    const prompt = buildContradictionPrompt(
      { id: 'E1', statement: 'X is true.', date: '2026-06-01' },
      { id: 'E2', statement: 'X is false.', date: '2026-06-01' },
    )
    expect(prompt).toContain('same day')
  })
})

// ---------------------------------------------------------------------------
// getCandidatePairs (integration of the three-stage pipeline)
// ---------------------------------------------------------------------------

describe('getCandidatePairs', () => {
  it('returns pairs in same scope with overlapping subjects', () => {
    const a = makeEngram({ id: 'E1', statement: 'plur search uses BM25 indexing.', scope: 'global' })
    const b = makeEngram({ id: 'E2', statement: 'plur search uses embedding vectors.', scope: 'global' })
    const pairs = getCandidatePairs([a, b])
    expect(pairs).toHaveLength(1)
    expect(pairs[0].map(e => e.id).sort()).toEqual(['E1', 'E2'])
  })

  it('skips pairs in disjoint scopes', () => {
    const a = makeEngram({ id: 'E1', statement: 'plur search uses BM25.', scope: 'project:plur' })
    const b = makeEngram({ id: 'E2', statement: 'plur search uses embeddings.', scope: 'group:datafund' })
    const pairs = getCandidatePairs([a, b])
    expect(pairs).toHaveLength(0)
  })

  it('skips pairs with non-overlapping domains', () => {
    const a = makeEngram({ id: 'E1', statement: 'plur search uses BM25.', scope: 'global', domain: 'plur.core' })
    const b = makeEngram({ id: 'E2', statement: 'plur search uses embeddings.', scope: 'global', domain: 'trading.positions' })
    const pairs = getCandidatePairs([a, b])
    expect(pairs).toHaveLength(0)
  })

  it('skips pairs with non-overlapping subjects', () => {
    const a = makeEngram({ id: 'E1', statement: 'Plur CLI is at v0.9.9.', scope: 'global' })
    const b = makeEngram({ id: 'E2', statement: 'MemPalace is a competitor.', scope: 'global' })
    const pairs = getCandidatePairs([a, b])
    expect(pairs).toHaveLength(0)
  })

  it('skips inactive engrams', () => {
    const a = makeEngram({ id: 'E1', statement: 'plur search uses BM25.', scope: 'global' })
    const b = makeEngram({ id: 'E2', statement: 'plur search uses embeddings.', scope: 'global', status: 'retired' as any })
    const pairs = getCandidatePairs([a, b])
    expect(pairs).toHaveLength(0)
  })

  it('relations.conflicts does NOT exempt a pair — importer suspects must be judged (#181, audit C1)', () => {
    const a = makeEngram({
      id: 'E1',
      statement: 'plur search uses BM25.',
      scope: 'global',
      relations: { conflicts: ['E2'] },
    })
    const b = makeEngram({ id: 'E2', statement: 'plur search uses embeddings.', scope: 'global' })
    const pairs = getCandidatePairs([a, b])
    expect(pairs).toHaveLength(1)
  })

  it('skips pairs recorded in the tension store (exclude_pairs, #181)', () => {
    const a = makeEngram({ id: 'E1', statement: 'plur search uses BM25.', scope: 'global' })
    const b = makeEngram({ id: 'E2', statement: 'plur search uses embeddings.', scope: 'global' })
    const pairs = getCandidatePairs([a, b], { exclude_pairs: new Set(['E1:E2']) })
    expect(pairs).toHaveLength(0)
  })

  it('returns no pairs for empty list', () => {
    expect(getCandidatePairs([])).toHaveLength(0)
  })

  it('returns no pairs for single engram', () => {
    const a = makeEngram({ id: 'E1', statement: 'plur uses YAML.', scope: 'global' })
    expect(getCandidatePairs([a])).toHaveLength(0)
  })

  it('global engrams pair with project-scoped engrams', () => {
    const a = makeEngram({ id: 'E1', statement: 'plur search uses BM25.', scope: 'global' })
    const b = makeEngram({ id: 'E2', statement: 'plur search uses embeddings.', scope: 'project:plur' })
    const pairs = getCandidatePairs([a, b])
    expect(pairs).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// statementOverlap (#180 ranking score)
// ---------------------------------------------------------------------------

describe('statementOverlap', () => {
  it('counts unique shared content tokens', () => {
    // shared: plur, cli, uses, search
    expect(statementOverlap(
      'plur cli uses bm25 search',
      'plur cli uses embedding search',
    )).toBe(4)
  })

  it('ignores stopwords and short tokens', () => {
    expect(statementOverlap('the and for was it', 'the and for was it')).toBe(0)
  })

  it('counts duplicate tokens once', () => {
    expect(statementOverlap('plur plur plur search', 'plur search')).toBe(2)
  })

  it('is symmetric', () => {
    const a = 'plur storage format uses json files'
    const b = 'plur storage uses yaml'
    expect(statementOverlap(a, b)).toBe(statementOverlap(b, a))
  })

  it('returns zero for disjoint statements', () => {
    expect(statementOverlap('bitcoin price dropped', 'plur uses yaml')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// getCandidatePairs ranking (#180)
// ---------------------------------------------------------------------------

describe('getCandidatePairs ranking (#180)', () => {
  it('ranks high-overlap pairs before low-overlap pairs regardless of insertion order', () => {
    // E1/E3 are near-identical (high overlap) but E2 is inserted between them,
    // so insertion order would yield (E1,E2) first. Ranking must put (E1,E3) first.
    const e1 = makeEngram({ id: 'E1', statement: 'plur cli config parser reads yaml files from home directory' })
    const e2 = makeEngram({ id: 'E2', statement: 'plur system settings menu' })
    const e3 = makeEngram({ id: 'E3', statement: 'plur cli config parser reads json files from home directory' })

    const pairs = getCandidatePairs([e1, e2, e3])
    expect(pairs.length).toBe(3)
    expect(pairs[0].map(e => e.id).sort()).toEqual(['E1', 'E3'])
  })

  it('keeps insertion order for pairs with equal overlap (stable sort)', () => {
    const a = makeEngram({ id: 'E1', statement: 'plur uses yaml' })
    const b = makeEngram({ id: 'E2', statement: 'plur uses json' })
    const c = makeEngram({ id: 'E3', statement: 'plur uses toml' })

    const pairs = getCandidatePairs([a, b, c])
    const ids = pairs.map(p => p.map(e => e.id).join(':'))
    expect(ids).toEqual(['E1:E2', 'E1:E3', 'E2:E3'])
  })
})

// ---------------------------------------------------------------------------
// buildContradictionPrompt
// ---------------------------------------------------------------------------

describe('buildContradictionPrompt', () => {
  it('includes both statement IDs and text', () => {
    const prompt = buildContradictionPrompt(
      { id: 'E1', statement: 'X is true.' },
      { id: 'E2', statement: 'X is false.' },
    )
    expect(prompt).toContain('E1')
    expect(prompt).toContain('E2')
    expect(prompt).toContain('X is true.')
    expect(prompt).toContain('X is false.')
  })

  it('instructs the model to use the exact response format', () => {
    const prompt = buildContradictionPrompt({ id: 'E1', statement: 'A' }, { id: 'E2', statement: 'B' })
    expect(prompt).toContain('CONTRADICTS: yes|no')
    expect(prompt).toContain('CONFIDENCE: 0.0-1.0')
    expect(prompt).toContain('REASON:')
  })
})

// ---------------------------------------------------------------------------
// parseContradictionResponse
// ---------------------------------------------------------------------------

describe('parseContradictionResponse', () => {
  it('parses a clear yes response', () => {
    const result = parseContradictionResponse(`CONTRADICTS: yes
CONFIDENCE: 0.92
REASON: Statement A says the fee is 1% while B says 2%.`)
    expect(result.is_contradiction).toBe(true)
    expect(result.confidence).toBeCloseTo(0.92)
    expect(result.reason).toContain('fee')
  })

  it('parses a clear no response', () => {
    const result = parseContradictionResponse(`CONTRADICTS: no
CONFIDENCE: 0.10
REASON: These describe different aspects of the system.`)
    expect(result.is_contradiction).toBe(false)
    expect(result.confidence).toBeCloseTo(0.10)
  })

  it('clamps confidence to [0, 1]', () => {
    const overHigh = parseContradictionResponse('CONTRADICTS: yes\nCONFIDENCE: 1.5\nREASON: x')
    expect(overHigh.confidence).toBe(1)

    const negative = parseContradictionResponse('CONTRADICTS: yes\nCONFIDENCE: -0.3\nREASON: x')
    expect(negative.confidence).toBe(0)
  })

  it('handles case-insensitive CONTRADICTS value', () => {
    const upper = parseContradictionResponse('CONTRADICTS: YES\nCONFIDENCE: 0.8\nREASON: x')
    expect(upper.is_contradiction).toBe(true)
    const lower = parseContradictionResponse('CONTRADICTS: No\nCONFIDENCE: 0.2\nREASON: x')
    expect(lower.is_contradiction).toBe(false)
  })

  it('returns safe defaults for malformed response', () => {
    const result = parseContradictionResponse('Sorry, I cannot determine this.')
    expect(result.is_contradiction).toBe(false)
    expect(result.confidence).toBe(0)
    expect(result.reason).toBe('')
  })

  it('parses reason correctly', () => {
    const result = parseContradictionResponse(
      'CONTRADICTS: yes\nCONFIDENCE: 0.85\nREASON: One says always, the other says never.',
    )
    expect(result.reason).toBe('One says always, the other says never.')
  })
})

// ---------------------------------------------------------------------------
// buildBatchContradictionPrompt (#180)
// ---------------------------------------------------------------------------

describe('buildBatchContradictionPrompt', () => {
  const pairs: Array<[{ id: string; statement: string }, { id: string; statement: string }]> = [
    [{ id: 'E1', statement: 'X is true.' }, { id: 'E2', statement: 'X is false.' }],
    [{ id: 'E3', statement: 'Y is red.' }, { id: 'E4', statement: 'Y is blue.' }],
  ]

  it('numbers each pair and includes ids and statements', () => {
    const prompt = buildBatchContradictionPrompt(pairs)
    expect(prompt).toContain('PAIR 1')
    expect(prompt).toContain('PAIR 2')
    for (const id of ['E1', 'E2', 'E3', 'E4']) expect(prompt).toContain(id)
    expect(prompt).toContain('X is true.')
    expect(prompt).toContain('Y is blue.')
  })

  it('instructs the model to answer one line per pair in the exact format', () => {
    const prompt = buildBatchContradictionPrompt(pairs)
    expect(prompt).toContain('PAIR_1:')
    expect(prompt).toContain('PAIR_2:')
    expect(prompt).toContain('CONTRADICTS: yes|no')
    expect(prompt).toContain('CONFIDENCE: 0.0-1.0')
    expect(prompt).toContain('REASON:')
  })

  it('keeps the same contradiction definition and guardrails as the single prompt', () => {
    const prompt = buildBatchContradictionPrompt(pairs)
    expect(prompt).toContain('mutually exclusive')
    expect(prompt).toContain('Do NOT flag as contradictions')
  })
})

// ---------------------------------------------------------------------------
// parseBatchContradictionResponse (#180)
// ---------------------------------------------------------------------------

describe('parseBatchContradictionResponse', () => {
  it('parses a well-formed multi-pair response in order', () => {
    const verdicts = parseBatchContradictionResponse(
      `PAIR_1: CONTRADICTS: yes | CONFIDENCE: 0.9 | REASON: Opposite claims.
PAIR_2: CONTRADICTS: no | CONFIDENCE: 0.1 | REASON: Different topics.`,
      2,
    )
    expect(verdicts).toHaveLength(2)
    expect(verdicts[0]).toMatchObject({ is_contradiction: true })
    expect(verdicts[0]!.confidence).toBeCloseTo(0.9)
    expect(verdicts[0]!.reason).toContain('Opposite')
    expect(verdicts[1]).toMatchObject({ is_contradiction: false })
  })

  it('returns null for a pair with no verdict line (never a false positive)', () => {
    const verdicts = parseBatchContradictionResponse(
      'PAIR_1: CONTRADICTS: no | CONFIDENCE: 0.2 | REASON: Unrelated.',
      3,
    )
    expect(verdicts[0]).not.toBeNull()
    expect(verdicts[1]).toBeNull()
    expect(verdicts[2]).toBeNull()
  })

  it('returns null for a pair marker without a parseable CONTRADICTS verdict', () => {
    const verdicts = parseBatchContradictionResponse(
      `PAIR_1: I am not sure about this one.
PAIR_2: CONTRADICTS: yes | CONFIDENCE: 0.8 | REASON: Conflict.`,
      2,
    )
    expect(verdicts[0]).toBeNull()
    expect(verdicts[1]).toMatchObject({ is_contradiction: true })
  })

  it('ignores out-of-range pair indices', () => {
    const verdicts = parseBatchContradictionResponse(
      `PAIR_7: CONTRADICTS: yes | CONFIDENCE: 0.9 | REASON: Ghost pair.
PAIR_0: CONTRADICTS: yes | CONFIDENCE: 0.9 | REASON: Ghost pair.`,
      2,
    )
    expect(verdicts).toEqual([null, null])
  })

  it('tolerates marker variants like "PAIR 2:" and lowercase', () => {
    const verdicts = parseBatchContradictionResponse(
      `PAIR 1: CONTRADICTS: no | CONFIDENCE: 0.1 | REASON: Fine.
pair_2: CONTRADICTS: yes | CONFIDENCE: 0.85 | REASON: Conflict.`,
      2,
    )
    expect(verdicts[0]).toMatchObject({ is_contradiction: false })
    expect(verdicts[1]).toMatchObject({ is_contradiction: true })
  })

  it('handles multiline sections per pair', () => {
    const verdicts = parseBatchContradictionResponse(
      `PAIR_1:
CONTRADICTS: yes
CONFIDENCE: 0.95
REASON: Direct opposite.
PAIR_2:
CONTRADICTS: no
CONFIDENCE: 0.05
REASON: Complementary.`,
      2,
    )
    expect(verdicts[0]).toMatchObject({ is_contradiction: true })
    expect(verdicts[1]).toMatchObject({ is_contradiction: false })
  })

  it('clamps confidence to [0, 1]', () => {
    const verdicts = parseBatchContradictionResponse(
      'PAIR_1: CONTRADICTS: yes | CONFIDENCE: 1.7 | REASON: x',
      1,
    )
    expect(verdicts[0]!.confidence).toBe(1)
  })

  it('returns all nulls for an empty or off-format response', () => {
    expect(parseBatchContradictionResponse('', 2)).toEqual([null, null])
    expect(parseBatchContradictionResponse('Sorry, I cannot help with that.', 2)).toEqual([null, null])
  })
})

// ---------------------------------------------------------------------------
// scanForTensions batching (#180)
// ---------------------------------------------------------------------------

describe('scanForTensions batching (#180)', () => {
  /** Three engrams with identical pairwise overlap → deterministic candidate
   *  order (E1,E2), (E1,E3), (E2,E3) via stable sort. */
  function makeTriple(): Engram[] {
    return [
      makeEngram({ id: 'E1', statement: 'plur uses yaml' }),
      makeEngram({ id: 'E2', statement: 'plur uses json' }),
      makeEngram({ id: 'E3', statement: 'plur uses toml' }),
    ]
  }

  const NO_VERDICT = 'CONTRADICTS: no | CONFIDENCE: 0.1 | REASON: Fine.'

  it('groups pairs into batches of batch_size (default 5)', async () => {
    // 5 engrams, all sharing a subject → C(5,2) = 10 candidate pairs → 2 calls
    const engrams = ['yaml', 'json', 'toml', 'xml', 'csv'].map((fmt, i) =>
      makeEngram({ id: `E${i + 1}`, statement: `plur uses ${fmt}` }),
    )
    const llm = vi.fn(async (prompt: string) => {
      const n = (prompt.match(/PAIR \d+/g) ?? []).length
      return Array.from({ length: n }, (_, i) => `PAIR_${i + 1}: ${NO_VERDICT}`).join('\n')
    })

    const result = await scanForTensions(engrams, llm)
    expect(result.pairs_checked).toBe(10)
    expect(llm).toHaveBeenCalledTimes(2)
    expect(result.new_tensions).toBe(0)
  })

  it('maps batch verdicts to the correct pairs', async () => {
    const engrams = makeTriple()
    const llm = vi.fn(async () =>
      [
        `PAIR_1: ${NO_VERDICT}`,
        'PAIR_2: CONTRADICTS: yes | CONFIDENCE: 0.9 | REASON: Conflict.',
        `PAIR_3: ${NO_VERDICT}`,
      ].join('\n'),
    )

    const result = await scanForTensions(engrams, llm, { batch_size: 3 })
    expect(llm).toHaveBeenCalledTimes(1)
    expect(result.new_tensions).toBe(1)
    // PAIR_2 is the second-ranked candidate: (E1, E3)
    expect([result.tensions[0].id_a, result.tensions[0].id_b].sort()).toEqual(['E1', 'E3'])
  })

  it('applies min_confidence per pair in batch mode', async () => {
    const engrams = makeTriple()
    const llm = vi.fn(async () =>
      [
        'PAIR_1: CONTRADICTS: yes | CONFIDENCE: 0.5 | REASON: Weak.',
        'PAIR_2: CONTRADICTS: yes | CONFIDENCE: 0.95 | REASON: Strong.',
        `PAIR_3: ${NO_VERDICT}`,
      ].join('\n'),
    )

    const result = await scanForTensions(engrams, llm, { batch_size: 3 })
    expect(result.new_tensions).toBe(1)
    expect(result.tensions[0].confidence).toBeCloseTo(0.95)
  })

  it('batch_size 1 preserves the sequential single-pair prompt', async () => {
    const engrams = makeTriple()
    const prompts: string[] = []
    const llm = vi.fn(async (prompt: string) => {
      prompts.push(prompt)
      return 'CONTRADICTS: no\nCONFIDENCE: 0.1\nREASON: Fine.'
    })

    const result = await scanForTensions(engrams, llm, { batch_size: 1 })
    expect(llm).toHaveBeenCalledTimes(3)
    expect(result.pairs_checked).toBe(3)
    for (const p of prompts) {
      expect(p).toContain('STATEMENT A')
      expect(p).not.toContain('PAIR 1')
    }
  })

  it('falls back to a single-pair call when a batch verdict is missing', async () => {
    const engrams = makeTriple()
    const llm = vi.fn(async (prompt: string) => {
      if (prompt.includes('PAIR 1')) {
        // Batch response omits PAIR_2
        return [`PAIR_1: ${NO_VERDICT}`, `PAIR_3: ${NO_VERDICT}`].join('\n')
      }
      // Individual fallback call for the missing pair
      return 'CONTRADICTS: yes\nCONFIDENCE: 0.92\nREASON: Recovered by fallback.'
    })

    const result = await scanForTensions(engrams, llm, { batch_size: 3 })
    expect(llm).toHaveBeenCalledTimes(2)
    expect(result.new_tensions).toBe(1)
    expect(result.tensions[0].reason).toContain('fallback')
    // The missing verdict was PAIR_2 → candidate (E1, E3)
    expect([result.tensions[0].id_a, result.tensions[0].id_b].sort()).toEqual(['E1', 'E3'])
  })

  it('falls back to single-pair calls when the whole batch call throws', async () => {
    const engrams = makeTriple()
    const llm = vi.fn(async (prompt: string) => {
      if (prompt.includes('PAIR 1')) throw new Error('batch prompt rejected')
      return 'CONTRADICTS: no\nCONFIDENCE: 0.1\nREASON: Fine.'
    })

    const result = await scanForTensions(engrams, llm, { batch_size: 3 })
    // 1 failed batch call + 3 individual fallback calls
    expect(llm).toHaveBeenCalledTimes(4)
    expect(result.pairs_checked).toBe(3)
    expect(result.new_tensions).toBe(0)
  })

  it('skips pairs silently when individual fallback also fails', async () => {
    const engrams = makeTriple()
    const llm = vi.fn(async () => {
      throw new Error('LLM down')
    })

    const result = await scanForTensions(engrams, llm, { batch_size: 3 })
    expect(result.pairs_checked).toBe(3)
    expect(result.new_tensions).toBe(0)
  })

  it('falls back to the default batch size for NaN or non-finite batch_size', async () => {
    const engrams = makeTriple()
    const llm = vi.fn(async (prompt: string) => {
      const n = (prompt.match(/PAIR \d+/g) ?? []).length
      return Array.from({ length: n }, (_, i) => `PAIR_${i + 1}: ${NO_VERDICT}`).join('\n')
    })

    // e.g. CLI parseInt('abc') → NaN must not poison the batching loop
    const result = await scanForTensions(engrams, llm, { batch_size: NaN })
    expect(result.pairs_checked).toBe(3)
    expect(llm).toHaveBeenCalledTimes(1)
  })

  it('applies max_pairs cap before batching', async () => {
    const engrams = makeTriple()
    const llm = vi.fn(async (prompt: string) => {
      const n = (prompt.match(/PAIR \d+/g) ?? []).length
      return Array.from({ length: n }, (_, i) => `PAIR_${i + 1}: ${NO_VERDICT}`).join('\n')
    })

    const result = await scanForTensions(engrams, llm, { max_pairs: 2, batch_size: 5 })
    expect(result.pairs_checked).toBe(2)
    expect(llm).toHaveBeenCalledTimes(1)
    expect(llm.mock.calls[0][0]).toContain('PAIR 2')
    expect(llm.mock.calls[0][0]).not.toContain('PAIR 3')
  })

  it('checks the highest-overlap pairs first when max_pairs truncates', async () => {
    // Low-overlap pair (E1,E2) inserted first; high-overlap pair (E1,E3) must
    // survive a max_pairs: 1 cap thanks to ranking.
    const e1 = makeEngram({ id: 'E1', statement: 'plur cli config parser reads yaml files from home directory' })
    const e2 = makeEngram({ id: 'E2', statement: 'plur system settings menu' })
    const e3 = makeEngram({ id: 'E3', statement: 'plur cli config parser reads json files from home directory' })

    const llm = vi.fn(async () => 'CONTRADICTS: yes\nCONFIDENCE: 0.9\nREASON: Same subject, different format.')
    const result = await scanForTensions([e1, e2, e3], llm, { max_pairs: 1, batch_size: 1 })
    expect(result.pairs_checked).toBe(1)
    expect([result.tensions[0].id_a, result.tensions[0].id_b].sort()).toEqual(['E1', 'E3'])
  })
})
