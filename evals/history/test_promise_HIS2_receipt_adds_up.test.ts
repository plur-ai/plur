// HIS-2: The usage receipt adds up, and forgotten memories do not inflate it.
//
// Setup: four memories of my own and a pack of two. Three sessions retrieve
// some of them. Then one retrieved memory is forgotten. What the agent was
// actually given (each inject's injected_ids) is the ground truth the receipt
// is checked against.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'
import { authorPack, scratch } from '../helpers/sync-packs-durability-history-packs.js'

describe('HIS-2 the usage receipt adds up, and forgotten memories do not inflate it', () => {
  const cleanups: Array<() => void> = []
  let s: TempStore
  afterEach(() => { s?.cleanup(); while (cleanups.length) cleanups.pop()!() })

  it('counts add up, and a forgotten memory is neither stored nor counted as retrieved', async () => {
    s = await tempStore({ embedder: 'off' })
    const kubernetes = await s.plur.learn('Kubernetes deployments need a readiness probe', { scope: 'global' })
    const postgres = await s.plur.learn('Postgres vacuum runs nightly on the primary', { scope: 'global' })
    await s.plur.learn('Terraform state lives in the shared bucket', { scope: 'global' })
    await s.plur.learn('The office plants are watered on Fridays', { scope: 'global' })
    const src = scratch('plur-eval-his2-'); cleanups.push(src.cleanup)
    await s.plur.installPack(await authorPack(join(src.dir, 'p', 'ops-pack'), 'ops-pack', [
      'Kubernetes pods should set memory limits', 'Grafana dashboards are exported as JSON',
    ], 20))

    const injected = new Map<string, Set<string>>() // session -> ids given to the agent
    for (const [session, task] of [
      ['s1', 'kubernetes readiness probe for deployments'],
      ['s2', 'postgres vacuum on the primary database'],
      ['s3', 'kubernetes pods memory limits and terraform state bucket'],
    ] as const) {
      const r = await s.plur.inject(task, { session_id: session })
      injected.set(session, new Set(r.injected_ids))
    }
    const everInjected = new Set([...injected.values()].flatMap(x => [...x]))
    expect(everInjected.has(kubernetes.id) && everInjected.has(postgres.id), `precondition: the sessions retrieved my kubernetes and postgres memories (got ${[...everInjected].join(', ')})`).toBe(true)

    await s.plur.forget(postgres.id, 'eval: no longer true')
    expect((await s.plur.getById(postgres.id))?.status, 'precondition: the postgres memory is forgotten').toBe('retired')

    const r = await s.plur.receipt({ days: 7, now: new Date(Date.now() + 60_000) })

    // Stored: three of mine still stand (four taught, one forgotten), plus the pack's two.
    expect(r.stored.own, 'the receipt counts my forgotten memory as still stored').toBe(3)
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
    for (const t of r.reuse.top) {
      expect(t.retired, `the most-relied-on list shows ${t.id} as ${t.retired ? 'forgotten' : 'still stored'}, but it is ${t.id === postgres.id ? 'forgotten' : 'still stored'}`).toBe(t.id === postgres.id)
    }
  })
})
