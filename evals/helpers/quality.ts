// Quality evals: labelled data in, a measured rate out, compared with a floor.
//
// The labels (evals/gold/<set>/) were written from the promise text by a
// different model family that never saw this code, and are frozen: a new
// version is a new folder, never an edit. The floors are literals in each eval,
// set by a code owner after the baseline was measured, never computed from the
// code under test.
//
// The dev set lives in the repo. The holdout set is private (owner decision
// 2026-10-14) and runs nightly when PLUR_EVAL_HOLDOUT_DIR points at it; tuning
// against the dev set that does not carry over to the holdout shows up there.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import type { Plur } from '../../packages/core/src/index.js'

export interface Memory { id: string; scope: string; statement: string }
export interface Query { id: string; query: string; relevant: string[]; kind: 'lexical' | 'paraphrase' }
export interface Pair { id: string; existing: string; incoming: string; label: 'duplicate' | 'distinct' }
export interface Task { id: string; task: string; scope: string; must_include: string[]; must_exclude: string[] }
export interface GoldSet { name: string; corpus: Memory[]; queries: Query[]; pairs: Pair[]; tasks: Task[] }

const GOLD = fileURLToPath(new URL('../gold', import.meta.url))

/** The dev set, or the private holdout when `which` is 'holdout' and it is configured. */
export function goldSet(which: 'dev' | 'holdout'): GoldSet {
  const dir = which === 'dev' ? join(GOLD, 'recall-v1') : process.env.PLUR_EVAL_HOLDOUT_DIR
  if (!dir || !existsSync(join(dir, 'corpus.yaml'))) {
    throw new Error(`could not tell: gold set '${which}' not found (${dir ?? 'PLUR_EVAL_HOLDOUT_DIR is not set'})`)
  }
  const read = (f: string) => yaml.load(readFileSync(join(dir, f), 'utf8')) as any
  return {
    name: which,
    corpus: read('corpus.yaml').memories,
    queries: read('queries.yaml').queries,
    pairs: read('dedup_pairs.yaml').pairs,
    tasks: read('inject_tasks.yaml').tasks,
  }
}

export const holdoutConfigured = (): boolean => Boolean(process.env.PLUR_EVAL_HOLDOUT_DIR)

/** Teach every corpus memory through the public write path; returns gold id -> engram id. */
export async function loadCorpus(plur: Plur, corpus: Memory[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  for (const m of corpus) {
    const e = await plur.learn(m.statement, { scope: m.scope })
    ids.set(m.id, e.id)
  }
  if (new Set(ids.values()).size !== corpus.length) {
    throw new Error(`precondition: ${corpus.length} memories taught but ${new Set(ids.values()).size} stored`)
  }
  return ids
}

export interface Rate { hits: number; n: number; rate: number; low: number; high: number; misses: string[] }

/** Wilson 95% interval. Retrieval here is deterministic, so this, not a spread over seeds, is the uncertainty. */
export function rate(hits: number, n: number, misses: string[] = []): Rate {
  if (n === 0) throw new Error('precondition: nothing was measured (n = 0)')
  const z = 1.96, p = hits / n, d = 1 + z * z / n
  const c = (p + z * z / (2 * n)) / d
  const h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d
  return { hits, n, rate: p, low: Math.max(0, c - h), high: Math.min(1, c + h), misses }
}

/**
 * Hybrid search that refuses to measure the wrong thing: a meaning model that
 * silently failed to load falls back to keyword search, and its score would be
 * reported as the model's. `expect` is 'hybrid' for the real model, 'bm25-only'
 * for the keyword control arm.
 */
export function searchIn(plur: Plur, expect: 'hybrid' | 'bm25-only', k: number) {
  return async (q: string) => {
    const r = await plur.recallHybridWithMeta(q, { limit: k })
    if (r.mode !== expect) {
      throw new Error(`precondition: search ran as '${r.mode}', expected '${expect}'${r.embedderError ? ` (${r.embedderError})` : ''}`)
    }
    return r.engrams
  }
}

/** Share of queries with at least one relevant memory in the top k. */
export async function recallAtK(
  search: (q: string) => Promise<Array<{ id: string }>>, queries: Query[], ids: Map<string, string>, k: number,
): Promise<Rate> {
  let hits = 0
  const misses: string[] = []
  for (const q of queries) {
    const got = (await search(q.query)).slice(0, k).map(e => e.id)
    const want = q.relevant.map(r => ids.get(r))
    if (want.some(w => w === undefined)) throw new Error(`precondition: query ${q.id} names an unknown memory`)
    if (want.some(w => got.includes(w!))) hits++
    else misses.push(q.id)
  }
  return rate(hits, queries.length, misses)
}

/** Area under the ROC curve: the chance a random duplicate pair scores above a random distinct pair. */
export function auc(dup: number[], distinct: number[]): number {
  if (!dup.length || !distinct.length) throw new Error('precondition: both classes need pairs')
  let wins = 0
  for (const a of dup) for (const b of distinct) wins += a > b ? 1 : a === b ? 0.5 : 0
  return wins / (dup.length * distinct.length)
}

export const fmt = (r: Rate): string =>
  `${r.hits}/${r.n} = ${(r.rate * 100).toFixed(1)}% (95% CI ${(r.low * 100).toFixed(1)}–${(r.high * 100).toFixed(1)}%)`
