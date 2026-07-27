/**
 * Convergence Phase 5 — what the size-based tier decision actually BUILDS.
 *
 * `backend-selection.test.ts` pins the resolver as a pure function. This file
 * pins the consequence: a store large enough to make brute-force scanning the
 * dominant cost really does get a PGLite index built for it, and the one tier
 * that cannot yet be wired — Postgres, because `Plur`'s write path is still
 * synchronous (ADR-0003) — degrades LOUDLY to the best tier that can.
 *
 * Lives here rather than in the parallel pool because each case boots a WASM
 * Postgres; see vitest.config.ts for why that has to be serial.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { MemoryPrimaryStore } from '../src/store/memory-primary-store.js'
import { PGLITE_MIN_ENGRAMS, POSTGRES_MIN_ENGRAMS } from '../src/backend-selection.js'
import { AVG_YAML_BYTES_PER_ENGRAM } from '../src/store/yaml-primary-store.js'
import type { PrimaryStore } from '../src/store/primary-store.js'

const PGLITE_TIMEOUT = 30_000

/** A store that claims a size without holding one — the estimate is the input. */
function storeClaiming(count: number): PrimaryStore {
  const store = new MemoryPrimaryStore()
  ;(store as unknown as { estimateCount: () => number }).estimateCount = () => count
  return store
}

describe('size-based selection builds the index it selected', () => {
  let dir: string
  const saved = { backend: process.env.PLUR_BACKEND, pg: process.env.PLUR_POSTGRES_URL }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-tier-'))
    delete process.env.PLUR_BACKEND
    delete process.env.PLUR_POSTGRES_URL
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (saved.backend === undefined) delete process.env.PLUR_BACKEND
    else process.env.PLUR_BACKEND = saved.backend
    if (saved.pg === undefined) delete process.env.PLUR_POSTGRES_URL
    else process.env.PLUR_POSTGRES_URL = saved.pg
  })

  it('builds no index for a personal-sized store', async () => {
    const plur = new Plur({ path: dir, store: storeClaiming(PGLITE_MIN_ENGRAMS - 1) })
    await plur.learn('small stores pay for no index')
    await (plur as unknown as { waitForIndex: () => Promise<void> }).waitForIndex()
    expect(plur.backendSelection().tier).toBe('yaml')
    expect(existsSync(join(dir, 'store.pglite'))).toBe(false)
  }, PGLITE_TIMEOUT)

  it('builds a PGLite index once the store crosses the threshold', async () => {
    // This is the behaviour the old resolver could not produce at all: it
    // returned 'sqlite' regardless of size, and with `config.index` undefined
    // that meant no index — so a 5k+ engram store brute-forced cosine over the
    // entire corpus on every recall, in every process.
    const plur = new Plur({ path: dir, store: storeClaiming(PGLITE_MIN_ENGRAMS) })
    await (plur as unknown as { waitForIndex: () => Promise<void> }).waitForIndex()
    expect(plur.backendSelection().tier).toBe('pglite')
    expect(plur.backendSelection().reason).toBe('size')
    expect(existsSync(join(dir, 'store.pglite'))).toBe(true)
  }, PGLITE_TIMEOUT)

  it('estimates from the YAML file itself, with no store injected', async () => {
    // The default path — nobody injects anything, `YamlPrimaryStore` stats the
    // file. Written as ONE fat engram rather than 5,000 real ones on purpose:
    // the estimate is deliberately a stat(), so a test that could only pass by
    // materialising a full 12 MB corpus would be testing the wrong thing.
    const engrams = [{
      id: 'ENG-2026-0726-001',
      statement: 'x'.repeat(AVG_YAML_BYTES_PER_ENGRAM * PGLITE_MIN_ENGRAMS),
      type: 'behavioral',
      scope: 'global',
      domain: 'plur.test',
      status: 'active',
      tags: [],
      activation: { retrieval_strength: 1, storage_strength: 1, frequency: 0, last_accessed: '2026-07-26' },
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    }]
    writeFileSync(join(dir, 'engrams.yaml'), yaml.dump({ engrams }), 'utf8')

    const plur = new Plur({ path: dir })
    await (plur as unknown as { waitForIndex: () => Promise<void> }).waitForIndex()
    expect(plur.backendSelection().tier).toBe('pglite')
    expect(existsSync(join(dir, 'store.pglite'))).toBe(true)
  }, PGLITE_TIMEOUT)
})

describe('the Postgres tier degrades loudly, never silently', async () => {
  let dir: string
  let warnings: string[]
  const saved = { backend: process.env.PLUR_BACKEND, pg: process.env.PLUR_POSTGRES_URL }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-tier-pg-'))
    delete process.env.PLUR_BACKEND
    delete process.env.PLUR_POSTGRES_URL
    warnings = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
    if (saved.backend === undefined) delete process.env.PLUR_BACKEND
    else process.env.PLUR_BACKEND = saved.backend
    if (saved.pg === undefined) delete process.env.PLUR_POSTGRES_URL
    else process.env.PLUR_POSTGRES_URL = saved.pg
  })

  it('says so when a corpus is sized for a server but none is configured', async () => {
    const plur = new Plur({ path: dir, store: storeClaiming(POSTGRES_MIN_ENGRAMS) })
    await (plur as unknown as { waitForIndex: () => Promise<void> }).waitForIndex()
    const selection = plur.backendSelection()
    expect(selection.tier).toBe('pglite')
    expect(selection.wanted).toBe('postgres')
    expect(warnings.join('\n')).toMatch(/past the Postgres threshold/)
    // Degraded, but still indexed — the fallback is a working backend, not none.
    expect(existsSync(join(dir, 'store.pglite'))).toBe(true)
  }, PGLITE_TIMEOUT)

  it('selects postgres when a DSN is configured, and refuses to pretend it is wired', async () => {
    // The collision this phase documents rather than papers over: `Plur`'s
    // write path is synchronous, and no network-backed store can satisfy a
    // synchronous `PrimaryStore`. So the tier resolves to postgres, the process
    // says exactly why it is not using it, and runs the index it CAN run.
    process.env.PLUR_POSTGRES_URL = 'postgres://user:pw@127.0.0.1:5432/nope'
    const plur = new Plur({ path: dir, store: storeClaiming(POSTGRES_MIN_ENGRAMS * 3) })
    await (plur as unknown as { waitForIndex: () => Promise<void> }).waitForIndex()
    expect(plur.backendSelection().tier).toBe('postgres')
    const joined = warnings.join('\n')
    expect(joined).toMatch(/backend=postgres/)
    expect(joined).toMatch(/write path is still synchronous/)
    // The primary store is untouched: nothing silently started writing to a
    // database, and the DSN never appears with its password in the warning.
    expect(plur.primaryStore.kind).toBe('memory')
    expect(joined).not.toContain('pw@')
    expect(existsSync(join(dir, 'store.pglite'))).toBe(true)
  }, PGLITE_TIMEOUT)

  it('an explicit backend: postgres override is honoured as a selection, not ignored', async () => {
    process.env.PLUR_BACKEND = 'postgres'
    const plur = new Plur({ path: dir })
    await (plur as unknown as { waitForIndex: () => Promise<void> }).waitForIndex()
    const selection = plur.backendSelection()
    expect(selection.tier).toBe('postgres')
    expect(selection.reason).toBe('env-override')
    expect(warnings.join('\n')).toMatch(/backend=postgres/)
  }, PGLITE_TIMEOUT)
})
