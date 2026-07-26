import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { Plur } from '../src/index.js'
import { MemoryPrimaryStore } from '../src/store/memory-primary-store.js'

/**
 * Convergence Phase 1 — the `Plur` class must not know where its engrams live.
 *
 * Before this change it called `loadEngrams(this.paths.engrams)` /
 * `saveEngrams(...)` at ~35 sites, which is a hard-coded "YAML on disk is the
 * source of truth" assumption and the blocker for enterprise running Postgres
 * as the store of record. Now every read and write goes through a
 * `PrimaryStore`.
 *
 * The proof is behavioural: run the engram lifecycle against a store with no
 * filesystem backing and observe that (a) it works and (b) no engrams.yaml is
 * ever created.
 */

const here = dirname(fileURLToPath(import.meta.url))

describe('Plur is source-of-truth agnostic', () => {
  let dir: string
  let yamlPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-sot-'))
    yamlPath = join(dir, 'engrams.yaml')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('defaults to a YAML primary store — single-user behaviour is unchanged', () => {
    const plur = new Plur({ path: dir })
    expect(plur.primaryStore.kind).toBe('yaml')
    expect(plur.primaryStore.location).toBe(yamlPath)

    plur.learn('the default store still writes engrams.yaml')
    expect(existsSync(yamlPath)).toBe(true)
    expect(readFileSync(yamlPath, 'utf8')).toContain('the default store still writes engrams.yaml')
  })

  // `feedback` and `forget` are declared `Promise`-returning and must be
  // awaited. They used to complete synchronously anyway — an `async` function
  // runs to its first `await`, and with the synchronous `withLock` there was
  // none — so an un-awaited call happened to take effect immediately. Phase 2
  // put a real await in the write path, which turns that accident back into
  // what the signature always said. Assertions below are unchanged.
  it('runs the full learn → recall → update → forget cycle on an injected store', async () => {
    const store = new MemoryPrimaryStore()
    const plur = new Plur({ path: dir, store })
    expect(plur.primaryStore.kind).toBe('memory')

    const learned = plur.learn('kubernetes probes belong on the readiness endpoint', { domain: 'infra' })
    expect(learned.id).toBeTruthy()

    // Read back through the public API…
    expect(plur.getById(learned.id)?.statement).toContain('readiness endpoint')
    // …and through search, which goes down the _loadAllEngrams path.
    expect(plur.recall('readiness endpoint').map(e => e.id)).toContain(learned.id)

    // Mutating write path.
    await plur.feedback(learned.id, 'positive')
    await plur.forget(learned.id, 'no longer true')
    expect(plur.getById(learned.id)?.status).toBe('retired')

    // The state genuinely lives in the injected store, not in a hidden cache.
    expect(store.load().map(e => e.id)).toContain(learned.id)
  })

  it('never touches engrams.yaml when a non-YAML store is injected', () => {
    const plur = new Plur({ path: dir, store: new MemoryPrimaryStore() })
    plur.learn('this statement must not reach the filesystem')
    plur.learn('nor this one')
    expect(existsSync(yamlPath)).toBe(false)
  })

  it('keeps two instances on separate stores isolated from each other', () => {
    const a = new Plur({ path: dir, store: new MemoryPrimaryStore() })
    const b = new Plur({ path: dir, store: new MemoryPrimaryStore() })
    const learned = a.learn('only instance A should see this')
    expect(a.getById(learned.id)).not.toBeNull()
    expect(b.getById(learned.id)).toBeNull()
  })
})

describe('Plur does not reach past its PrimaryStore', () => {
  it('index.ts contains no direct loadEngrams/saveEngrams calls', () => {
    // A structural guard, not a style rule: every such call is a place that
    // assumes YAML-on-disk and would silently bypass an injected store. This
    // fails on the pre-refactor tree (35 loadEngrams + 3 saveEngrams call
    // sites) and must keep failing if one is reintroduced.
    const source = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')
    const calls = source.match(/(?<![\w.])(loadEngrams|saveEngrams)\s*\(/g) ?? []
    expect(calls).toEqual([])
  })

  it('learn-async.ts persists through the injected store, not a path', () => {
    const source = readFileSync(join(here, '..', 'src', 'learn-async.ts'), 'utf8')
    const calls = source.match(/(?<![\w.])(loadEngrams|saveEngrams)\s*\(/g) ?? []
    expect(calls).toEqual([])
  })
})
