// HIS-2: The usage receipt adds up, and forgotten memories do not inflate it.
//
// Setup: four memories of my own and a pack of two. Three sessions retrieve
// some of them. Then one retrieved memory is forgotten. What the agent was
// actually given (each inject's injected_ids) is the ground truth the receipt
// is checked against.
//
// The receipt is read twice: from core, and through the MCP plur_receipt tool,
// which is what the user's agent reads (audit B-01 sibling). The
// most-relied-on list is checked non-vacuously: it must not be empty, every
// entry's count must equal how many injections gave that memory, and an entry
// is marked forgotten exactly when its memory is forgotten.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, useEmbedder, type TempStore } from '../helpers/store.js'
import { mcpSession, type McpSession } from '../helpers/agent-tools-hooks-mcp.js'
import type { Plur } from '../../packages/core/src/index.js'
import { authorPack, scratch } from '../helpers/sync-packs-durability-history-packs.js'

describe('HIS-2 the usage receipt adds up, and forgotten memories do not inflate it', () => {
  const cleanups: Array<() => void> = []
  let s: TempStore | undefined
  let m: McpSession | undefined
  afterEach(async () => { s?.cleanup(); s = undefined; await m?.close(); m = undefined; while (cleanups.length) cleanups.pop()!() })

  it('counts add up, and a forgotten memory is neither stored nor counted as retrieved (core)', async () => {
    s = await tempStore({ embedder: 'off' })
    await scenario(s.plur, cleanups, async () => s.plur.receipt({ days: 7, now: new Date(Date.now() + 60_000) }), 'core receipt')
  })

  it('the same receipt through the MCP plur_receipt tool adds up', async () => {
    useEmbedder('off')
    m = await mcpSession({ profile: 'full' })
    const mm = m
    await scenario(mm.plur, cleanups, async () => {
      const res = await mm.call('plur_receipt', { days: 7 })
      expect(res.isError, `plur_receipt failed: ${res.text}`).toBe(false)
      expect(res.json, `plur_receipt did not return a receipt: ${res.text}`).not.toBeNull()
      return res.json
    }, 'MCP plur_receipt')
  })
})

async function scenario(plur: Plur, cleanups: Array<() => void>, readReceipt: () => Promise<any>, where: string): Promise<void> {
  const kubernetes = await plur.learn('Kubernetes deployments need a readiness probe', { scope: 'global' })
  const postgres = await plur.learn('Postgres vacuum runs nightly on the primary', { scope: 'global' })
  await plur.learn('Terraform state lives in the shared bucket', { scope: 'global' })
  await plur.learn('The office plants are watered on Fridays', { scope: 'global' })
  const src = scratch('plur-eval-his2-'); cleanups.push(src.cleanup)
  await plur.installPack(await authorPack(join(src.dir, 'p', 'ops-pack'), 'ops-pack', [
    'Kubernetes pods should set memory limits', 'Grafana dashboards are exported as JSON',
  ], 20))

  const injected = new Map<string, Set<string>>() // session -> ids given to the agent
  for (const [session, task] of [
    ['s1', 'kubernetes readiness probe for deployments'],
    ['s2', 'postgres vacuum on the primary database'],
    ['s3', 'kubernetes pods memory limits and terraform state bucket'],
  ] as const) {
    const r = await plur.inject(task, { session_id: session })
    injected.set(session, new Set(r.injected_ids))
  }
  const everInjected = new Set([...injected.values()].flatMap(x => [...x]))
  expect(everInjected.has(kubernetes.id) && everInjected.has(postgres.id), `precondition: the sessions retrieved my kubernetes and postgres memories (got ${[...everInjected].join(', ')})`).toBe(true)

  await plur.forget(postgres.id, 'eval: no longer true')
  expect((await plur.getById(postgres.id))?.status, 'precondition: the postgres memory is forgotten').toBe('retired')

  const r = await readReceipt()

  // Stored: three of mine still stand (four taught, one forgotten), plus the pack's two.
  expect(r.stored.own, `${where}: the receipt counts my forgotten memory as still stored`).toBe(3)
  expect(r.stored.pack, 'the receipt should count the two pack memories').toBe(2)
  expect(r.stored.own + r.stored.pack, 'own + pack does not equal the stored total').toBe(r.stored.total)

  // Retrieved: only memories still stored count; the forgotten one is reported apart.
  const pairsExpected = [...injected.values()].reduce((n, ids) => n + [...ids].filter(id => id !== postgres.id).length, 0)
  const engramsExpected = [...everInjected].filter(id => id !== postgres.id).length
  expect(r.retrieved.engrams, `the receipt says ${r.retrieved.engrams} distinct memories were retrieved; the agent was given ${engramsExpected} that are still stored`).toBe(engramsExpected)
  expect(r.retrieved.engram_session_pairs, 'retrieval pairs do not match what the sessions were actually given (excluding the forgotten memory)').toBe(pairsExpected)
  expect(r.retrieved.taught_pairs + r.retrieved.pack_pairs, 'taught + pack retrieval pairs do not add up to the total pairs').toBe(r.retrieved.engram_session_pairs)
  expect(r.dormant.never_retrieved, 'never-retrieved + retrieved does not equal the stored total').toBe(r.stored.total - r.retrieved.engrams)
  expect(r.retrieved.activation_rate, 'the activation rate is not retrieved / stored').toBeCloseTo(r.retrieved.engrams / r.stored.total, 6)
  expect(r.retrieved.engrams, 'more memories counted as retrieved than are stored').toBeLessThanOrEqual(r.stored.total)
  expect(r.dormant.unavailable_but_retrieved, 'the forgotten memory that was retrieved should be reported as unavailable, once').toBe(1)
  // The most-relied-on list may still name a forgotten memory, but only marked as forgotten.
  const top: Array<{ id: string; count: number; retired: boolean }> = r.reuse.top
  expect(top.length, `${where}: precondition — the most-relied-on list is empty, though ${everInjected.size} memories were given`).toBeGreaterThan(0)
  for (const t of top) {
    const timesGiven = [...injected.values()].filter(ids => ids.has(t.id)).length
    expect(t.count, `${where}: the most-relied-on list says ${t.id} was retrieved ${t.count} times; the sessions were given it ${timesGiven} times`).toBe(timesGiven)
  }
  for (const t of top) {
    expect(t.retired, `the most-relied-on list shows ${t.id} as ${t.retired ? 'forgotten' : 'still stored'}, but it is ${t.id === postgres.id ? 'forgotten' : 'still stored'}`).toBe(t.id === postgres.id)
  }
}
