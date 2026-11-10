/**
 * W1 (retrieval and injection overhaul): on a large store the legacy selection
 * crowds out an engram that recall ranks in its top 3; the unified selection
 * (always-on slot + recall's ranked list packed into the budget) injects it.
 *
 * Generated fixture: about 3,000 synthetic engrams, 400 keyword-dense
 * lookalikes (half locked apply-level rules), 40 long pins. Keyword path
 * (`inject()` / `recall()`), so the test needs no embedding model.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { buildLargeFixture, writeFixtureStore, LARGE_QUERY, TARGET_ID } from './helpers/injection-fixture.js'

describe('unified injection on a large store (W1)', () => {
  let dir: string
  let fixture: ReturnType<typeof buildLargeFixture>

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-unified-large-'))
    fixture = buildLargeFixture(3000)
    writeFixtureStore(dir, fixture.engrams)
  }, 60_000)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('fixture: about 3,000 engrams with 40 pins', () => {
    expect(fixture.engrams.length).toBe(3000)
    expect(fixture.pins.length).toBe(40)
  })

  it('recall ranks the target in its top 3', async () => {
    const plur = new Plur({ path: dir })
    const hits = await plur.recall(LARGE_QUERY, { limit: 10 })
    const rank = hits.findIndex(e => e.id === TARGET_ID)
    expect(rank, `target rank in recall: ${rank}`).toBeGreaterThanOrEqual(0)
    expect(rank).toBeLessThan(3)
  }, 60_000)

  it('legacy injection crowds the target out', async () => {
    const plur = new Plur({ path: dir })
    const r = await plur.inject(LARGE_QUERY, { mode: 'legacy' })
    expect(r.injected_ids).not.toContain(TARGET_ID)
    expect(r.selection).toBe('legacy')
  }, 60_000)

  it('unified injection delivers the target, within the budget, with pins in their share', async () => {
    const plur = new Plur({ path: dir })
    const r = await plur.inject(LARGE_QUERY, { mode: 'unified' })
    expect(r.selection).toBe('unified')
    expect(r.injected_ids).toContain(TARGET_ID)
    expect(r.tokens_used).toBeLessThanOrEqual(2000)
    const pinIds = new Set(fixture.pins.map(p => p.id))
    expect(r.injected_ids.some(i => pinIds.has(i)), 'the always-on slot still delivers pins').toBe(true)
    expect(r.omitted_pinned?.length ?? 0, 'pins over their share are named').toBeGreaterThan(0)
    expect(r.query, 'no query_context: the query is the task and is not echoed').toBeUndefined()
    expect(r.relevance).toBeDefined()
  }, 60_000)

  it('config injection.mode: unified selects the unified path without a per-call override', async () => {
    writeFixtureStore(dir, fixture.engrams, 'injection:\n  mode: unified\n')
    try {
      const plur = new Plur({ path: dir })
      const r = await plur.inject(LARGE_QUERY)
      expect(r.selection).toBe('unified')
      expect(r.injected_ids).toContain(TARGET_ID)
    } finally {
      writeFixtureStore(dir, fixture.engrams, 'injection:\n  mode: legacy\n')
    }
  }, 60_000)
})
