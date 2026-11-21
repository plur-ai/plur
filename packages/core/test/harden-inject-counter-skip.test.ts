/**
 * Hardening H7: when the injection counter is skipped because the caller's
 * bookkeeping deadline leaves less than the reserve, the co_injection history
 * event says so (`counter_skipped: true`), so the counter and the history log
 * never silently disagree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, loadEngrams, BOOKKEEPING_RESERVE_MS } from '../src/index.js'
import { readCoInjections } from '../src/history.js'

describe('co_injection records a skipped counter (H7)', () => {
  let dir: string
  let plur: Plur
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-harden-counter-')); plur = new Plur({ path: dir }) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const countOf = (id: string) =>
    (loadEngrams(join(dir, 'engrams.yaml')).find(e => e.id === id) as { injection_count?: number } | undefined)?.injection_count ?? 0

  it('a counter skipped near the deadline is marked on the event', async () => {
    const e = await plur.learn('always run the migration dry-run before deploying', { scope: 'global', type: 'behavioral' })
    await plur.injectHybrid('migration dry-run before deploying', { bookkeeping_deadline_at: Date.now() + BOOKKEEPING_RESERVE_MS - 500 })
    expect(countOf(e.id)).toBe(0)
    const ev = readCoInjections(dir).events.find(x => x.data.ids.includes(e.id))!
    expect(ev).toBeDefined()
    expect(ev.data.counter_skipped).toBe(true)
  })

  it('a counter written in time leaves the event unmarked', async () => {
    const e = await plur.learn('always run the migration dry-run before deploying', { scope: 'global', type: 'behavioral' })
    await plur.injectHybrid('migration dry-run before deploying', { bookkeeping_deadline_at: Date.now() + 60_000 })
    expect(countOf(e.id)).toBe(1)
    const ev = readCoInjections(dir).events.find(x => x.data.ids.includes(e.id))!
    expect(ev.data.counter_skipped).toBeUndefined()
  })
})
