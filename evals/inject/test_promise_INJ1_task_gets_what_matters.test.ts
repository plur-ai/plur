// INJ-1: For a given task, my agent is given the memories that matter for it, judged on a labelled set of tasks.
//
// Each labelled task names the memories it needs (must_include) and a nearby
// memory that does not apply (must_exclude). Two numbers, both on the shipped
// injection path (injectHybrid, real meaning model, default budget):
//   coverage — share of tasks where every needed memory was given;
//   leakage  — share of tasks where a not-applicable memory was given.
// Floors are literals, proposed from the first baseline (2026-10-15), confirmed by the owner 2026-10-16.
import { afterEach, describe, expect, it } from 'vitest'
import { fmt, goldSet, holdoutConfigured, loadCorpus, rate, type GoldSet } from '../helpers/quality.js'
import { tempStore, type TempStore } from '../helpers/store.js'

const COVERAGE_FLOOR = 0.7 // set by the owner 2026-10-16
const LEAKAGE_CEILING = 0.5 // set by the owner 2026-10-16

async function measure(set: GoldSet, s: TempStore) {
  const ids = await loadCorpus(s.plur, set.corpus)
  const id = (g: string) => {
    const e = ids.get(g)
    if (!e) throw new Error(`precondition: a task names unknown memory ${g}`)
    return e
  }
  let covered = 0, leaked = 0, given = 0
  const missed: string[] = [], leaks: string[] = []
  for (const t of set.tasks) {
    const r = await s.plur.injectHybrid(t.task, { scope: t.scope })
    if (r.mode !== 'hybrid') throw new Error(`precondition: injection ran as '${r.mode}' (${r.embedder_error ?? r.degraded_reason ?? ''}), not with the meaning model`)
    given += r.injected_ids.length
    if (t.must_include.every(g => r.injected_ids.includes(id(g)))) covered++
    else missed.push(t.id)
    if (t.must_exclude.some(g => r.injected_ids.includes(id(g)))) { leaked++; leaks.push(t.id) }
  }
  if (given === 0) throw new Error('precondition: injection gave nothing for any task')
  // Reported beside coverage: handing over everything would cover every task.
  return { coverage: rate(covered, set.tasks.length, missed), leakage: rate(leaked, set.tasks.length, leaks),
    perTask: given / set.tasks.length, corpus: set.corpus.length }
}

describe('INJ-1 a task is given the memories that matter for it', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  for (const which of ['dev', ...(holdoutConfigured() ? ['holdout'] as const : [])] as const) {
    it(`${which} set`, async () => {
      s = await tempStore({ embedder: 'real' })
      const { coverage, leakage, perTask, corpus } = await measure(goldSet(which), s)
      console.log(`INJ-1 ${which} coverage ${fmt(coverage)}; leakage ${fmt(leakage)}; ${perTask.toFixed(1)} of ${corpus} memories given per task`)
      expect(coverage.rate, `every needed memory was given for ${fmt(coverage)} of tasks; the floor is ${COVERAGE_FLOOR * 100}%. Missed: ${coverage.misses.join(', ')}`)
        .toBeGreaterThanOrEqual(COVERAGE_FLOOR)
      expect(leakage.rate, `a not-applicable memory was given for ${fmt(leakage)} of tasks; the ceiling is ${LEAKAGE_CEILING * 100}%. Tasks: ${leakage.misses.join(', ')}`)
        .toBeLessThanOrEqual(LEAKAGE_CEILING)
    })
  }
})
