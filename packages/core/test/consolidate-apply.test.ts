/**
 * Store consolidation end to end on a real store (overhaul W6; R1, R2, R9, D7).
 *
 * A stub embedder gives each statement a chosen vector, and a stub model
 * stands in for the host's model, so the tests need no model download and
 * make no network call. What they hold:
 *  - plan → apply retires the originals (never deletes), links both ways,
 *    and writes a `consolidated_into` history event per original;
 *  - undo restores the store byte for byte, and refuses after drift;
 *  - relations and associations are remapped onto the merged engram, with
 *    self-edges dropped; counts are summed and the highest strength kept;
 *  - a pinned original makes a pin request, never a pin, and its cluster
 *    needs the owner's approval in the proposal file;
 *  - apply refuses while `consolidate.apply_enabled` is false, and the first
 *    apply of a plan must be a one-item trial;
 *  - a different-meaning pair the model splits, a negation pair and a
 *    cross-scope pair are never merged;
 *  - the nightly plan records its date seed and samples deterministically;
 *  - a plan interrupted by a model failure resumes where it stopped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import type { Engram } from '../src/schemas/engram.js'
import { _setCachedEmbedder, resetEmbedder, setEmbeddingsEnabled } from '../src/embeddings.js'
import { ChangeConflictError } from '../src/change-journal.js'
import { ConsolidateApplyDisabledError, ConsolidateTrialRequiredError, type ConsolidationPlan } from '../src/consolidate.js'
import { axis, near } from './fixtures/consolidate-vectors.js'
import { pinRequestOf } from '../src/pin-policy.js'

const DIM = 32

/** Stub embedder: the vector of the longest registered statement the text contains. */
function installStub(vectors: Map<string, Float32Array>) {
  const keys = () => [...vectors.keys()].sort((a, b) => b.length - a.length)
  const embed = async (t: string) => {
    const k = keys().find(s => t.includes(s))
    return k ? vectors.get(k)! : axis(DIM - 1, DIM)
  }
  _setCachedEmbedder({
    name: 'stub-consolidate', dim: DIM, modelId: 'stub',
    embed, embedBatch: async (ts: string[]) => Promise.all(ts.map(embed)),
  } as Parameters<typeof _setCachedEmbedder>[0])
}

/** Stub model: MERGE every cluster into its first member's wording, unless told to split it. */
function mergingModel(opts: { splitIf?: (statements: string[]) => boolean; failAfter?: number } = {}) {
  const calls: string[] = []
  const llm = async (prompt: string) => {
    calls.push(prompt)
    if (opts.failAfter !== undefined && calls.length > opts.failAfter) throw new Error('model unavailable')
    const blocks = prompt.split(/^CLUSTER_(\d+):$/m)
    const out: string[] = []
    for (let i = 1; i < blocks.length; i += 2) {
      const n = blocks[i]
      const statements = [...blocks[i + 1].matchAll(/\[[^\]]+\] "([^"]*)"/g)].map(m => m[1])
      if (opts.splitIf?.(statements)) out.push(`CLUSTER_${n}:\nDECISION: SPLIT\nSTATEMENT: none\nREASON: different meaning`)
      else out.push(`CLUSTER_${n}:\nDECISION: MERGE\nSTATEMENT: ${statements[0]} (merged)\nREASON: same rule`)
    }
    return out.join('\n\n')
  }
  return { llm, calls }
}

describe('plur consolidate: plan, apply, undo', () => {
  let dir: string
  let plur: Plur
  const vectors = new Map<string, Float32Array>()

  const storeBytes = () => readFileSync(join(dir, 'engrams.yaml'), 'utf8')
  const config = (extra = '') => writeFileSync(join(dir, 'config.yaml'), `backend: yaml\n${extra}`)

  async function teach(rows: Array<{ s: string; v: Float32Array; scope?: string; pinned?: boolean; commitment?: Engram['commitment'] }>): Promise<Engram[]> {
    setEmbeddingsEnabled(false, 'test: writing fixtures')
    const out: Engram[] = []
    for (const r of rows) {
      vectors.set(r.s, r.v)
      out.push(await plur.learn(r.s, { scope: r.scope ?? 'global', ...(r.pinned ? { pinned: true } : {}), ...(r.commitment ? { commitment: r.commitment } : {}) }))
    }
    setEmbeddingsEnabled(true)
    installStub(vectors)
    return out
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-consolidate-'))
    config('consolidate:\n  apply_enabled: true\n')
    vectors.clear()
    setEmbeddingsEnabled(true)
    resetEmbedder()
    plur = new Plur({ path: dir, autoDiscover: false })
    await plur.ready()
  })
  afterEach(() => {
    resetEmbedder()
    setEmbeddingsEnabled(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('apply retires the originals with superseded_by, links the merged engram, and logs consolidated_into', async () => {
    const [a, b] = await teach([
      { s: 'Use pnpm, not npm, in this repository', v: axis(0, DIM) },
      { s: 'This repository uses pnpm instead of npm', v: near(axis(0, DIM), 5, 0.95) },
      { s: 'Release notes name every behaviour change', v: axis(1, DIM) },
    ])
    const { llm } = mergingModel()
    const plan = await plur.consolidatePlan({ llm })
    expect(plan.clusters.length).toBe(1)
    expect(plan.clusters[0].members.map(m => m.id).sort()).toEqual([a.id, b.id].sort())
    expect(plan.clusters[0].decision).toBe('merge')

    const res = await plur.consolidateApply(plan, { limit: 1 })
    expect(res.applied.length).toBe(1)
    const { merged_id, change_id } = res.applied[0]
    const merged = (await plur.getById(merged_id))!
    expect(merged.status).toBe('active')
    expect(merged.statement).toBe(`${a.statement} (merged)`)
    expect([...(merged.relations?.supersedes ?? [])].sort()).toEqual([a.id, b.id].sort())
    for (const id of [a.id, b.id]) {
      const o = (await plur.getById(id))!
      expect(o.status).toBe('retired')
      expect(o.relations?.superseded_by).toContain(merged_id)
      const h = plur.getEngramHistory(id)
      expect(h.some(e => e.event === 'consolidated_into' && e.data.into === merged_id && e.data.change_id === change_id)).toBe(true)
    }
    // Nothing deleted: three rows before, four after.
    const doc = yaml.load(storeBytes()) as Engram[] | { engrams: Engram[] }
    expect((Array.isArray(doc) ? doc : doc.engrams).length).toBe(4)
  })

  it('undo restores the store exactly, and refuses after drift', async () => {
    await teach([
      { s: 'Run the full test suite before committing', v: axis(0, DIM) },
      { s: 'Before a commit, run the whole test suite', v: near(axis(0, DIM), 5, 0.94) },
    ])
    // Normalise key order once (any whole-corpus write does this).
    const first = (await plur.list())[0]
    await plur.updateEngramAsync(first)
    const before = storeBytes()
    const plan = await plur.consolidatePlan({ llm: mergingModel().llm })
    const res = await plur.consolidateApply(plan, { limit: 1 })
    expect(storeBytes()).not.toBe(before)
    await plur.undoChange(res.applied[0].change_id)
    expect(storeBytes()).toBe(before)

    // Apply again (a fresh plan), then drift the merged engram: undo refuses.
    const plan2 = await plur.consolidatePlan({ llm: mergingModel().llm })
    const res2 = await plur.consolidateApply(plan2, { limit: 1 })
    const merged = (await plur.getById(res2.applied[0].merged_id))!
    await plur.updateEngramAsync({ ...merged, statement: 'Someone edited this afterwards' })
    const drifted = storeBytes()
    await expect(plur.undoChange(res2.applied[0].change_id)).rejects.toBeInstanceOf(ChangeConflictError)
    expect(storeBytes()).toBe(drifted)
  })

  it('remaps relations and associations onto the merged engram and drops self-edges', async () => {
    const [a, b, x] = await teach([
      { s: 'Deploy only from the main branch', v: axis(0, DIM) },
      { s: 'Deployments go out from main only', v: near(axis(0, DIM), 5, 0.95) },
      { s: 'Tag every release in git', v: axis(2, DIM) },
    ])
    // A relates to B (becomes a self-edge) and to X; X relates to A and associates with B.
    const ra = (await plur.getById(a.id))!
    await plur.updateEngramAsync({ ...ra, relations: { broader: [], narrower: [], related: [b.id, x.id], conflicts: [], supersedes: [], superseded_by: [] } })
    const rx = (await plur.getById(x.id))!
    await plur.updateEngramAsync({
      ...rx,
      relations: { broader: [], narrower: [], related: [a.id], conflicts: [], supersedes: [], superseded_by: [] },
      associations: [{ target_type: 'engram', target: b.id, strength: 0.4, type: 'semantic' }],
    })
    const plan = await plur.consolidatePlan({ llm: mergingModel().llm })
    const res = await plur.consolidateApply(plan, { limit: 1 })
    const m = res.applied[0].merged_id
    const merged = (await plur.getById(m))!
    expect(merged.relations?.related).toEqual([x.id])
    const x2 = (await plur.getById(x.id))!
    expect(x2.relations?.related).toEqual([m])
    expect(x2.associations.map(s => s.target)).toEqual([m])
    // The touched neighbour is part of the change, so undo restores it too.
    expect(res.applied[0].touched).toContain(x.id)
  })

  it('sums counts and keeps the highest strength', async () => {
    const [a, b] = await teach([
      { s: 'Prefer small pull requests', v: axis(0, DIM) },
      { s: 'Keep pull requests small', v: near(axis(0, DIM), 5, 0.93) },
    ])
    const ra = (await plur.getById(a.id))!
    await plur.updateEngramAsync({
      ...ra, injection_count: 3, write_count: 2,
      activation: { ...ra.activation, retrieval_strength: 0.9, frequency: 4 },
      feedback_signals: { positive: 2, negative: 1, neutral: 0 },
    })
    const rb = (await plur.getById(b.id))!
    await plur.updateEngramAsync({
      ...rb, injection_count: 5, write_count: 1,
      activation: { ...rb.activation, retrieval_strength: 0.6, frequency: 7 },
      feedback_signals: { positive: 1, negative: 2, neutral: 3 },
    })
    const plan = await plur.consolidatePlan({ llm: mergingModel().llm })
    const res = await plur.consolidateApply(plan, { limit: 1 })
    const merged = (await plur.getById(res.applied[0].merged_id))!
    expect(merged.injection_count).toBe(8)
    expect(merged.write_count).toBe(3)
    expect(merged.activation.frequency).toBe(11)
    expect(merged.activation.retrieval_strength).toBe(0.9)
    expect(merged.feedback_signals).toMatchObject({ positive: 3, negative: 3, neutral: 3 })
  })

  it('a pinned original needs owner approval and becomes a pin request, never a pin', async () => {
    const [a, b] = await teach([
      { s: 'Never commit secrets to the repository', v: axis(0, DIM), pinned: true },
      { s: 'Never put secrets in a commit', v: near(axis(0, DIM), 5, 0.95) },
    ])
    const plan = await plur.consolidatePlan({ llm: mergingModel().llm })
    const cl = plan.clusters[0]
    expect(cl.requires_owner_approval).toBe(true)
    expect(cl.protected_reasons).toEqual(expect.arrayContaining(['pinned', 'prohibition']))
    expect(cl.approved).toBe(false)

    const skipped = await plur.consolidateApply(plan, { limit: 1 })
    expect(skipped.applied).toEqual([])
    expect(skipped.skipped[0]).toMatchObject({ cluster_id: cl.id, reason: 'needs_approval' })

    const approved: ConsolidationPlan = { ...plan, clusters: [{ ...cl, approved: true }] }
    const res = await plur.consolidateApply(approved, { limit: 1 })
    const merged = (await plur.getById(res.applied[0].merged_id))!
    expect(merged.pinned).toBeFalsy()
    // One pin_request shape (pin-policy's), so `plur pins review` lists it.
    const request = pinRequestOf(merged)
    expect(request).toMatchObject({ by: 'consolidate', via: 'consolidate', from: [a.id] })
    expect(typeof request!.requested_at).toBe('string')
    expect((merged as Engram & { pin_request?: unknown }).pin_request).toBeUndefined()
    const pending = await plur.pendingPinRequests()
    expect(pending.map(p => p.id)).toEqual([merged.id])
    expect(pending[0].request.by).toBe('consolidate')
    expect(b.id).toBeTruthy()
  })

  it('the merge prompt carries every member\'s rationale and structured body, as data (finding 3)', async () => {
    const [, b] = await teach([
      { s: 'Run the migrations before deploying', v: axis(0, DIM) },
      { s: 'Before a deploy, run the migrations', v: near(axis(0, DIM), 5, 0.95) },
    ])
    const row = (await plur.getById(b.id))!
    await plur.updateEngramAsync({ ...row, rationale: 'A missed migration took the API down', structured_data: { body: 'Pitfall: the staging migrator times out after 60s' } } as Engram)
    const model = mergingModel()
    await plur.consolidatePlan({ llm: model.llm })
    expect(model.calls[0]).toContain(JSON.stringify('A missed migration took the API down'))
    expect(model.calls[0]).toContain(JSON.stringify('Pitfall: the staging migrator times out after 60s'))
  })

  it('a cluster whose non-base members carry a body, rationale or dual coding needs owner approval (finding 3)', async () => {
    const [a, b] = await teach([
      { s: 'Tag releases with the version number', v: axis(0, DIM) },
      { s: 'Release tags carry the version number', v: near(axis(0, DIM), 5, 0.95) },
    ])
    // A is the base (strongest); B carries content the merge would drop.
    const ra = (await plur.getById(a.id))!
    await plur.updateEngramAsync({ ...ra, activation: { ...ra.activation, retrieval_strength: 0.99 } })
    const rb = (await plur.getById(b.id))!
    await plur.updateEngramAsync({ ...rb, rationale: 'The changelog generator keys on the tag' } as Engram)
    const plan = await plur.consolidatePlan({ llm: mergingModel().llm })
    expect(plan.clusters[0].requires_owner_approval).toBe(true)
    expect(plan.clusters[0].protected_reasons).toContain('member_content')
    const res = await plur.consolidateApply(plan, { limit: 1 })
    expect(res.skipped[0]).toMatchObject({ reason: 'needs_approval' })
  })

  it('the merged engram takes the most restrictive visibility of its members (finding 3)', async () => {
    const [a, b] = await teach([
      { s: 'Prefer small pull requests', v: axis(0, DIM) },
      { s: 'Keep pull requests small', v: near(axis(0, DIM), 5, 0.95) },
    ])
    const ra = (await plur.getById(a.id))!
    await plur.updateEngramAsync({ ...ra, visibility: 'public', activation: { ...ra.activation, retrieval_strength: 0.99 } })
    const rb = (await plur.getById(b.id))!
    await plur.updateEngramAsync({ ...rb, visibility: 'private' })
    const plan = await plur.consolidatePlan({ llm: mergingModel().llm })
    const res = await plur.consolidateApply(plan, { limit: 1 })
    expect((await plur.getById(res.applied[0].merged_id))!.visibility).toBe('private')
  })

  it('refuses to apply while consolidate.apply_enabled is false', async () => {
    config('')
    plur = new Plur({ path: dir, autoDiscover: false })
    await teach([
      { s: 'Use UTC timestamps in logs', v: axis(0, DIM) },
      { s: 'Log timestamps in UTC', v: near(axis(0, DIM), 5, 0.95) },
    ])
    const plan = await plur.consolidatePlan({ llm: mergingModel().llm })
    const before = storeBytes()
    await expect(plur.consolidateApply(plan, { limit: 1 })).rejects.toBeInstanceOf(ConsolidateApplyDisabledError)
    expect(storeBytes()).toBe(before)
  })

  it('the first apply of a plan must be a one-item trial', async () => {
    await teach([
      { s: 'Use UTC timestamps in logs', v: axis(0, DIM) },
      { s: 'Log timestamps in UTC', v: near(axis(0, DIM), 5, 0.95) },
      { s: 'Name branches after the issue number', v: axis(1, DIM) },
      { s: 'Branch names carry the issue number', v: near(axis(1, DIM), 6, 0.95) },
    ])
    const plan = await plur.consolidatePlan({ llm: mergingModel().llm })
    expect(plan.clusters.length).toBe(2)
    await expect(plur.consolidateApply(plan, {})).rejects.toBeInstanceOf(ConsolidateTrialRequiredError)
    const trial = await plur.consolidateApply(plan, { limit: 1 })
    expect(trial.applied.length).toBe(1)
    const rest = await plur.consolidateApply(plan, {})
    expect(rest.applied.length).toBe(1)
    expect(rest.skipped.some(s => s.reason === 'already_applied')).toBe(true)
  })

  it('a ~0.88 pair with a different meaning is not merged: the model splits it, and nothing merges without a model', async () => {
    await teach([
      { s: 'The staging server listens on port 8080', v: axis(0, DIM) },
      { s: 'The staging server listens on port 8081', v: near(axis(0, DIM), 5, 0.88) },
    ])
    const before = storeBytes()
    const noModel = await plur.consolidatePlan({})
    expect(noModel.clusters.length).toBe(1)
    expect(noModel.clusters[0].decision).toBe('pending')
    const r0 = await plur.consolidateApply(noModel, { limit: 1 })
    expect(r0.applied).toEqual([])
    expect(r0.skipped[0].reason).toBe('not_decided')

    const split = await plur.consolidatePlan({ llm: mergingModel({ splitIf: s => s.some(x => x.includes('8081')) }).llm })
    expect(split.clusters[0].decision).toBe('split')
    const r1 = await plur.consolidateApply(split, { limit: 1 })
    expect(r1.applied).toEqual([])
    expect(storeBytes()).toBe(before)
  })

  it('a negation pair is not proposed, and a cross-scope pair is never clustered', async () => {
    await teach([
      { s: 'Always rebase before pushing to main', v: axis(0, DIM) },
      { s: 'Never rebase before pushing to main', v: near(axis(0, DIM), 5, 0.95) },
      { s: 'Write commit messages in English', v: axis(1, DIM), scope: 'global' },
      { s: 'Commit messages are written in English', v: near(axis(1, DIM), 6, 0.97), scope: 'project:other' },
    ])
    const { llm, calls } = mergingModel()
    const plan = await plur.consolidatePlan({ llm })
    expect(plan.clusters).toEqual([])
    expect(plan.stats.mixed_polarity).toBe(1)
    expect(calls.length).toBe(0)
  })

  it('nightly mode records the date seed and samples deterministically', async () => {
    await teach([
      { s: 'Use UTC timestamps in logs', v: axis(0, DIM) },
      { s: 'Log timestamps in UTC', v: near(axis(0, DIM), 5, 0.95) },
      { s: 'Name branches after the issue number', v: axis(1, DIM) },
    ])
    const now = new Date('2026-11-10T03:00:00Z')
    const p1 = await plur.consolidatePlan({ nightly: true, now, sampleSize: 2 })
    const p2 = await plur.consolidatePlan({ nightly: true, now, sampleSize: 2 })
    expect(p1.seed).toBe('2026-11-10')
    expect(p1.nightly?.sampled_ids).toEqual(p2.nightly?.sampled_ids)
    expect(p1.nightly?.sampled_ids.length).toBe(2)
    expect(p1.nightly?.max_changes).toBe(25)
  })

  it('nightly: an unfinished plan does not move last_nightly_at, so nothing changed since is skipped (finding 4)', async () => {
    await teach([
      { s: 'Use UTC timestamps in logs', v: axis(0, DIM) },
      { s: 'Log timestamps in UTC', v: near(axis(0, DIM), 5, 0.95) },
    ])
    const first = await plur.consolidatePlan({ nightly: true, now: new Date('2026-11-09T03:00:00Z'), llm: mergingModel().llm, sampleSize: 0 })
    expect(first.progress.complete).toBe(true)
    // The next night the model fails: the plan is unfinished.
    const failed = await plur.consolidatePlan({ nightly: true, now: new Date('2026-11-10T03:00:00Z'), llm: mergingModel({ failAfter: 0 }).llm, sampleSize: 0 })
    expect(failed.nightly?.changed_since).toBe('2026-11-09T03:00:00.000Z')
    const next = await plur.consolidatePlan({ nightly: true, now: new Date('2026-11-11T03:00:00Z'), sampleSize: 0 })
    expect(next.nightly?.changed_since).toBe('2026-11-09T03:00:00.000Z')
  })

  it('nightly: clusters over the cap are carried to the next plan (finding 4)', async () => {
    config('consolidate:\n  apply_enabled: true\n  nightly_max_changes: 1\n')
    plur = new Plur({ path: dir, autoDiscover: false })
    await teach([
      { s: 'Use UTC timestamps in logs', v: axis(0, DIM) },
      { s: 'Log timestamps in UTC', v: near(axis(0, DIM), 5, 0.95) },
      { s: 'Name branches after the issue number', v: axis(1, DIM) },
      { s: 'Branch names carry the issue number', v: near(axis(1, DIM), 6, 0.95) },
    ])
    // Queue every row, so the first plan finds both clusters and keeps one.
    const all = await plur.list()
    writeFileSync(join(dir, 'consolidate-queue.jsonl'), all.map(e => JSON.stringify({ at: '2026-11-01T00:00:00.000Z', id: e.id, neighbour_id: e.id, score: 0.95, scope: 'global' })).join('\n') + '\n')
    // Dates after the rows were written, so the second plan sees none as changed.
    const later = (days: number) => new Date(Date.now() + days * 86_400_000)
    const first = await plur.consolidatePlan({ nightly: true, now: later(1), llm: mergingModel().llm, sampleSize: 0 })
    expect(first.clusters).toHaveLength(1)
    const keptIds = new Set(first.clusters[0].members.map(m => m.id))
    const droppedIds = all.map(e => e.id).filter(id => !keptIds.has(id))
    const second = await plur.consolidatePlan({ nightly: true, now: later(2), llm: mergingModel().llm, sampleSize: 0 })
    expect(second.clusters).toHaveLength(1)
    expect(second.clusters[0].members.map(m => m.id).sort()).toEqual(droppedIds.sort())
  })

  it('nightly: a finished plan removes the queue entries it consumed by id, and keeps ones queued meanwhile (finding 4)', async () => {
    const [a, b] = await teach([
      { s: 'Use UTC timestamps in logs', v: axis(0, DIM) },
      { s: 'Log timestamps in UTC', v: near(axis(0, DIM), 5, 0.95) },
    ])
    const queue = join(dir, 'consolidate-queue.jsonl')
    writeFileSync(queue, JSON.stringify({ at: '2026-11-01T00:00:00.000Z', id: b.id, neighbour_id: a.id, score: 0.95, scope: 'global' }) + '\n')
    const inner = mergingModel().llm
    const llm = async (prompt: string) => {
      // A learn queues a paraphrase while the model is thinking.
      writeFileSync(queue, readFileSync(queue, 'utf8') + JSON.stringify({ at: '2026-11-01T00:00:00.000Z', id: 'ENG-LATER', neighbour_id: a.id, score: 0.95, scope: 'global' }) + '\n')
      return inner(prompt)
    }
    const plan = await plur.consolidatePlan({ nightly: true, now: new Date('2026-11-10T03:00:00Z'), llm, sampleSize: 0 })
    expect(plan.nightly?.queued_ids).toEqual([b.id, a.id])
    expect(plan.progress.complete).toBe(true)
    const left = readFileSync(queue, 'utf8').trim().split('\n').map(l => JSON.parse(l).id)
    expect(left).toEqual(['ENG-LATER'])
  })

  it('a plan interrupted by a model failure resumes where it stopped', async () => {
    const rows: Array<{ s: string; v: Float32Array }> = []
    for (let g = 0; g < 3; g++) {
      rows.push({ s: `Rule number ${g} about topic ${g}`, v: axis(g, DIM) })
      rows.push({ s: `Topic ${g} has rule number ${g}`, v: near(axis(g, DIM), 10 + g, 0.95) })
    }
    await teach(rows)
    const flaky = mergingModel({ failAfter: 1 })
    const partial = await plur.consolidatePlan({ llm: flaky.llm, batchSize: 1 })
    expect(partial.clusters.filter(c => c.decision === 'merge').length).toBe(1)
    expect(partial.clusters.filter(c => c.decision === 'pending').length).toBe(2)
    expect(partial.progress.complete).toBe(false)
    const good = mergingModel()
    const resumed = await plur.consolidatePlan({ llm: good.llm, batchSize: 1, resumeFrom: partial })
    expect(resumed.plan_id).toBe(partial.plan_id)
    expect(resumed.clusters.every(c => c.decision === 'merge')).toBe(true)
    expect(good.calls.length).toBe(2)
    expect(resumed.progress.complete).toBe(true)
  })
})
