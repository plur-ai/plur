/**
 * The injection counter is best-effort bookkeeping. On a YAML store it is a
 * corpus reload plus a whole-file rewrite (~1.8 s at 14k engrams) that cannot
 * be interrupted once started. With a caller deadline (the hook passes one),
 * it is skipped when less than BOOKKEEPING_RESERVE_MS is left, so a finished
 * ranking is not lost to a counter write still running at the deadline.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, loadEngrams, BOOKKEEPING_RESERVE_MS } from '../src/index.js'

describe('injection counter respects a tight caller deadline', () => {
  let dir: string
  let plur: Plur
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-injreserve-')); plur = new Plur({ path: dir }) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const countOf = (id: string) =>
    (loadEngrams(join(dir, 'engrams.yaml')).find(e => e.id === id) as { injection_count?: number } | undefined)?.injection_count ?? 0

  it('skips the counter when less than the reserve is left, and still injects', async () => {
    const e = await plur.learn('always run the migration dry-run before deploying', { scope: 'global', type: 'behavioral' })
    const res = await plur.injectHybrid('migration dry-run before deploying', { deadline_at: Date.now() + BOOKKEEPING_RESERVE_MS - 500 } as never)
    expect(res.injected_ids).toContain(e.id)
    expect(countOf(e.id)).toBe(0)
  })

  it('writes the counter when there is time', async () => {
    const e = await plur.learn('always run the migration dry-run before deploying', { scope: 'global', type: 'behavioral' })
    const res = await plur.injectHybrid('migration dry-run before deploying', { deadline_at: Date.now() + 60_000 } as never)
    expect(res.injected_ids).toContain(e.id)
    expect(countOf(e.id)).toBe(1)
  })
})
