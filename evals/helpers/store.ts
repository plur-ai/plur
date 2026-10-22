// A throwaway PLUR store for one eval, and the embedders evals may use.
//
// Rules for evals (evals/README.md):
//  * Expected values are literals written from the promise, never imported
//    from the code under test (a constant cannot check itself).
//  * Every "at most / no more than" check also asserts the result is non-empty,
//    so an empty answer cannot pass.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Plur } from '../../packages/core/src/index.js'
import { _setCachedEmbedder, setEmbeddingsEnabled } from '../../packages/core/src/embeddings.js'

export type EmbedderMode = 'off' | 'bag-of-words' | 'real' | 'broken'

export interface TempStore {
  plur: Plur
  dir: string
  cleanup(): void
}

/** A fresh YAML-backed store in a temp dir, no auto-discovery, no remotes. */
export async function tempStore(opts: { embedder?: EmbedderMode; config?: string } = {}): Promise<TempStore> {
  const dir = mkdtempSync(join(tmpdir(), 'plur-eval-'))
  writeFileSync(join(dir, 'config.yaml'), opts.config ?? 'backend: yaml\n')
  useEmbedder(opts.embedder ?? 'off')
  const plur = new Plur({ path: dir, autoDiscover: false })
  await plur.ready()
  return { plur, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * off          — embeddings disabled: keyword search only.
 * bag-of-words — deterministic stub: texts sharing words are similar. Fast, offline,
 *                and blind to meaning, so it can never make a paraphrase eval pass.
 * real         — the shipped model (bge-small-en-v1.5). Quality evals only.
 * broken       — every embed call throws, as a model that fails to load does.
 */
export function useEmbedder(mode: EmbedderMode): void {
  // Quality evals judge which memory comes back, not how fast (REC-3 covers the
  // deadline). On a busy machine the default recall deadline cuts the meaning
  // model off and the eval refuses the keyword-only result, measuring nothing.
  if (mode === 'real') process.env.PLUR_RECALL_DEADLINE_MS = '120000'
  else delete process.env.PLUR_RECALL_DEADLINE_MS
  if (mode === 'off') return setEmbeddingsEnabled(false, 'eval: embeddings off')
  setEmbeddingsEnabled(true)
  if (mode === 'real') return
  if (mode === 'broken') {
    const fail = async (): Promise<never> => { throw new Error('eval: embedding model failed to load') }
    return _setCachedEmbedder({ name: 'broken-stub', dim: 64, modelId: 'stub', embed: fail, embedBatch: fail })
  }
  _setCachedEmbedder({
    name: 'bag-of-words-stub', dim: 64, modelId: 'stub',
    embed: async (t: string) => bagOfWords(t),
    embedBatch: async (ts: string[]) => ts.map(bagOfWords),
  })
}

export function bagOfWords(text: string, dim = 64): Float32Array {
  const v = new Float32Array(dim)
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261
    for (const c of w) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
    v[(h >>> 0) % dim] += 1
  }
  const n = Math.hypot(...v) || 1
  return v.map(x => x / n)
}
