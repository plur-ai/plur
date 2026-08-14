/**
 * Coverage for two behavioural changes that shipped in this branch with NO
 * tests of their own — found by auditing my own PR rather than the code.
 *
 * Both are hot-path rewrites whose failure mode is silent:
 *
 *   1. `inject()`'s `injection_count` bump moved from a whole-corpus
 *      load-and-rewrite to the targeted `_loadTargeted`/`_updateEngrams` pair
 *      (19.7x faster at 10k engrams). `injection_count` appeared in the test
 *      tree ONLY as fixture data — never as an assertion — so the counter
 *      could have stopped incrementing entirely and every suite would still
 *      have passed.
 *
 *   2. `flushOutbox`'s write-back moved from replacing the whole survivor row
 *      to merging only the fields the flush actually changes, so a concurrent
 *      writer's feedback counters, activation, pin or rescope are no longer
 *      reverted. Nothing referenced `survivorsById` or `_demoted` in a test.
 *
 * The general lesson, which is the same one this branch's audit kept finding:
 * "the other 3,983 tests still pass" is evidence about the code you did not
 * change.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, loadEngrams } from '../src/index.js'

const REMOTE = 'https://plur.example.com/sse'
const SCOPE = 'group:acme/team'

describe('inject() still counts injections after the targeted-write change', () => {
  let dir: string
  let plur: Plur
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-injcount-')); plur = new Plur({ path: dir }) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const countOf = (id: string) =>
    (loadEngrams(join(dir, 'engrams.yaml')).find(e => e.id === id) as { injection_count?: number } | undefined)
      ?.injection_count

  it('increments the counter for an injected engram, and persists it', async () => {
    const e = await plur.learn('always use semicolons in TypeScript', { scope: 'global', type: 'behavioral' })
    expect(countOf(e.id)).toBe(0)

    const res = await plur.inject('write TypeScript code')
    expect(res.injected_ids, 'fixture no longer injects — the assertion below would be vacuous')
      .toContain(e.id)

    expect(countOf(e.id), 'the targeted write did not persist the bump').toBe(1)
  })

  it('accumulates across injections rather than resetting', async () => {
    const e = await plur.learn('rebase before pushing on this repo', { scope: 'global', type: 'behavioral' })
    for (let i = 0; i < 3; i++) await plur.inject('rebase before pushing')
    expect(countOf(e.id)).toBe(3)
  })

  it('counts ONLY the engrams that were injected', async () => {
    // The specific risk of a targeted write: passing the wrong id set. A
    // whole-corpus rewrite could not get this wrong; a targeted one can.
    const hit = await plur.learn('docker compose runs the staging stack', { scope: 'global', type: 'behavioral' })
    const miss = await plur.learn('the kitchen tap drips on Sundays', { scope: 'global', type: 'behavioral' })

    const res = await plur.inject('docker compose staging')
    expect(res.injected_ids).toContain(hit.id)
    expect(res.injected_ids, 'fixture injects everything — the assertion below is vacuous')
      .not.toContain(miss.id)

    expect(countOf(hit.id)).toBe(1)
    expect(countOf(miss.id), 'an un-injected engram was counted').toBe(0)
  })

  it('does not disturb the rest of the row', async () => {
    // A targeted update writes whole rows through `updateMany`; the danger is
    // writing a STALE row. Assert a neighbouring field survives the bump.
    const e = await plur.learn('prefer pnpm over npm here', { scope: 'global', type: 'behavioral', tags: ['tooling'] })
    await plur.inject('prefer pnpm')
    const after = loadEngrams(join(dir, 'engrams.yaml')).find(r => r.id === e.id)!
    expect(after.statement).toBe('prefer pnpm over npm here')
    expect(after.tags).toContain('tooling')
    expect(after.scope).toBe('global')
  })

  it('a readonly instance counts nothing and does not throw', async () => {
    // The bump is best-effort and guarded; a read-only engine must not write,
    // and must not fail the injection either (#731).
    const e = await plur.learn('readonly instances must not write', { scope: 'global', type: 'behavioral' })
    const ro = new Plur({ path: dir, readonly: true })
    await expect(ro.inject('readonly instances')).resolves.toBeDefined()
    expect(countOf(e.id), 'a read-only engine mutated the store').toBe(0)
  })
})

describe('flushOutbox merges fields instead of replacing the row', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-flushmerge-'))
    originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => { throw new Error('fetch failed') }) as never
    writeFileSync(join(dir, 'config.yaml'), JSON.stringify({
      stores: [{ url: REMOTE, token: 'tok', scope: SCOPE, shared: true, readonly: false }],
      index: false,
    }))
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not revert a change made to a queued engram while the flush ran', async () => {
    // The defect: `survivorsById` holds rows snapshotted BEFORE the network
    // round-trips, and the write-back used to swap them in wholesale — so any
    // concurrent change to a queued engram (a feedback counter, an activation
    // bump, a pin, a local rescope) was silently reverted.
    const plur = new Plur({ path: dir })
    const queued = await plur.learn('a team fact that will not reach its store', {
      scope: SCOPE, type: 'behavioral',
    })
    await new Promise(r => setTimeout(r, 60))
    expect(await plur.outboxCount(), 'fixture did not queue — nothing to merge').toBe(1)

    // The edit must land AFTER the flush snapshots its corpus and BEFORE the
    // write-back, or there is no race to test. A first version of this test
    // edited beforehand and passed with the fix reverted — the snapshot simply
    // contained the edit. Slowing the fetch opens the window the production
    // defect lives in (a real flush waits on the network for seconds).
    globalThis.fetch = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 80))
      throw new Error('fetch failed')
    }) as never

    const flushing = plur.flushOutbox()
    await new Promise(r => setTimeout(r, 20))
    const row = (await plur.getById(queued.id))!
    row.statement = 'edited while the flush was in flight'
    await plur.updateEngram(row)
    await flushing

    const after = loadEngrams(join(dir, 'engrams.yaml')).find(e => e.id === queued.id)!
    expect(after.statement, 'the flush reverted a concurrent edit').toBe('edited while the flush was in flight')
  })

  it('still writes back the fields the flush DOES own', async () => {
    // The opposite regression: a merge that carried nothing would leave
    // `_outbox` bookkeeping unupdated, so retries would never age.
    const plur = new Plur({ path: dir })
    const queued = await plur.learn('another team fact for the unreachable store', {
      scope: SCOPE, type: 'behavioral',
    })
    await new Promise(r => setTimeout(r, 60))

    await plur.flushOutbox()

    const after = loadEngrams(join(dir, 'engrams.yaml')).find(e => e.id === queued.id)!
    const outbox = (after as { structured_data?: { _outbox?: { attempt_count?: number } } })
      .structured_data?._outbox
    expect(outbox, 'the engram must stay queued — a failed flush is not a handoff').toBeDefined()
    expect(outbox!.attempt_count, 'the retry counter was not written back').toBeGreaterThan(0)
  })

  it('leaves engrams outside the outbox completely untouched', async () => {
    const plur = new Plur({ path: dir })
    await plur.learn('a queued team fact', { scope: SCOPE, type: 'behavioral' })
    const bystander = await plur.learn('a purely local fact', { scope: 'global', type: 'behavioral' })
    await new Promise(r => setTimeout(r, 60))

    const before = loadEngrams(join(dir, 'engrams.yaml')).find(e => e.id === bystander.id)!
    await plur.flushOutbox()
    const after = loadEngrams(join(dir, 'engrams.yaml')).find(e => e.id === bystander.id)!
    expect(after).toEqual(before)
  })
})
