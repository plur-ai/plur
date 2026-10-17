// What a save through PLUR's AI duplicate check left in the store (LRN-7).
//
// One labelled pair per fresh store: save the existing statement, then save the
// incoming one through learnAsync with the given checker, then REOPEN the store
// with a fresh instance and classify what is there. The outcome is read from
// disk, never from the decision PLUR reports, so a reported MERGE that wrote
// nothing, or an ADD that rewrote the old memory, is judged by its effect.
import { Plur } from '../../packages/core/src/index.js'
import type { Pair } from './quality.js'
import { tempStore, type EmbedderMode } from './store.js'

/**
 * one-memory              only one active memory remains (skipped, merged or updated)
 * kept-separate           two active: the existing text unchanged, the new one saved as said
 * existing-rewritten-and-kept  anything else (e.g. two memories but the old text changed)
 * could-not-tell          the checker was asked and did not decide (an outage, not a decision)
 */
export type Outcome = 'one-memory' | 'kept-separate' | 'existing-rewritten-and-kept' | 'could-not-tell'
export interface Judged { pair: Pair; outcome: Outcome; decision?: string; asked: number; detail: string }

export async function judgeDedupOutcome(p: Pair, llm: (prompt: string) => Promise<string>, embedder: EmbedderMode): Promise<Judged> {
  const s = await tempStore({ embedder })
  try {
    const existing = await s.plur.learn(p.existing, { scope: 'global' })
    let asked = 0
    const counted = async (prompt: string) => { asked++; return llm(prompt) }
    const r = await s.plur.learnAsync(p.incoming, { scope: 'global', llm: counted })
    if (asked > 0 && r.dedup?.mode !== 'llm') {
      return { pair: p, outcome: 'could-not-tell', asked, detail: `the checker was asked but did not decide (dedup mode ${r.dedup?.mode ?? 'none'})` }
    }
    const fresh = new Plur({ path: s.dir, autoDiscover: false })
    await fresh.ready()
    const active = (await fresh.list()).filter(e => e.status === 'active')
    const existingNow = active.find(e => e.id === existing.id)
    let outcome: Outcome
    if (active.length === 1) outcome = 'one-memory'
    else if (active.length === 2 && existingNow?.statement === p.existing && active.some(e => e.id !== existing.id && e.statement === p.incoming)) outcome = 'kept-separate'
    else outcome = 'existing-rewritten-and-kept'
    return {
      pair: p, outcome, decision: r.decision, asked,
      detail: `${active.length} active; decision ${r.decision}${asked === 0 ? ' (the checker was never shown the pair: no candidate found)' : ''}`,
    }
  } finally {
    s.cleanup()
  }
}

/** Run `f` over `xs`, at most `n` at a time, keeping order. */
export async function inBatches<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < xs.length; i += n) out.push(...await Promise.all(xs.slice(i, i + n).map(f)))
  return out
}
