import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { routeForIntent } from '../src/intent/route.js'
import { setEmbeddingsEnabled, resetEmbedder } from '../src/embeddings.js'

describe('routeForIntent — per-intent ranking profile', () => {
  it('general profile is the neutral baseline (all multipliers = 1.0)', () => {
    const p = routeForIntent('general')
    expect(p.bm25Weight).toBe(1.0)
    expect(p.vectorWeight).toBe(1.0)
    expect(p.recencyBoost).toBe(1.0)
    expect(p.episodeBoost).toBe(1.0)
    expect(p.entityBoost).toBe(1.0)
  })

  it('temporal profile tilts recencyBoost above baseline', () => {
    const p = routeForIntent('temporal')
    expect(p.recencyBoost).toBeGreaterThan(1.0)
    // Modest tilt — wrong classification must not silently destroy ranking
    expect(p.recencyBoost).toBeLessThanOrEqual(1.5)
  })

  it('entity profile tilts entityBoost above baseline', () => {
    const p = routeForIntent('entity')
    expect(p.entityBoost).toBeGreaterThan(1.0)
    expect(p.entityBoost).toBeLessThanOrEqual(1.5)
  })

  it('event profile tilts episodeBoost above baseline', () => {
    const p = routeForIntent('event')
    expect(p.episodeBoost).toBeGreaterThan(1.0)
    expect(p.episodeBoost).toBeLessThanOrEqual(1.5)
  })

  it('every profile keeps weights in modest range — no destructive multipliers', () => {
    for (const intent of ['general', 'entity', 'temporal', 'event'] as const) {
      const p = routeForIntent(intent)
      for (const v of Object.values(p)) {
        expect(v).toBeGreaterThanOrEqual(0.5)
        expect(v).toBeLessThanOrEqual(2.0)
      }
    }
  })
})

describe('intent routing — recall integration', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-intent-'))
    // Disable embeddings via config.yaml so tests stay BM25-only and fast.
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    setEmbeddingsEnabled(false)
    resetEmbedder()
    plur = new Plur({ path: dir })

    // Mix of old vs recent engrams. Recent engrams should win for temporal
    // queries when intent routing is active.
    plur.learn('The capital of France is Paris', { type: 'terminological' })
    plur.learn('TypeScript strict mode catches null errors', { type: 'behavioral' })
    plur.learn('We decided to use PostgreSQL for the database', { type: 'architectural' })
    plur.learn('Yesterday we deployed the new auth service', { type: 'behavioral' })
    plur.learn('This morning Karl confirmed the contract terms', { type: 'behavioral' })
    plur.learn('Karl Schmidt works at Acme as the head of sales', {
      type: 'terminological',
      domain: 'crm.contacts',
    })
    plur.learn('Karl prefers email over phone for outreach', {
      type: 'behavioral',
      domain: 'crm.contacts',
    })
  })

  afterEach(() => {
    setEmbeddingsEnabled(true)
    resetEmbedder()
    rmSync(dir, { recursive: true })
  })

  it('recall returns results unchanged when intent routing OFF (env opt-out)', async () => {
    const original = process.env.PLUR_INTENT_ROUTING
    process.env.PLUR_INTENT_ROUTING = 'off'
    try {
      const results = plur.recall('Karl')
      expect(results.length).toBeGreaterThan(0)
    } finally {
      if (original === undefined) delete process.env.PLUR_INTENT_ROUTING
      else process.env.PLUR_INTENT_ROUTING = original
    }
  })

  it('accepts intentOverride option', async () => {
    // Should not throw — the override is a valid option
    const results = plur.recall('Karl', { intentOverride: 'entity' } as any)
    expect(Array.isArray(results)).toBe(true)
  })

  it('entity-intent recall surfaces entity-domain engrams (crm.contacts)', () => {
    const results = plur.recall("Karl's email", { intentOverride: 'entity' } as any)
    expect(results.length).toBeGreaterThan(0)
    // The top result should be one of the crm.contacts engrams (entity-typed)
    const top = results[0]
    expect(top.domain === 'crm.contacts' || top.statement.includes('Karl')).toBe(true)
  })

  it('intent routing does not silently drop results — wrong intent still returns hits', () => {
    // Even with mismatched intent, the query should still recall results
    const r1 = plur.recall('PostgreSQL database', { intentOverride: 'temporal' } as any)
    const r2 = plur.recall('PostgreSQL database', { intentOverride: 'general' } as any)
    expect(r1.length).toBeGreaterThan(0)
    expect(r2.length).toBeGreaterThan(0)
  })

  it('default behavior is intent routing ON', async () => {
    // No env override, no intentOverride — should still return results
    delete process.env.PLUR_INTENT_ROUTING
    const results = plur.recall('Karl email')
    expect(results.length).toBeGreaterThan(0)
  })

  it('recallHybrid accepts intentOverride and returns results', async () => {
    const results = await plur.recallHybrid('Karl', { intentOverride: 'entity' } as any)
    expect(Array.isArray(results)).toBe(true)
  })

  it('recallSemantic accepts intentOverride and returns results', async () => {
    const results = await plur.recallSemantic('Karl', { intentOverride: 'entity' } as any)
    expect(Array.isArray(results)).toBe(true)
  })
})
