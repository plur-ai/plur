// What a save through PLUR's AI duplicate check left in the store (LRN-7, LRN-8).
//
// One labelled pair per fresh store: save the existing statement, then save the
// incoming one (single learnAsync, or learnBatch) with the given checker, then
// REOPEN the store with a fresh instance and classify what is there. The outcome
// is read from disk, never from the decision PLUR reports, so a reported MERGE
// that wrote nothing, or an ADD that rewrote the old memory, is judged by its
// effect.
//
// Labels (evals/gold/dedup-v2/LABELLER-CHECKLIST.md, owner decision 2026-10-18):
//   duplicate  -> one live memory; the existing text unchanged
//   supersede  -> both stored; the new statement live and saved as said; the old
//                 text unchanged and marked superseded by the new one
//   distinct   -> two live memories; the existing text unchanged
// Rewriting the existing memory's text is wrong under every label.
//
// "Live" means status active AND not superseded: a memory with a superseded_by
// link is no longer given to the agent (packages/core/src/inject.ts; proven by
// the correction promise COR-1), so it does not count as an active memory.
import { Plur } from '../../packages/core/src/index.js'
import type { DedupPair } from './quality.js'
import { tempStore, type EmbedderMode } from './store.js'

/**
 * one-memory          one live memory, no supersede link, existing text unchanged
 * superseded          the new statement live and saved as said, linked both ways
 *                     (new.supersedes has the old id, old.superseded_by has the new),
 *                     the old text unchanged
 * kept-separate       two live memories, no supersede link, existing text unchanged,
 *                     the new one saved as said
 * existing-rewritten  the existing memory's text changed, or it is gone
 * wrong-shape         anything else (a one-sided link, the old still live beside a
 *                     memory that claims to replace it, the new text altered, ...)
 * could-not-tell      the checker was asked and did not decide (an outage, not a decision)
 */
export type Outcome = 'one-memory' | 'superseded' | 'kept-separate' | 'existing-rewritten' | 'wrong-shape' | 'could-not-tell'
export type SavePath = 'single' | 'batch'
export interface Judged { pair: DedupPair; outcome: Outcome; right: boolean; decision?: string; asked: number; detail: string }

/** The fields of a stored memory the classification reads. */
export interface Stored {
  id: string
  statement: string
  status: string
  relations?: { supersedes?: string[]; superseded_by?: string[] }
}

const sup = (e: Stored) => e.relations?.supersedes ?? []
const supBy = (e: Stored) => e.relations?.superseded_by ?? []
const isLive = (e: Stored) => e.status === 'active' && supBy(e).length === 0

/** Classify a store snapshot. Pure: proven on hand-built snapshots in dedup-outcome.unit.test.ts. */
export function classify(p: Pick<DedupPair, 'existing' | 'incoming'>, existingId: string, stored: Stored[]): { outcome: Outcome; detail: string } {
  const old = stored.find(e => e.id === existingId)
  const others = stored.filter(e => e.id !== existingId)
  const live = stored.filter(isLive)
  const summary = `${stored.length} stored, ${live.length} live`
  if (!old) return { outcome: 'existing-rewritten', detail: `${summary}; the existing memory is gone` }
  if (old.statement !== p.existing) return { outcome: 'existing-rewritten', detail: `${summary}; the existing memory's text was changed` }
  if (old.status !== 'active' && supBy(old).length === 0) {
    return { outcome: 'existing-rewritten', detail: `${summary}; the existing memory was retired (${old.status}) without a superseding memory` }
  }
  const linked = others.filter(e => sup(e).includes(existingId) || supBy(old).includes(e.id))
  if (linked.length > 0) {
    const n = linked[0]
    const both = sup(n).includes(existingId) && supBy(old).includes(n.id)
    if (linked.length === 1 && both && n.statement === p.incoming && isLive(n) && !isLive(old)) {
      return { outcome: 'superseded', detail: `${summary}; the new memory supersedes the old, linked both ways` }
    }
    const why = linked.length > 1 ? 'more than one memory claims to replace the old one'
      : !both ? 'the supersede link is one-sided'
      : n.statement !== p.incoming ? 'the superseding memory does not hold the new statement as said'
      : isLive(old) ? 'the old memory is still live beside the one that replaces it'
      : 'the superseding memory is not live'
    return { outcome: 'wrong-shape', detail: `${summary}; ${why}` }
  }
  if (live.length === 1 && isLive(old)) return { outcome: 'one-memory', detail: `${summary}; only the existing memory` }
  const fresh = others.filter(isLive)
  if (live.length === 2 && isLive(old) && fresh.length === 1 && fresh[0].statement === p.incoming) {
    return { outcome: 'kept-separate', detail: `${summary}; both live, no link` }
  }
  return { outcome: 'wrong-shape', detail: `${summary}; not one of the expected shapes` }
}

/** Whether an outcome is right for a label. */
export function isRight(label: DedupPair['label'], outcome: Outcome): boolean {
  if (label === 'duplicate') return outcome === 'one-memory' || outcome === 'superseded'
  if (label === 'supersede') return outcome === 'superseded'
  return outcome === 'kept-separate'
}

export async function judgeDedupOutcome(
  p: DedupPair, llm: (prompt: string) => Promise<string>, embedder: EmbedderMode, path: SavePath = 'single',
): Promise<Judged> {
  const s = await tempStore({ embedder })
  try {
    const existing = await s.plur.learn(p.existing, { scope: 'global' })
    let asked = 0
    const counted = async (prompt: string) => { asked++; return llm(prompt) }
    let decision: string | undefined
    let mode: string | undefined
    if (path === 'single') {
      const r = await s.plur.learnAsync(p.incoming, { scope: 'global', llm: counted })
      decision = r.decision
      mode = r.dedup?.mode
    } else {
      const r: any = await s.plur.learnBatch([{ statement: p.incoming, context: { scope: 'global' } }], counted)
      const one = r?.results?.[0] ?? r?.[0]
      decision = one?.decision
      mode = one?.dedup?.mode ?? (asked > 0 ? 'llm' : undefined)
    }
    if (asked > 0 && mode !== 'llm') {
      return { pair: p, outcome: 'could-not-tell', right: false, decision, asked, detail: `the checker was asked but did not decide (dedup mode ${mode ?? 'none'})` }
    }
    const fresh = new Plur({ path: s.dir, autoDiscover: false })
    await fresh.ready()
    // list() returns active memories only; read the existing one by id as well,
    // so a retired or superseded original is classified, not reported as gone.
    const stored = (await fresh.list()) as unknown as Stored[]
    if (!stored.some(e => e.id === existing.id)) {
      const old = await fresh.getById(existing.id)
      if (old) stored.push(old as unknown as Stored)
    }
    const c = classify(p, existing.id, stored)
    return {
      pair: p, outcome: c.outcome, right: isRight(p.label, c.outcome), decision, asked,
      detail: `${c.detail}; decision ${decision}${asked === 0 ? ' (the checker was never shown the pair: no candidate found)' : ''}`,
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
