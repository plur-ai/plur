/**
 * Deterministic intent-aware query rewriting — #224 (remainder).
 *
 * The intent classifier + per-intent ranking profiles landed earlier; what
 * was still missing from #224 is the REWRITING itself: a deterministic
 * (no-LLM) transform of the query text feeding the lexical (BM25) leg of
 * hybrid recall. The embedding leg and the reranker keep the original
 * natural-language query — embedding models are trained on questions;
 * BM25 is not.
 *
 * Why this matters mechanically: `ftsScore` uses substring matching
 * (`t.includes(qt) || qt.includes(t)`), so interrogative scaffolding
 * tokens like "what" / "who" / "how" are not inert — "what" matches
 * "whatsapp", "how" matches "showed" — and they consume IDF budget.
 *
 * Safety contract (graceful degradation, mirroring the classifier):
 *   - only question-shaped queries are touched;
 *   - the rewrite must leave >= 2 content tokens or the original query is
 *     returned unchanged;
 *   - PLUR_QUERY_REWRITE=off disables the whole feature.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { rewriteLexicalQuery, isQueryRewriteDisabled } from '../src/intent/rewrite.js'
import { classifyQuery } from '../src/intent/classifier.js'
import { hybridSearchWithMeta } from '../src/hybrid-search.js'
import { searchEngrams } from '../src/fts.js'
import { setEmbeddingsEnabled } from '../src/embeddings.js'
import type { Engram } from '../src/schemas/engram.js'

// ─── rewriteLexicalQuery: interrogative scaffolding ──────────────────

describe('rewriteLexicalQuery — interrogative scaffolding (#224)', () => {
  it('strips question scaffolding from a question-shaped query', () => {
    const out = rewriteLexicalQuery('What car does the user drive?')
    expect(out).not.toMatch(/\bwhat\b/i)
    expect(out).not.toMatch(/\bdoes\b/i)
    expect(out).not.toMatch(/\?/)
    // Content words survive, in original order.
    expect(out).toMatch(/car .*user .*drive/i)
  })

  it('strips scaffolding for queries starting with an interrogative even without "?"', () => {
    const out = rewriteLexicalQuery('where is the production database hosted')
    expect(out).not.toMatch(/\bwhere\b/i)
    expect(out).toMatch(/production database hosted/i)
  })

  it('strips mid-query auxiliaries (did/does) in question-shaped queries', () => {
    const out = rewriteLexicalQuery('What Redis client library did the assistant recommend?')
    expect(out).not.toMatch(/\bdid\b/i)
    // "assistant" is content-bearing in a memory store — never stripped.
    expect(out).toMatch(/\bassistant\b/i)
    expect(out).toMatch(/redis client library/i)
  })

  it('leaves non-question queries untouched', () => {
    const q = 'staging deploy target for the ingestion service'
    expect(rewriteLexicalQuery(q)).toBe(q)
  })

  it('does not strip interrogative words inside a non-question statement', () => {
    const q = 'notes explaining how the deploy pipeline works'
    expect(rewriteLexicalQuery(q)).toBe(q)
  })

  it('returns the original when stripping would leave < 2 content tokens', () => {
    // "Who is Karl?" -> stripping leaves only "Karl" -> too weak, keep original.
    const q = 'Who is Karl?'
    expect(rewriteLexicalQuery(q)).toBe(q)
  })

  it('is deterministic', () => {
    const q = 'What database does the user prefer?'
    expect(rewriteLexicalQuery(q)).toBe(rewriteLexicalQuery(q))
  })
})

// ─── rewriteLexicalQuery: temporal anchors ───────────────────────────

describe('rewriteLexicalQuery — temporal anchors (#224)', () => {
  it('drops relative temporal phrases for temporal-intent queries', () => {
    const q = 'What did I say about the deployment target last week?'
    expect(classifyQuery(q).intent).toBe('temporal')
    const out = rewriteLexicalQuery(q, 'temporal')
    expect(out).not.toMatch(/last week/i)
    expect(out).toMatch(/deployment target/i)
  })

  it('drops "N days ago" style anchors', () => {
    const out = rewriteLexicalQuery('Which config value changed three days ago?', 'temporal')
    expect(out).not.toMatch(/three days ago/i)
    expect(out).toMatch(/config value changed/i)
  })

  it('KEEPS ISO dates — they literally match engram temporal fields', () => {
    const out = rewriteLexicalQuery('What happened on 2026-04-15 with the migration?', 'temporal')
    expect(out).toContain('2026-04-15')
    expect(out).toMatch(/migration/i)
  })

  it('does not strip temporal words when intent is not temporal', () => {
    // Explicit non-temporal override: "yesterday" survives.
    const out = rewriteLexicalQuery('the yesterday report archive format', 'general')
    expect(out).toMatch(/yesterday/i)
  })

  it('auto-classifies when no intent is passed', () => {
    const out = rewriteLexicalQuery('What did the standup cover yesterday about the release?')
    expect(out).not.toMatch(/\byesterday\b/i)
    expect(out).toMatch(/standup cover/i)
  })

  it('returns the original when temporal stripping would gut the query', () => {
    const q = 'what happened yesterday?'
    // scaffold-strip removes "what"; "happened" stays but "yesterday" removal
    // would leave a single content token -> keep the stronger form.
    const out = rewriteLexicalQuery(q, 'temporal')
    expect(out).toBe(q)
  })
})

// ─── env kill-switch ─────────────────────────────────────────────────

describe('isQueryRewriteDisabled (#224)', () => {
  const saved = process.env.PLUR_QUERY_REWRITE
  afterEach(() => {
    if (saved === undefined) delete process.env.PLUR_QUERY_REWRITE
    else process.env.PLUR_QUERY_REWRITE = saved
  })

  it('is enabled by default', () => {
    delete process.env.PLUR_QUERY_REWRITE
    expect(isQueryRewriteDisabled()).toBe(false)
  })

  it.each(['off', 'OFF', '0', 'false'])('is disabled for PLUR_QUERY_REWRITE=%s', v => {
    process.env.PLUR_QUERY_REWRITE = v
    expect(isQueryRewriteDisabled()).toBe(true)
  })
})

// ─── wiring: hybrid lexical leg uses the rewritten query ─────────────

function mkEngram(id: string, statement: string): Engram {
  const now = new Date().toISOString()
  return {
    id,
    version: 1,
    status: 'active',
    statement,
    type: 'behavioral',
    scope: 'global',
    tags: [],
    confidence: { band: 'medium' },
    activation: { strength: 0.5, last_accessed: now, access_count: 0 },
    temporal: { learned_at: now },
    provenance: { created_by: 'test', session_id: 'test' },
  } as unknown as Engram
}

describe('hybrid lexical leg wiring (#224)', () => {
  beforeAll(() => setEmbeddingsEnabled(false, 'intent-rewrite wiring tests run BM25-only'))
  afterAll(() => setEmbeddingsEnabled(true))

  const savedEnv = process.env.PLUR_QUERY_REWRITE
  beforeEach(() => { delete process.env.PLUR_QUERY_REWRITE })
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.PLUR_QUERY_REWRITE
    else process.env.PLUR_QUERY_REWRITE = savedEnv
  })

  // "what" substring-matches "whatsapp" in ftsScore — the scaffold token is
  // NOT inert. A corpus with a whatsapp distractor demonstrates the wiring.
  const corpus: Engram[] = [
    mkEngram('e1', 'WhatsApp backup notes'),
    mkEngram('e2', 'the nightly rsync job syncs address contacts for the team'),
    mkEngram('e3', 'grafana dashboards live under the retrieval folder'),
    mkEngram('e4', 'postgres pooling uses pgbouncer in transaction mode'),
    mkEngram('e5', 'the telegram bot forwards trading alerts every morning'),
  ]
  const query = 'What syncs the contacts?'

  it('the rewrite changes BM25 results on a scaffold-sensitive corpus', () => {
    const raw = searchEngrams(corpus, query, 5).map(e => e.id)
    const rewritten = searchEngrams(corpus, rewriteLexicalQuery(query), 5).map(e => e.id)
    expect(raw).toContain('e1') // distractor pulled in by "what"~"whatsapp"
    expect(rewritten).not.toContain('e1')
  })

  it('hybridSearchWithMeta feeds the REWRITTEN query to the BM25 leg', async () => {
    const result = await hybridSearchWithMeta(corpus, query, 5)
    const expected = searchEngrams(corpus, rewriteLexicalQuery(query), 15).slice(0, 5).map(e => e.id)
    expect(result.engrams.map(e => e.id)).toEqual(expected)
    expect(result.mode).toBe('bm25-only')
  })

  it('PLUR_QUERY_REWRITE=off restores the original behavior', async () => {
    process.env.PLUR_QUERY_REWRITE = 'off'
    const result = await hybridSearchWithMeta(corpus, query, 5)
    const expected = searchEngrams(corpus, query, 15).slice(0, 5).map(e => e.id)
    expect(result.engrams.map(e => e.id)).toEqual(expected)
  })
})
