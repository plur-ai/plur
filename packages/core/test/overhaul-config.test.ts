/**
 * Config keys for the retrieval and injection overhaul (W0).
 *
 * The keys are declared now so later workstreams read one schema, but nothing
 * reads them yet: an absent key stays absent on parse (the config must not
 * gain defaults that were never written — see zod-compat.test.ts), and the
 * documented defaults come from the resolvers, which reproduce today's
 * behaviour.
 */
import { describe, it, expect } from 'vitest'
import {
  PlurConfigSchema,
  resolveInjectionOverhaul,
  resolvePinningConfig,
  resolveConsolidateConfig,
  resolveLearnConfig,
} from '../src/schemas/config.js'

describe('overhaul config keys', () => {
  it('parse without gaining defaults that were never written', () => {
    const parsed = PlurConfigSchema.parse({ injection: { spread_cap: 3 }, pinning: {}, consolidate: {}, learn: {} })
    expect(parsed.injection).toEqual({ spread_cap: 3, spread_budget: 480, co_access: true, pinned_ratio: 0.5, pinned_hard_ratio: 0.5 })
    expect(parsed.pinning).toEqual({})
    expect(parsed.consolidate).toEqual({})
    expect(parsed.learn).toEqual({})
    expect(PlurConfigSchema.parse({})).toEqual({})
  })

  it('resolve to defaults that change nothing', () => {
    const empty = PlurConfigSchema.parse({})
    expect(resolveInjectionOverhaul(empty)).toEqual({
      mode: 'legacy',
      recall_limit: 10,
      prohibition_ratio: 0.2,
      query_min_terms: 4,
      min_relevance_signal: null,
      min_relevance: null,
    })
    expect(resolvePinningConfig(empty)).toEqual({ agents: 'allow' })
    expect(resolveConsolidateConfig(empty)).toEqual({ threshold: 0.85, apply_enabled: false, nightly_max_changes: 25 })
    expect(resolveLearnConfig(empty)).toEqual({ reinforce_exact: false })
  })

  it('parse and resolve explicit values', () => {
    const cfg = PlurConfigSchema.parse({
      injection: { mode: 'unified', recall_limit: 15, prohibition_ratio: 0.3, query_min_terms: 6, min_relevance_signal: 'reranker', min_relevance: 0.4 },
      pinning: { agents: 'request' },
      consolidate: { threshold: 0.9, apply_enabled: true, nightly_max_changes: 10 },
      learn: { reinforce_exact: true },
    })
    expect(resolveInjectionOverhaul(cfg)).toEqual({
      mode: 'unified', recall_limit: 15, prohibition_ratio: 0.3, query_min_terms: 6, min_relevance_signal: 'reranker', min_relevance: 0.4,
    })
    expect(resolvePinningConfig(cfg)).toEqual({ agents: 'request' })
    expect(resolveConsolidateConfig(cfg)).toEqual({ threshold: 0.9, apply_enabled: true, nightly_max_changes: 10 })
    expect(resolveLearnConfig(cfg)).toEqual({ reinforce_exact: true })
  })

  it.each([
    ['injection.mode', { injection: { mode: 'hybrid' } }],
    ['injection.recall_limit', { injection: { recall_limit: 0 } }],
    ['injection.recall_limit (fraction)', { injection: { recall_limit: 2.5 } }],
    ['injection.prohibition_ratio', { injection: { prohibition_ratio: 1.5 } }],
    ['injection.query_min_terms', { injection: { query_min_terms: -1 } }],
    ['injection.min_relevance_signal', { injection: { min_relevance_signal: 'vibes' } }],
    ['injection.min_relevance', { injection: { min_relevance: 'high' } }],
    ['pinning.agents', { pinning: { agents: 'maybe' } }],
    ['consolidate.threshold', { consolidate: { threshold: 1.2 } }],
    ['consolidate.apply_enabled', { consolidate: { apply_enabled: 'yes' } }],
    ['consolidate.nightly_max_changes', { consolidate: { nightly_max_changes: -5 } }],
    ['learn.reinforce_exact', { learn: { reinforce_exact: 1 } }],
  ])('rejects an invalid %s', (_name, raw) => {
    expect(PlurConfigSchema.safeParse(raw).success).toBe(false)
  })
})
