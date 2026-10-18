// HIS-2: The usage receipt adds up, and forgotten memories do not inflate it.
//
// Setup: four memories of my own and a pack of two. Three sessions are given
// some of them. Then one given memory is forgotten.
//
// Ground truth is what the agent was actually GIVEN: the memory ids whose
// entry ("[ID] ...") is present in the text the inject reply carries — not the
// injected_ids list the reply also reports (independent re-audit 2026-10-18,
// B-01 / INJ-7: a memory can be listed in injected_ids and still be missing
// from the reply, as the MCP inject tools drop the constraints section). A
// memory that was selected but never reached the agent was not relied on, so
// the receipt may not count it as given.
//
//  * Core: injections through plur.inject; its reply text is the directives,
//    constraints and consider sections it returns. Receipt read from core.
//  * MCP: injections through the plur_inject tool over the in-memory MCP
//    transport, the reply the agent's model reads. Receipt read through the
//    MCP plur_receipt tool (what the user's agent reads) and from core.
//
// The most-relied-on list is checked non-vacuously: it must not be empty,
// every entry's count must equal how many injections delivered that memory,
// and an entry is marked forgotten exactly when its memory is forgotten.
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
    const plur = s.plur
    await scenario(plur, cleanups, async (task, session) => {
      const r = await plur.inject(task, { session_id: session })
      return { selected: r.injected_ids, text: [r.constraints, r.directives, r.consider].join('\n') }
    }, async () => plur.receipt({ days: 7, now: new Date(Date.now() + 60_000) }), 'core receipt')
  })

  for (const read of ['MCP plur_receipt', 'core receipt'] as const) {
    it(`given through the MCP plur_inject tool, the ${read} counts only what the replies delivered`, async () => {
      useEmbedder('off')
      m = await mcpSession({ profile: 'full' })
      const mm = m
      await scenario(mm.plur, cleanups, async (task, session) => {
        const res = await mm.call('plur_inject', { task, session_id: session })
        expect(res.isError, `plur_inject failed: ${res.text}`).toBe(false)
        return { selected: res.json?.injected_ids ?? [], text: deliveredText(res.json) }
      }, async () => {
        if (read === 'core receipt') return mm.plur.receipt({ days: 7, now: new Date(Date.now() + 60_000) })
        const res = await mm.call('plur_receipt', { days: 7 })
        expect(res.isError, `plur_receipt failed: ${res.text}`).toBe(false)
        expect(res.json, `plur_receipt did not return a receipt: ${res.text}`).not.toBeNull()
        return res.json
      }, `${read} after MCP plur_inject`)
    })
  }
})

/** Every string an inject reply carries, except the bare id lists (they prove nothing). */
function deliveredText(reply: unknown): string {
  const out: string[] = []
  const walk = (v: unknown, key?: string): void => {
    if (key === 'injected_ids' || key === 'omitted_pinned') return
    if (typeof v === 'string') out.push(v)
    else if (Array.isArray(v)) v.forEach(x => walk(x))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k)
  }
  walk(reply)
  return out.join('\n')
}

type Inject = (task: string, session: string) => Promise<{ selected: string[]; text: string }>

async function scenario(plur: Plur, cleanups: Array<() => void>, inject: Inject, readReceipt: () => Promise<any>, where: string): Promise<void> {
  const kubernetes = await plur.learn('Kubernetes deployments need a readiness probe', { scope: 'global' })
  const postgres = await plur.learn('Postgres vacuum runs nightly on the primary', { scope: 'global' })
  // Terminological, so it renders in the "also consider" section: a section every
  // reply carries, so the delivered set is never empty by construction.
  const terraform = await plur.learn('Terraform state lives in the shared bucket', { scope: 'global', type: 'terminological' })
  await plur.learn('The office plants are watered on Fridays', { scope: 'global' })
  const src = scratch('plur-eval-his2-'); cleanups.push(src.cleanup)
  await plur.installPack(await authorPack(join(src.dir, 'p', 'ops-pack'), 'ops-pack', [
    'Kubernetes pods should set memory limits', 'Grafana dashboards are exported as JSON',
  ], 20))

  const injected = new Map<string, Set<string>>() // session -> ids DELIVERED in the reply text
  const selected = new Map<string, Set<string>>() // session -> ids the reply LISTS as given
  for (const [session, task] of [
    ['s1', 'kubernetes readiness probe for deployments'],
    ['s2', 'postgres vacuum on the primary database'],
    ['s3', 'kubernetes pods memory limits and terraform state bucket'],
  ] as const) {
    const r = await inject(task, session)
    selected.set(session, new Set(r.selected))
    injected.set(session, new Set(r.selected.filter(id => r.text.includes(`[${id}]`))))
  }
  const everSelected = new Set([...selected.values()].flatMap(x => [...x]))
  const everInjected = new Set([...injected.values()].flatMap(x => [...x]))
  // Precondition on selection: PLUR picked my kubernetes and postgres memories.
  // Whether they then reached the agent is what the receipt is judged on.
  expect(everSelected.has(kubernetes.id) && everSelected.has(postgres.id), `precondition: the sessions selected my kubernetes and postgres memories (got ${[...everSelected].join(', ')})`).toBe(true)
  expect(everInjected.has(terraform.id), `precondition: the terraform memory (also-consider section) reached the agent in a reply; delivered ${[...everInjected].join(', ') || 'nothing'}`).toBe(true)
  const notDelivered = [...selected].flatMap(([sess, ids]) => [...ids].filter(id => !injected.get(sess)!.has(id)).map(id => `${sess}:${id}`))
  const deliveryNote = notDelivered.length
    ? ` (listed as given but absent from the reply text, so not given: ${notDelivered.join(', ')})`
    : ''

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
  expect(r.retrieved.engrams, `${where}: the receipt says ${r.retrieved.engrams} distinct memories were retrieved; the replies delivered ${engramsExpected} that are still stored${deliveryNote}`).toBe(engramsExpected)
  expect(r.retrieved.engram_session_pairs, `${where}: retrieval pairs (${r.retrieved.engram_session_pairs}) do not match what the replies actually delivered, excluding the forgotten memory (${pairsExpected})${deliveryNote}`).toBe(pairsExpected)
  expect(r.retrieved.taught_pairs + r.retrieved.pack_pairs, 'taught + pack retrieval pairs do not add up to the total pairs').toBe(r.retrieved.engram_session_pairs)
  expect(r.dormant.never_retrieved, 'never-retrieved + retrieved does not equal the stored total').toBe(r.stored.total - r.retrieved.engrams)
  expect(r.retrieved.activation_rate, 'the activation rate is not retrieved / stored').toBeCloseTo(r.retrieved.engrams / r.stored.total, 6)
  expect(r.retrieved.engrams, 'more memories counted as retrieved than are stored').toBeLessThanOrEqual(r.stored.total)
  const forgottenDelivered = everInjected.has(postgres.id) ? 1 : 0
  expect(r.dormant.unavailable_but_retrieved, `${where}: the forgotten memory should be reported as unavailable ${forgottenDelivered} time(s), as often as it was delivered${deliveryNote}`).toBe(forgottenDelivered)
  // The most-relied-on list may still name a forgotten memory, but only marked as forgotten.
  const top: Array<{ id: string; count: number; retired: boolean }> = r.reuse.top
  expect(top.length, `${where}: precondition — the most-relied-on list is empty, though ${everSelected.size} memories were selected`).toBeGreaterThan(0)
  for (const t of top) {
    const timesGiven = [...injected.values()].filter(ids => ids.has(t.id)).length
    expect(t.count, `${where}: the most-relied-on list says ${t.id} was retrieved ${t.count} times; the replies delivered it ${timesGiven} times${deliveryNote}`).toBe(timesGiven)
  }
  for (const t of top) {
    expect(t.retired, `the most-relied-on list shows ${t.id} as ${t.retired ? 'forgotten' : 'still stored'}, but it is ${t.id === postgres.id ? 'forgotten' : 'still stored'}`).toBe(t.id === postgres.id)
  }
}
