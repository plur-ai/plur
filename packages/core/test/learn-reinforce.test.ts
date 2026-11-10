/**
 * Write-time inflow (overhaul D8, R8): reinforce on an exact restatement.
 *
 * With `learn.reinforce_exact` on, a statement equal to an existing engram's
 * after normalising case, whitespace and punctuation reinforces that engram
 * (feedback + activation, one more source as evidence) and the write reports
 * decision REINFORCE with the existing id and the text it swallowed. Never on
 * similarity alone, never across scopes, never onto a locked, draft or
 * superseded engram. A near-paraphrase is written as today and queued for the
 * next consolidation plan.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { _setCachedEmbedder, resetEmbedder, setEmbeddingsEnabled } from '../src/embeddings.js'
import { CONSOLIDATE_QUEUE_FILE } from '../src/consolidate.js'
import { axis, near } from './fixtures/consolidate-vectors.js'

describe('learn: reinforce on an exact normalised restatement (D8)', () => {
  let dir: string
  let plur: Plur

  const open = (cfg: string) => {
    writeFileSync(join(dir, 'config.yaml'), `backend: yaml\n${cfg}`)
    plur = new Plur({ path: dir, autoDiscover: false })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-reinforce-'))
    setEmbeddingsEnabled(false, 'test: no model')
  })
  afterEach(() => {
    resetEmbedder()
    setEmbeddingsEnabled(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('reinforces the existing engram and reports REINFORCE with the swallowed text', async () => {
    open('learn:\n  reinforce_exact: true\n')
    const first = await plur.learn('Use pnpm, not npm, in this repository', { scope: 'global' })
    const before = (await plur.getById(first.id))!
    const again = await plur.learn('use PNPM not npm   in this repository!', { scope: 'global', source: 'second session' })
    expect(again.id).toBe(first.id)
    const r = plur.reinforcementOf(again)
    expect(r).toEqual({
      decision: 'REINFORCE',
      existing_id: first.id,
      existing_statement: 'Use pnpm, not npm, in this repository',
      swallowed: 'use PNPM not npm   in this repository!',
    })
    const after = (await plur.getById(first.id))!
    expect(after.feedback_signals.positive).toBe(before.feedback_signals.positive + 1)
    expect(after.activation.retrieval_strength).toBeGreaterThan(before.activation.retrieval_strength)
    expect((after as { sources?: unknown[] }).sources?.length).toBe(((before as { sources?: unknown[] }).sources?.length ?? 0) + 1)
    // Not a promotion: an automatic reinforcement never moves commitment.
    expect(after.commitment).toBe(before.commitment)
    expect((await plur.list()).length).toBe(1)
  })

  it('does not reinforce a correction ("use X not Y" vs "use Y")', async () => {
    open('learn:\n  reinforce_exact: true\n')
    const a = await plur.learn('Use pnpm, not npm', { scope: 'global' })
    const b = await plur.learn('Use npm', { scope: 'global' })
    expect(b.id).not.toBe(a.id)
    expect(plur.reinforcementOf(b)).toBeNull()
    expect((await plur.getById(a.id))!.feedback_signals.positive).toBe(0)
  })

  it('stays as today when reinforce_exact is off: absorbed, not reinforced', async () => {
    open('')
    const a = await plur.learn('Use pnpm, not npm', { scope: 'global' })
    const again = await plur.learn('use pnpm not npm', { scope: 'global' })
    expect(again.id).toBe(a.id)
    expect(plur.reinforcementOf(again)).toBeNull()
    expect((await plur.getById(a.id))!.feedback_signals.positive).toBe(0)
  })

  it('a caller default turns it on only where the config does not decide', async () => {
    open('')
    const a = await plur.learn('Use pnpm, not npm', { scope: 'global' })
    const again = await plur.learn('use pnpm not npm', { scope: 'global', reinforce_exact_default: true })
    expect(plur.reinforcementOf(again)?.existing_id).toBe(a.id)

    open('learn:\n  reinforce_exact: false\n')
    const third = await plur.learn('USE PNPM, NOT NPM', { scope: 'global', reinforce_exact_default: true })
    expect(plur.reinforcementOf(third)).toBeNull()
  })

  it('never reinforces across scopes, nor a locked or draft engram', async () => {
    open('learn:\n  reinforce_exact: true\n')
    const g = await plur.learn('Tag every release', { scope: 'global' })
    const p = await plur.learn('Tag every release', { scope: 'project:x' })
    expect(p.id).not.toBe(g.id)
    expect(plur.reinforcementOf(p)).toBeNull()

    const locked = await plur.learn('Sign every release artefact', { scope: 'global', commitment: 'locked' })
    const l2 = await plur.learn('sign every release artefact', { scope: 'global' })
    expect(plur.reinforcementOf(l2)).toBeNull()
    expect((await plur.getById(locked.id))!.feedback_signals.positive).toBe(0)
  })

  it('learnAsync and learnBatch report REINFORCE on an exact restatement', async () => {
    open('learn:\n  reinforce_exact: true\n')
    const a = await plur.learn('Keep pull requests small', { scope: 'global' })
    const r = await plur.learnAsync('keep pull requests small.', { scope: 'global' })
    expect(r.decision).toBe('REINFORCE')
    expect(r.existing_id).toBe(a.id)
    const batch = await plur.learnBatch([{ statement: 'Keep pull-requests small', context: { scope: 'global' } }])
    // "pull-requests" normalises to "pullrequests": not equal, so not reinforced.
    expect(batch.results[0].decision).not.toBe('REINFORCE')
    const batch2 = await plur.learnBatch([{ statement: 'KEEP PULL REQUESTS SMALL', context: { scope: 'global' } }])
    expect(batch2.results[0].decision).toBe('REINFORCE')
    expect(batch2.stats.reinforced).toBe(1)
    expect((await plur.getById(a.id))!.feedback_signals.positive).toBe(2)
  })

  it('a near-paraphrase (cosine >= 0.92, same scope) is written and queued for the next plan', async () => {
    open('learn:\n  reinforce_exact: true\n')
    const vectors = new Map<string, Float32Array>([
      ['Run the full test suite before committing', axis(0)],
      ['Before committing, run the entire test suite', near(axis(0), 5, 0.95)],
    ])
    const a = await plur.learn('Run the full test suite before committing', { scope: 'global' })
    const b = await plur.learn('Before committing, run the entire test suite', { scope: 'global' })
    expect(b.id).not.toBe(a.id)
    setEmbeddingsEnabled(true)
    const embed = async (t: string) => {
      const k = [...vectors.keys()].sort((x, y) => y.length - x.length).find(s => t.includes(s))
      return k ? vectors.get(k)! : axis(31)
    }
    _setCachedEmbedder({ name: 'stub-reinforce', dim: 32, modelId: 'stub', embed, embedBatch: async (ts: string[]) => Promise.all(ts.map(embed)) } as Parameters<typeof _setCachedEmbedder>[0])
    await plur.nearDuplicates(b.statement, { scope: 'global' }, b.id)
    const queuePath = join(dir, CONSOLIDATE_QUEUE_FILE)
    expect(existsSync(queuePath)).toBe(true)
    const lines = readFileSync(queuePath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines[0]).toMatchObject({ id: b.id, neighbour_id: a.id, scope: 'global' })
    expect(lines[0].score).toBeGreaterThanOrEqual(0.92)
  })
})
