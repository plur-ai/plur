/**
 * Security audit 024, finding 2: an owner approval of a protected
 * consolidation cluster authorises exactly the merged statement the owner
 * reviewed.
 *
 *  - An approval set on a cluster before the model decided it never carries
 *    over to the statement the model then writes (resume path).
 *  - A cluster carrying `approved_statement_hash` applies only while its
 *    merged statement still hashes to it; a changed statement is refused as
 *    needing approval, both in the pre-check and in the in-transaction check.
 *  - A matching hash, or a plain approval of the statement as it stands in
 *    the file, still applies.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import type { Engram } from '../src/schemas/engram.js'
import { _setCachedEmbedder, resetEmbedder, setEmbeddingsEnabled } from '../src/embeddings.js'
import type { ConsolidationPlan } from '../src/consolidate.js'
import { computeContentHash } from '../src/content-hash.js'
import { collapseLineTerminators } from '../src/sanitize.js'
import { axis, near } from './fixtures/consolidate-vectors.js'

const DIM = 32

/** The approval hash: content hash of the statement as apply reads it (one line, trimmed). */
const approvalStatementHash = (s: string) => computeContentHash(collapseLineTerminators(s).trim())

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

/** Stub model: MERGE every cluster into the given statement. */
function modelSaying(statement: string) {
  return async (prompt: string) => {
    const blocks = prompt.split(/^CLUSTER_(\d+):$/m)
    const out: string[] = []
    for (let i = 1; i < blocks.length; i += 2) out.push(`CLUSTER_${blocks[i]}:\nDECISION: MERGE\nSTATEMENT: ${statement}\nREASON: same rule`)
    return out.join('\n\n')
  }
}

describe('audit 024 F2: a consolidation approval is bound to the reviewed statement', () => {
  let dir: string
  let plur: Plur
  const vectors = new Map<string, Float32Array>()

  async function protectedPair(): Promise<Engram[]> {
    setEmbeddingsEnabled(false, 'test: writing fixtures')
    const rows = [
      { s: 'Never commit secrets to the repository', v: axis(0, DIM), pinned: true },
      { s: 'Never put secrets in a commit', v: near(axis(0, DIM), 5, 0.95) },
    ]
    const out: Engram[] = []
    for (const r of rows) {
      vectors.set(r.s, r.v)
      out.push(await plur.learn(r.s, { scope: 'global', ...(r.pinned ? { pinned: true } : {}) }))
    }
    setEmbeddingsEnabled(true)
    installStub(vectors)
    return out
  }

  const statusOf = async (id: string) => (await plur.getById(id))!.status

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-audit-024-f2-'))
    writeFileSync(join(dir, 'config.yaml'), 'backend: yaml\nconsolidate:\n  apply_enabled: true\n')
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

  it('an approval set while the cluster was pending does not authorise the statement a resumed plan fills in', async () => {
    const [a, b] = await protectedPair()
    const pending = await plur.consolidatePlan({})
    expect(pending.clusters[0].decision).toBe('pending')
    expect(pending.clusters[0].requires_owner_approval).toBe(true)
    // The owner approves before any statement exists.
    const preApproved: ConsolidationPlan = { ...pending, clusters: [{ ...pending.clusters[0], approved: true }] }
    const resumed = await plur.consolidatePlan({ resumeFrom: preApproved, llm: modelSaying('Secrets may be committed when convenient (never)') })
    const cl = resumed.clusters[0]
    expect(cl.decision).toBe('merge')
    expect(cl.approved).toBe(false)
    const res = await plur.consolidateApply(resumed, { limit: 1 })
    expect(res.applied).toEqual([])
    expect(res.skipped[0]).toMatchObject({ cluster_id: cl.id, reason: 'needs_approval' })
    expect(await statusOf(a.id)).toBe('active')
    expect(await statusOf(b.id)).toBe('active')
  })

  it('a statement changed after a hash-bound approval is refused', async () => {
    const [a, b] = await protectedPair()
    const plan = await plur.consolidatePlan({ llm: modelSaying('Never commit secrets to any repository') })
    const cl = plan.clusters[0]
    const reviewed = cl.merged_statement!
    const changed: ConsolidationPlan = {
      ...plan,
      clusters: [{ ...cl, approved: true, approved_statement_hash: approvalStatementHash(reviewed), merged_statement: 'Never commit secrets to any repository, unless asked' }],
    }
    const res = await plur.consolidateApply(changed, { limit: 1 })
    expect(res.applied).toEqual([])
    expect(res.skipped[0]).toMatchObject({ cluster_id: cl.id, reason: 'needs_approval' })
    expect(await statusOf(a.id)).toBe('active')
    expect(await statusOf(b.id)).toBe('active')
  })

  it('the in-transaction check refuses a statement that does not match the approval hash', async () => {
    const [a, b] = await protectedPair()
    const plan = await plur.consolidatePlan({ llm: modelSaying('Never commit secrets to any repository') })
    const cl = { ...plan.clusters[0], approved: true, approved_statement_hash: approvalStatementHash('Never commit secrets to any repository') }
    // Called with a statement other than the one approved (the pre-check bypassed).
    const outcome = await (plur as unknown as {
      _applyConsolidationCluster(p: ConsolidationPlan, c: typeof cl, s: string, d: Date): Promise<unknown>
    })._applyConsolidationCluster(plan, cl, 'Something else entirely, never reviewed', new Date())
    expect(outcome).toMatchObject({ skip: 'needs_approval' })
    expect(await statusOf(a.id)).toBe('active')
    expect(await statusOf(b.id)).toBe('active')
  })

  it('a matching approval hash applies, and so does a plain approval of the statement in the file', async () => {
    await protectedPair()
    const plan = await plur.consolidatePlan({ llm: modelSaying('Never commit secrets to any repository') })
    const cl = plan.clusters[0]
    const bound: ConsolidationPlan = { ...plan, clusters: [{ ...cl, approved: true, approved_statement_hash: approvalStatementHash(`  ${cl.merged_statement!}\n`) }] }
    const res = await plur.consolidateApply(bound, { limit: 1 })
    expect(res.applied.length).toBe(1)
    expect(res.applied[0].cluster_id).toBe(cl.id)
  })
})
