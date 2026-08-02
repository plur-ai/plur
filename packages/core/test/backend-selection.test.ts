/**
 * Convergence Phase 5 — size-based backend selection (ADR-0005).
 *
 * What was wrong: `Plur._resolveBackend()` read an env var, then a config
 * field, then returned `'sqlite'`. Nothing about the actual corpus entered the
 * decision — and because `config.index` is undefined by default, the `'sqlite'`
 * default meant **no index was built at all**. Every recall loaded the whole
 * corpus into the process and brute-forced cosine over it, in every process,
 * forever. A 4,700-engram store costs ~350 MB resident that way.
 *
 * These tests pin the replacement: a pure, total tier resolver; a size estimate
 * that must not parse the corpus to produce it; and the override precedence
 * that keeps an operator's explicit choice sovereign over the automatic one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import {
  resolveBackendTier,
  BACKEND_TIERS,
  PGLITE_MIN_ENGRAMS,
  POSTGRES_MIN_ENGRAMS,
  type BackendTier,
} from '../src/backend-selection.js'
import { YamlPrimaryStore, AVG_YAML_BYTES_PER_ENGRAM } from '../src/store/yaml-primary-store.js'
import { MemoryPrimaryStore } from '../src/store/memory-primary-store.js'
import { Plur } from '../src/index.js'
import type { Engram } from '../src/schemas/engram.js'

function mkEngram(id: string): Engram {
  return {
    id,
    statement: `statement ${id}`,
    type: 'behavioral',
    scope: 'global',
    domain: 'plur.test',
    status: 'active',
    tags: [],
    activation: {
      retrieval_strength: 1.0,
      storage_strength: 1.0,
      frequency: 0,
      last_accessed: '2026-07-26',
    },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
  } as unknown as Engram
}

describe('resolveBackendTier — size-based selection', () => {
  it('keeps a personal-sized store on the YAML tier', () => {
    const s = resolveBackendTier({ engramCount: 400, postgresConfigured: false })
    expect(s.tier).toBe('yaml')
    expect(s.reason).toBe('size')
    expect(s.wanted).toBeUndefined()
  })

  it('escalates to PGLite at the documented threshold, not one engram earlier', () => {
    expect(resolveBackendTier({ engramCount: PGLITE_MIN_ENGRAMS - 1, postgresConfigured: false }).tier)
      .toBe('yaml')
    expect(resolveBackendTier({ engramCount: PGLITE_MIN_ENGRAMS, postgresConfigured: false }).tier)
      .toBe('pglite')
  })

  it('escalates to Postgres at its threshold when a connection string is configured', () => {
    const below = resolveBackendTier({ engramCount: POSTGRES_MIN_ENGRAMS - 1, postgresConfigured: true })
    expect(below.tier).toBe('pglite')
    const at = resolveBackendTier({ engramCount: POSTGRES_MIN_ENGRAMS, postgresConfigured: true })
    expect(at.tier).toBe('postgres')
    expect(at.reason).toBe('size')
  })

  it('caps at PGLite when the corpus wants Postgres but nothing is configured — and SAYS so', () => {
    const s = resolveBackendTier({ engramCount: POSTGRES_MIN_ENGRAMS * 4, postgresConfigured: false })
    // The whole point of `wanted`: falling back is fine, falling back silently
    // is the failure mode. A caller can see it asked for a server and did not
    // get one.
    expect(s.tier).toBe('pglite')
    expect(s.wanted).toBe('postgres')
    expect(s.engramCount).toBe(POSTGRES_MIN_ENGRAMS * 4)
  })

  it('is total: nonsense counts degrade to the smallest tier rather than throwing', () => {
    for (const count of [NaN, -1, -99999, Infinity]) {
      const s = resolveBackendTier({ engramCount: count, postgresConfigured: false })
      // Infinity is not finite, so it is treated as "unknown" = 0, not as huge.
      expect(s.tier).toBe('yaml')
      expect(s.engramCount).toBe(0)
    }
  })
})

describe('resolveBackendTier — overrides beat the estimate', () => {
  it('honours every tier name from the env var, whatever the size says', () => {
    for (const tier of BACKEND_TIERS) {
      const s = resolveBackendTier({ env: tier, engramCount: 1_000_000, postgresConfigured: false })
      expect(s.tier).toBe(tier)
      expect(s.reason).toBe('env-override')
    }
  })

  it('honours the config field when no env var is set', () => {
    const s = resolveBackendTier({ config: 'yaml', engramCount: 1_000_000, postgresConfigured: true })
    expect(s.tier).toBe('yaml')
    expect(s.reason).toBe('config-override')
  })

  it('lets the env var beat the config field', () => {
    const s = resolveBackendTier({ env: 'sqlite', config: 'pglite', engramCount: 0, postgresConfigured: false })
    expect(s.tier).toBe('sqlite')
    expect(s.reason).toBe('env-override')
  })

  it('ignores an unknown override instead of failing the process', () => {
    const s = resolveBackendTier({ env: 'mongodb', config: 'nonsense', engramCount: 10, postgresConfigured: false })
    expect(s.tier).toBe('yaml')
    expect(s.reason).toBe('size')
  })

  it('lets an explicit postgres override through even with no connection string', () => {
    // Configuring `backend: postgres` and forgetting the URL should surface as
    // a connection error at first use, not as a silent demotion to a different
    // backend. Only the AUTOMATIC path is allowed to decline.
    const s = resolveBackendTier({ config: 'postgres', engramCount: 10, postgresConfigured: false })
    expect(s.tier).toBe('postgres')
    expect(s.reason).toBe('config-override')
  })
})

describe('PrimaryStore.estimateCount — cheap by contract', () => {
  let dir: string
  let yamlPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-backend-sel-'))
    yamlPath = join(dir, 'engrams.yaml')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('reports 0 for a store that does not exist yet', () => {
    expect(new YamlPrimaryStore(yamlPath).estimateCount()).toBe(0)
  })

  it('derives an order-of-magnitude count from the file size without parsing it', () => {
    // 300 engrams' worth of bytes, written as one opaque blob. If the estimate
    // were parsing the file it would say 0 here — the point is that it does not
    // have to, because parsing a multi-megabyte YAML just to choose a backend
    // is exactly the cost the chosen backend exists to avoid.
    writeFileSync(yamlPath, 'x'.repeat(AVG_YAML_BYTES_PER_ENGRAM * 300), 'utf8')
    expect(new YamlPrimaryStore(yamlPath).estimateCount()).toBe(300)
  })

  it('is exact once a snapshot is cached — no reason to estimate what we hold', async () => {
    const engrams = Array.from({ length: 7 }, (_, i) => mkEngram(`ENG-2026-0726-${String(i).padStart(3, '0')}`))
    writeFileSync(yamlPath, yaml.dump({ engrams }), 'utf8')
    const store = new YamlPrimaryStore(yamlPath)
    await store.loadCached()
    expect(store.estimateCount()).toBe(7)
  })

  it('is exact for an in-memory store', () => {
    const store = new MemoryPrimaryStore([mkEngram('ENG-2026-0726-001'), mkEngram('ENG-2026-0726-002')])
    expect(store.estimateCount()).toBe(2)
  })
})

describe('Plur.backendSelection — the instance can say which tier it is on, and why', () => {
  let dir: string
  const savedEnv = { backend: process.env.PLUR_BACKEND, pg: process.env.PLUR_POSTGRES_URL }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-backend-inst-'))
    delete process.env.PLUR_BACKEND
    delete process.env.PLUR_POSTGRES_URL
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (savedEnv.backend === undefined) delete process.env.PLUR_BACKEND
    else process.env.PLUR_BACKEND = savedEnv.backend
    if (savedEnv.pg === undefined) delete process.env.PLUR_POSTGRES_URL
    else process.env.PLUR_POSTGRES_URL = savedEnv.pg
  })

  it('reports the YAML tier for a fresh personal store', () => {
    const plur = new Plur({ path: dir })
    const s = plur.backendSelection()
    expect(s.tier).toBe('yaml')
    expect(s.reason).toBe('size')
    expect(s.engramCount).toBe(0)
  })

  it('stays on the YAML tier after a handful of writes — no index churn for a small store', async () => {
    const plur = new Plur({ path: dir })
    await plur.learn('the estimate is not a reason to build an index')
    expect(new Plur({ path: dir }).backendSelection().tier).toBe('yaml')
  })

  it('honours PLUR_BACKEND=yaml even when the store is enormous', () => {
    // A large store WOULD boot an index; the override says no, and the override
    // wins. (The escalation direction — large store actually selects PGLite —
    // needs a real WASM boot and lives in pglite-backend-selection.test.ts.)
    process.env.PLUR_BACKEND = 'yaml'
    const store = new MemoryPrimaryStore()
    ;(store as unknown as { estimateCount: () => number }).estimateCount = () => 10_000_000
    const s = new Plur({ path: dir, store }).backendSelection()
    expect(s.tier).toBe('yaml')
    expect(s.reason).toBe('env-override')
  })

  it('treats a store with no estimateCount as small rather than guessing', () => {
    // `estimateCount` is optional on the interface. An implementation that
    // cannot cost one out must not be assumed huge (needless index) or
    // interrogated some other way (a parse, which is the cost we are avoiding).
    const noEstimate = {
      kind: 'memory' as const,
      location: null,
      load: async () => [],
      loadCached: async () => [],
      save: async () => {},
      invalidate: () => {},
    }
    // `allowUnprotectedStore` rather than a `refusesUnreadable` claim, because
    // this stub genuinely under-reports — `load()` always returns [] — and the
    // flag must never be declared falsely (audit #794 / #802). Tier selection
    // is a read-path question; nothing here writes, so accepting the unsafe
    // store is honest and sufficient.
    const tier: BackendTier = new Plur({ path: dir, store: noEstimate, allowUnprotectedStore: true })
      .backendSelection().tier
    expect(tier).toBe('yaml')
  })
})
