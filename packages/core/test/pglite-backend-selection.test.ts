/**
 * Convergence Phase 5 — what the size-based tier decision actually BUILDS.
 *
 * `backend-selection.test.ts` pins the resolver as a pure function. This file
 * pins the consequence: a store large enough to make brute-force scanning the
 * dominant cost really does get an INDEX built for it — SQLite since #1046
 * (PGLite is opt-in only; see the ADR-0005 amendment) — and the one tier
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
import { logger } from '../src/logger.js'
import { MemoryPrimaryStore } from '../src/store/memory-primary-store.js'
import { SQLITE_MIN_ENGRAMS, POSTGRES_MIN_ENGRAMS } from '../src/backend-selection.js'
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
    const plur = new Plur({ path: dir, store: storeClaiming(SQLITE_MIN_ENGRAMS - 1) })
    await plur.learn('small stores pay for no index')
    await (plur as unknown as { waitForIndex: () => Promise<void> }).waitForIndex()
    expect(plur.backendSelection().tier).toBe('yaml')
    expect(existsSync(join(dir, 'store.pglite'))).toBe(false)
  }, PGLITE_TIMEOUT)

  it('builds a SQLite index once the store crosses the threshold', async () => {
    // The property that matters is that a store past the threshold gets an
    // INDEX rather than brute-forcing cosine over the whole corpus on every
    // recall. #1046 changed which index: PGLite boots Postgres in WASM per
    // process, which is the wrong shape for a per-invocation CLI at any size.
    const plur = new Plur({ path: dir, store: storeClaiming(SQLITE_MIN_ENGRAMS) })
    await (plur as unknown as { waitForIndex: () => Promise<void> }).waitForIndex()
    expect(plur.backendSelection().tier).toBe('sqlite')
    expect(plur.backendSelection().reason).toBe('size')
    // Growth must never conjure a PGLite store on disk.
    expect(existsSync(join(dir, 'store.pglite'))).toBe(false)
  }, PGLITE_TIMEOUT)

  it('estimates from the YAML file itself, with no store injected', async () => {
    // The default path — nobody injects anything, `YamlPrimaryStore` stats the
    // file. Written as ONE fat engram rather than 5,000 real ones on purpose:
    // the estimate is deliberately a stat(), so a test that could only pass by
    // materialising a full 12 MB corpus would be testing the wrong thing.
    const engrams = [{
      id: 'ENG-2026-0726-001',
      statement: 'x'.repeat(AVG_YAML_BYTES_PER_ENGRAM * SQLITE_MIN_ENGRAMS),
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
    expect(plur.backendSelection().tier).toBe('sqlite')
    expect(existsSync(join(dir, 'store.pglite'))).toBe(false)
  }, PGLITE_TIMEOUT)
})

describe('the Postgres tier degrades loudly, never silently', () => {
  let dir: string
  let logs: string[]
  const saved = { backend: process.env.PLUR_BACKEND, pg: process.env.PLUR_POSTGRES_URL }

  /**
   * Capture the LOGGER, not `console.error`.
   *
   * `logger.info` is filtered out at the default `PLUR_LOG_LEVEL` (warning),
   * and the threshold is read once at module load — so a `console.error` spy
   * never observes the info-level lines this suite is about, and any assertion
   * against them was really an assertion against the empty string. Spying the
   * logger records the call arguments whatever the threshold does with them.
   */
  const captureLevel = (level: 'debug' | 'info' | 'warning' | 'error') => {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      logs.push(`[${level}] ${args.map(String).join(' ')}`)
    })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-tier-pg-'))
    delete process.env.PLUR_BACKEND
    delete process.env.PLUR_POSTGRES_URL
    logs = []
    captureLevel('debug')
    captureLevel('info')
    captureLevel('warning')
    captureLevel('error')
    // Anything bypassing the logger still gets recorded, and stays out of the
    // test output.
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
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
    expect(selection.tier).toBe('sqlite')
    expect(selection.wanted).toBe('postgres')
    expect(logs.join('\n')).toMatch(/past the Postgres threshold/)
    // Degraded, but still indexed — the fallback is a working backend, not none.
    expect(existsSync(join(dir, 'store.pglite'))).toBe(false)
  }, PGLITE_TIMEOUT)

  it('selects postgres when a DSN is configured, but never connects on its own', async () => {
    // Phase 2b removed the constraint this test used to pin. The write path is
    // async now, so a Postgres store CAN be the primary — see
    // postgres-primary-store.test.ts, which proves it end to end.
    //
    // What must NOT change is that selection never OPENS a connection by
    // itself. A DSN in the environment resolves the tier and nothing more: a
    // connection has credentials and a lifecycle, and a constructor that dials
    // out because a config string was present puts failure somewhere nobody is
    // looking. The caller passes the adapter in explicitly.
    const password = 'n0t-in-any-log'
    const dsn = `postgres://user:${password}@127.0.0.1:5432/nope`
    process.env.PLUR_POSTGRES_URL = dsn
    const plur = new Plur({ path: dir, store: storeClaiming(POSTGRES_MIN_ENGRAMS * 3) })
    await (plur as unknown as { waitForIndex: () => Promise<void> }).waitForIndex()
    expect(plur.backendSelection().tier).toBe('postgres')
    // The store it was constructed with is the store it uses. The unreachable
    // DSN above is proof: had anything dialled it, this would have thrown.
    expect(plur.primaryStore.kind).toBe('memory')
    expect(existsSync(join(dir, 'store.pglite'))).toBe(true)

    // Choosing this tier is ANNOUNCED — a deployment that silently is not on
    // the store it configured is the failure this whole phase removes. Pinned
    // before the credential check below, because "the DSN is absent" is
    // trivially true of a log nobody wrote, and that is exactly what the
    // previous version of this assertion was checking.
    const emitted = logs.join('\n')
    expect(emitted, 'nothing was logged — the credential assertion would be vacuous')
      .toMatch(/backend=postgres selected/)
    // And the announcement carries no credentials: not the password, and not
    // the DSN it came from.
    expect(emitted).not.toContain(password)
    expect(emitted).not.toContain(dsn)
  }, PGLITE_TIMEOUT)

  it('an explicit backend: postgres override is honoured as a selection, not ignored', async () => {
    process.env.PLUR_BACKEND = 'postgres'
    const plur = new Plur({ path: dir })
    await (plur as unknown as { waitForIndex: () => Promise<void> }).waitForIndex()
    const selection = plur.backendSelection()
    expect(selection.tier).toBe('postgres')
    expect(selection.reason).toBe('env-override')
    // The override is a SELECTION, not an instruction to connect. With a
    // default (YAML) store and no adapter passed, core says so at info level
    // and keeps the store it was given.
    expect(plur.primaryStore.kind).toBe('yaml')
  }, PGLITE_TIMEOUT)
})

/**
 * Selection and construction must agree — the regression class that shipped
 * TWICE on this branch's history. `resolveBackendTier` said 'sqlite' while
 * the constructor's `else if (this.config.index)` arm never fired, because
 * PlurConfigSchema is `.partial()` and that neutralises Zod defaults, so
 * `config.index` is undefined on a default install. Every recall then
 * brute-forced cosine over the whole corpus (ADR-0005 §1). The suite stayed
 * green throughout, because selection tests and construction tests each
 * passed separately. This is the test that fails when they disagree.
 */
describe('a size-selected tier materialises its index (#1046 follow-up)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-tier-idx-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('default install past the threshold builds the SQLite index, no config needed', async () => {
    const plur = new Plur({ path: dir, store: storeClaiming(SQLITE_MIN_ENGRAMS) })
    await (plur as unknown as { waitForIndex: () => Promise<void> }).waitForIndex()
    expect(plur.backendSelection().tier).toBe('sqlite')
    // The assertion that was missing: the index OBJECT exists, not just the label.
    expect((plur as unknown as { indexedStorage: unknown }).indexedStorage).toBeTruthy()
  })

  it('explicit index:false still opts out', async () => {
    // Config comes from config.yaml on disk — the constructor takes no inline
    // config, which is itself why the .partial() default-neutralisation bug
    // was reachable at all.
    writeFileSync(join(dir, 'config.yaml'), 'index: false\n')
    const plur = new Plur({ path: dir, store: storeClaiming(SQLITE_MIN_ENGRAMS) })
    await (plur as unknown as { waitForIndex: () => Promise<void> }).waitForIndex()
    expect((plur as unknown as { indexedStorage: unknown }).indexedStorage).toBeNull()
  })
})
