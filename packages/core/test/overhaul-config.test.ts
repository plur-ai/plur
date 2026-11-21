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
  invalidOverhaulConfigKeys,
} from '../src/schemas/config.js'
import { loadConfig } from '../src/config.js'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('overhaul config keys', () => {
  it('parse without gaining defaults that were never written', () => {
    const parsed = PlurConfigSchema.parse({ injection: { spread_cap: 3 }, pinning: {}, consolidate: {}, learn: {} })
    expect(parsed.injection).toEqual({ spread_cap: 3, spread_budget: 480, co_access: true, pinned_ratio: 0.5, pinned_hard_ratio: 0.5 })
    expect(parsed.pinning).toEqual({})
    expect(parsed.consolidate).toEqual({})
    expect(parsed.learn).toEqual({})
    expect(PlurConfigSchema.parse({})).toEqual({})
  })

  it('resolve to the documented defaults (unified injection on, owner decision 2026-11-16)', () => {
    const empty = PlurConfigSchema.parse({})
    expect(resolveInjectionOverhaul(empty)).toEqual({
      mode: 'unified',
      recall_limit: 20,
      prohibition_ratio: 0.2,
      query_min_terms: 4,
      min_relevance_signal: null,
      min_relevance: null,
    })
    expect(resolvePinningConfig(empty)).toEqual({ agents: 'allow' })
    expect(resolveConsolidateConfig(empty)).toEqual({ threshold: 0.85, apply_enabled: false, nightly_max_changes: 25 })
    expect(resolveLearnConfig(empty)).toEqual({ reinforce_exact: false })
  })

  it('keeps legacy injection reachable as the rollback path', () => {
    expect(resolveInjectionOverhaul(PlurConfigSchema.parse({ injection: { mode: 'legacy' } })).mode).toBe('legacy')
    // An invalid value is dropped on its own, so the default (unified) applies.
    expect(resolveInjectionOverhaul(PlurConfigSchema.parse({ injection: { mode: 'bogus' } })).mode).toBe('unified')
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
    ['consolidate.threshold', { consolidate: { threshold: 1.2 } }],
    ['consolidate.apply_enabled', { consolidate: { apply_enabled: 'yes' } }],
    ['consolidate.nightly_max_changes', { consolidate: { nightly_max_changes: -5 } }],
    ['learn.reinforce_exact', { learn: { reinforce_exact: 1 } }],
  ])('drops an invalid %s and keeps the rest of the config (H4)', (name, raw) => {
    const key = name.split(' ')[0]!
    const [block, field] = key.split('.') as [string, string]
    const withStore = { ...raw, stores: [{ path: '/tmp/plur-h4-store', scope: 'project:h4' }], injection_budget: 1234 }
    const parsed = PlurConfigSchema.safeParse(withStore)
    expect(parsed.success).toBe(true)
    const data = parsed.data as Record<string, Record<string, unknown> | undefined>
    expect(data[block]?.[field]).toBeUndefined()
    expect((parsed.data as { stores?: unknown[] }).stores).toHaveLength(1)
    expect((parsed.data as { injection_budget?: number }).injection_budget).toBe(1234)
    expect(invalidOverhaulConfigKeys(raw)).toEqual([key])
  })

  it('an invalid pinning.agents fails safe to request, not allow, and keeps the rest of the config', () => {
    const raw = { pinning: { agents: 'denny' } }
    const parsed = PlurConfigSchema.safeParse({ ...raw, injection_budget: 1234 })
    expect(parsed.success).toBe(true)
    expect(resolvePinningConfig(parsed.data)).toEqual({ agents: 'request' })
    expect((parsed.data as { injection_budget?: number }).injection_budget).toBe(1234)
    expect(invalidOverhaulConfigKeys(raw)).toEqual(['pinning.agents'])
    expect(resolvePinningConfig(PlurConfigSchema.parse({}))).toEqual({ agents: 'allow' })
  })

  it('reports no invalid keys for a valid or absent block (H4)', () => {
    expect(invalidOverhaulConfigKeys({})).toEqual([])
    expect(invalidOverhaulConfigKeys({ injection: { mode: 'unified' }, pinning: { agents: 'deny' } })).toEqual([])
    expect(invalidOverhaulConfigKeys({ injection: 'garbage' })).toEqual([])
  })

  it('keeps unknown injection keys a newer release wrote (H12 downgrade)', () => {
    const parsed = PlurConfigSchema.parse({ injection: { future_knob: 7, mode: 'unified' } })
    expect((parsed.injection as Record<string, unknown>).future_knob).toBe(7)
  })
})

describe('loadConfig with one bad overhaul value (H4)', () => {
  it('keeps every store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-h4-'))
    try {
      const path = join(dir, 'config.yaml')
      writeFileSync(path, 'stores:\n  - path: /tmp/plur-h4-a\n    scope: project:a\ninjection:\n  mode: hybrid\npinning:\n  agents: maybe\n')
      const cfg = loadConfig(path)
      expect(cfg.stores).toHaveLength(1)
      expect(cfg.injection?.mode).toBeUndefined()
      expect(cfg.pinning?.agents).toBe('request') // fails safe, never allow
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('recall_limit default (2026-11-17)', () => {
  it('the unified task list defaults to 20 engrams', async () => {
    const { UNIFIED_RECALL_LIMIT } = await import('../src/inject-unified.js')
    expect(UNIFIED_RECALL_LIMIT).toBe(20)
  })
})
