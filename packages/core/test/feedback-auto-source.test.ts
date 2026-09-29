/**
 * #1310 — automatic feedback adjusts ranking only, never commitment.
 *
 * Editor hooks rate injected engrams from the reply text with a heuristic.
 * A heuristic may move `retrieval_strength` (ranking), but it must never
 * advance `commitment`: that ladder records how settled a person considers the
 * knowledge, and a string match in a reply is not a person deciding anything.
 * Explicit `plur_feedback` keeps promoting exactly as before.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import {
  applyFeedbackSignal, nextCommitment, POSITIVE_STRENGTH_DELTA, NEGATIVE_STRENGTH_DELTA,
} from '../src/feedback.js'
import { storePrefix } from '../src/engrams.js'
import type { Engram } from '../src/schemas/engram.js'

const mk = (over: Partial<Engram> = {}): Engram => ({
  id: 'ENG-2026-0929-001',
  statement: 'a statement',
  type: 'behavioral',
  scope: 'global',
  status: 'active',
  activation: { retrieval_strength: 0.5, storage_strength: 1, frequency: 0, last_accessed: '2026-01-01' },
  created: '2026-01-01',
  ...over,
} as never)

describe('applyFeedbackSignal with source: "auto"', () => {
  it('a positive auto signal raises strength but leaves commitment untouched', () => {
    for (const start of [undefined, 'exploring', 'leaning'] as const) {
      const e = mk(start === undefined ? {} : { commitment: start } as never)
      applyFeedbackSignal(e, 'positive', '2026-09-29', { source: 'auto' })
      expect(e.activation.retrieval_strength).toBeCloseTo(0.5 + POSITIVE_STRENGTH_DELTA)
      expect((e as { commitment?: string }).commitment, `from ${start}`).toBe(start)
      expect(e.feedback_signals).toEqual({ positive: 1, negative: 0, neutral: 0 })
      expect(e.activation.last_accessed).toBe('2026-09-29')
    }
  })

  it('a negative auto signal lowers strength and leaves commitment untouched', () => {
    const e = mk({ commitment: 'decided' } as never)
    applyFeedbackSignal(e, 'negative', '2026-09-29', { source: 'auto' })
    expect(e.activation.retrieval_strength).toBeCloseTo(0.5 - NEGATIVE_STRENGTH_DELTA)
    expect((e as { commitment?: string }).commitment).toBe('decided')
  })

  it('explicit feedback still promotes (default and source: "explicit")', () => {
    const a = mk({ commitment: 'exploring' } as never)
    applyFeedbackSignal(a, 'positive', '2026-09-29')
    expect((a as { commitment?: string }).commitment).toBe('leaning')
    const b = mk({ commitment: 'leaning' } as never)
    applyFeedbackSignal(b, 'positive', '2026-09-29', { source: 'explicit' })
    expect((b as { commitment?: string }).commitment).toBe('decided')
  })
})

describe('Plur.feedback with source: "auto"', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-1310-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function historyEvents(): Array<Record<string, any>> {
    const hdir = join(dir, 'history')
    if (!existsSync(hdir)) return []
    return readdirSync(hdir)
      .filter(f => f.endsWith('.jsonl'))
      .flatMap(f => readFileSync(join(hdir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)))
  }

  it('moves retrieval_strength and never commitment, however many times it fires', async () => {
    const plur = new Plur({ path: dir })
    const e = await plur.learn('run the migration script before deploying billing', { scope: 'global', type: 'behavioral' })
    const before = (await plur.getById(e.id))!
    const startCommitment = (before as { commitment?: string }).commitment

    for (let i = 0; i < 5; i++) await plur.feedback(e.id, 'positive', undefined, { source: 'auto' })

    const after = (await plur.getById(e.id))!
    expect(after.activation.retrieval_strength).toBeGreaterThan(before.activation.retrieval_strength)
    expect((after as { commitment?: string }).commitment).toBe(startCommitment)
    expect(after.feedback_signals?.positive).toBe(5)
  })

  it('records the source on the feedback history event', async () => {
    const plur = new Plur({ path: dir })
    const e = await plur.learn('prefer small pull requests for review', { scope: 'global', type: 'behavioral' })
    await plur.feedback(e.id, 'positive', undefined, { source: 'auto' })
    const ev = historyEvents().find(h => h.event === 'feedback_received' && h.engram_id === e.id)
    expect(ev?.data).toMatchObject({ signal: 'positive', source: 'auto' })
  })

  it('explicit feedback on the same store still promotes commitment', async () => {
    const plur = new Plur({ path: dir })
    const e = await plur.learn('tag releases from main only', { scope: 'global', type: 'behavioral' })
    const before = (await plur.getById(e.id)) as { commitment?: string }
    await plur.feedback(e.id, 'positive')
    const after = (await plur.getById(e.id)) as { commitment?: string }
    expect(after.commitment).toBe(nextCommitment(before.commitment))
    expect(after.commitment).not.toBe(before.commitment)
  })

  it('does not promote an engram held in a secondary file store either', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'plur-1310-store-'))
    try {
      const storePath = join(storeDir, 'team.yaml')
      const id = 'ENG-2026-0929-001'
      writeFileSync(storePath, yaml.dump({ engrams: [{
        id, version: 2, status: 'active', consolidated: false, type: 'behavioral',
        scope: 'global', visibility: 'private', statement: 'team convention for auto rating',
        commitment: 'exploring',
        activation: { retrieval_strength: 0.5, storage_strength: 1.0, frequency: 0, last_accessed: '2026-09-01' },
        feedback_signals: { positive: 0, negative: 0, neutral: 0 },
        associations: [], derivation_count: 1, tags: [], pack: null, abstract: null,
        derived_from: null, reference_count: 1, sources: [],
      }] }))
      writeFileSync(join(dir, 'config.yaml'), yaml.dump({ stores: [{ path: storePath, scope: 'team', readonly: false }], index: false }))
      writeFileSync(join(dir, 'engrams.yaml'), 'engrams: []\n')
      const plur = new Plur({ path: dir })
      const nsId = id.replace(/^ENG-/, `ENG-${storePrefix('team')}-`)
      await plur.feedback(nsId, 'positive', undefined, { source: 'auto' })
      const stored = (yaml.load(readFileSync(storePath, 'utf8')) as { engrams: Array<Record<string, any>> }).engrams[0]
      expect(stored.feedback_signals.positive).toBe(1)
      expect(stored.activation.retrieval_strength).toBeGreaterThan(0.5)
      expect(stored.commitment).toBe('exploring')
    } finally {
      rmSync(storeDir, { recursive: true, force: true })
    }
  })

  it('refuses to send automatic feedback to a remote store', async () => {
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ url: 'http://127.0.0.1:9', token: 't', scope: 'group:example/team', readonly: false }],
      index: false,
    }))
    const plur = new Plur({ path: dir })
    await expect(
      plur.feedback('ENG-2026-0929-999', 'positive', 'group:example/team', { source: 'auto' }),
    ).rejects.toThrow(/remote/i)
  })
})
