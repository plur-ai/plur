/**
 * Formal-verification replays, field-report cluster 5: auto-rate gives at most
 * one automatic verdict per engram per session (write-ahead, #1318).
 * Model: spec/formal/PlurSpec/R2CLI.lean §FR5.Rate.
 * Findings: spec/formal/findings/r2-cli.md, "Field report cluster 5".
 *
 * `it.fails` marks a CONFIRMED defect (the body asserts the intended behaviour).
 * The store is a stub: only the calls autoRateTurn makes are counted.
 * TMPDIR points into a temp dir (the id lists live under it).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const ID = 'ENG-2026-09-29-00c5'
const STATEMENT = 'Tag every release candidate with the sprint number'
const REPLY = `Per the team rule: ${STATEMENT}. Tagged.`

describe('formal field-report cluster 5 — auto-rate write-ahead', () => {
  let root: string
  let savedTmp: string | undefined
  let feedbackCalls: string[]

  const fakePlur = () => ({
    getByIds: async (ids: string[]) => ids.filter(i => i === ID).map(id => ({ id, statement: STATEMENT })),
    feedback: async (id: string) => { feedbackCalls.push(id) },
    config: {},
  })

  async function load() {
    vi.resetModules()
    return await import('../src/lib/auto-rate.js')
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-fr-c5-rate-'))
    savedTmp = process.env.TMPDIR
    process.env.TMPDIR = root
    delete process.env.PLUR_AUTO_RATE
    delete process.env.PLUR_AUTO_CAPTURE
    feedbackCalls = []
  })

  afterEach(() => {
    if (savedTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = savedTmp
    rmSync(root, { recursive: true, force: true })
  })

  async function turn(mod: Awaited<ReturnType<typeof load>>, session: string) {
    return mod.autoRateTurn({ editor: 'claude', sessionId: session, reply: REPLY, flags: {}, plur: fakePlur() as any })
  }

  it('the same reply twice: one verdict (Rate.orig_ok_when_recorded, good case)', async () => {
    const mod = await load()
    expect(mod.autoRateDir()).toBe(join(root, 'plur-auto-rate'))
    mod.recordInjected('claude', 'c5-ok', [ID])
    await turn(mod, 'c5-ok')
    await turn(mod, 'c5-ok')
    expect(feedbackCalls).toEqual([ID])
  })

  // CONFIRMED (Rate.orig_applies_twice): `appendIds` fails open, and the verdict
  // is applied whether or not its write-ahead record landed. Any failure to
  // append to `.rated` (disk full, quota, an unwritable file — here the path is
  // a directory) lets the same engram be rated again on every later turn.
  it.fails('a verdict whose write-ahead record failed is not applied again next turn', async () => {
    const mod = await load()
    mod.recordInjected('claude', 'c5-rec', [ID])
    mkdirSync(join(root, 'plur-auto-rate', 'claude-c5-rec.rated'))
    await turn(mod, 'c5-rec')
    await turn(mod, 'c5-rec')
    expect(feedbackCalls.length).toBeLessThanOrEqual(1)
  })

  it('the injected list is read under the same key it was written (H1 for auto-rate)', async () => {
    const mod = await load()
    mod.recordInjected('claude', 'c5/../key', [ID])
    expect(mod.pendingInjected('claude', 'c5/../key')).toEqual([ID])
  })
})
