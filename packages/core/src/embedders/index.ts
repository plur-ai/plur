/**
 * Embedder factory — Sprint 0 PR 4 (feat/embedder-bake-off) + PR 5
 * (feat/embedding-gemma-default).
 *
 * One uniform interface (`EmbedderAdapter`) across the candidate models:
 *
 *   - minilm            sentence-transformers/all-MiniLM-L6-v2     (384d, 22M)
 *   - bge-small         BAAI/bge-small-en-v1.5                     (384d, 33M)
 *   - bge-base          BAAI/bge-base-en-v1.5                      (768d, 110M)
 *   - embedding-gemma   google/EmbeddingGemma-300M (ONNX community) (768d, 300M) — DEFAULT
 *   - openai-3-large    OpenAI text-embedding-3-large              (3072d, API)  — opt-in
 *
 * Pick one via PLUR_EMBEDDER env var or programmatically via `getEmbedder()`.
 *
 *   PLUR_EMBEDDER=bge-base node -e "..."   # 768d, pgvector column resized
 *   PLUR_EMBEDDER=openai-3-large           # API tier (requires OPENAI_API_KEY)
 *   getEmbedder('embedding-gemma').embed(text)
 *
 * Wiring:
 *   - benchmark/run.ts uses this to map --embedder flag to a real adapter
 *   - storage-pglite.ts reads adapter.dim to size its vector(N) column
 *   - embeddings.ts routes through the active adapter
 *
 * PR 5 default switch: bake-off (docs/benchmarks/embedder-bake-off-2026-05.md)
 * showed EmbeddingGemma matches BGE-small on R@5 with the best Accuracy at
 * N=5/category and Apache-2.0 license. The default flipped from bge-small to
 * embedding-gemma. If Phase C (N=500) inverts the ordering it's a one-line
 * revert here.
 */
import { logger } from '../logger.js'
import { makeMiniLMAdapter } from './minilm.js'
import { makeBgeSmallAdapter } from './bge-small.js'
import { makeBgeBaseAdapter } from './bge-base.js'
import { makeEmbeddingGemmaAdapter } from './embedding-gemma.js'
import { makeOpenAI3LargeAdapter } from './openai.js'
import type { EmbedderAdapter } from './types.js'

export type { EmbedderAdapter } from './types.js'

/** All embedder names supported by the factory. Drives benchmark CLI parsing. */
export const EMBEDDER_NAMES = [
  'minilm',
  'bge-small',
  'bge-base',
  'embedding-gemma',
  'openai-3-large',
] as const
export type EmbedderName = typeof EMBEDDER_NAMES[number]

/**
 * Default embedder when PLUR_EMBEDDER is unset.
 *
 * Sprint 0 iter-1 audit (docs/audit/sprint-0/iter-1-gaps-consolidated.md, B-2)
 * reverted the default from `embedding-gemma` back to `bge-small`. The PR 4
 * bake-off ran on N=5/category (30 scenarios) — too small to justify the
 * decision rule "≥2pp R@5 at or below CPU cost." EmbeddingGemma tied BGE-small
 * on R@5, lost on R@1 (43.3% vs 46.7%), and costs 2.4x peak RSS plus 11x p99
 * latency. The default flip is deferred to Phase C (real LongMemEval-S, N=500
 * per category) — see docs/benchmarks/embedder-bake-off-2026-05.md for the
 * deferred decision. BGE-small remains the v0.9.x production default; this is
 * a zero-risk revert until Phase C produces evidence.
 *
 * Flip to embedding-gemma via PLUR_EMBEDDER=embedding-gemma; the adapter is
 * still bundled and tested.
 */
export const DEFAULT_EMBEDDER: EmbedderName = 'bge-small'

/** Singleton cache so two callers asking for the same name share metadata + the inner pipeline. */
const adapterCache = new Map<EmbedderName, EmbedderAdapter>()

/** Reset cached adapters. Test-only — production code never calls this. */
export function _resetEmbedderCache(): void {
  adapterCache.clear()
}

/** Build (and cache) the adapter for a given name. Throws on unknown names. */
export function getEmbedder(name: EmbedderName): EmbedderAdapter {
  if (!EMBEDDER_NAMES.includes(name)) {
    throw new Error(`Unknown embedder "${name}". Known: ${EMBEDDER_NAMES.join(', ')}`)
  }
  let adapter = adapterCache.get(name)
  if (!adapter) {
    adapter = build(name)
    adapterCache.set(name, adapter)
  }
  return adapter
}

function build(name: EmbedderName): EmbedderAdapter {
  switch (name) {
    case 'minilm':           return makeMiniLMAdapter()
    case 'bge-small':        return makeBgeSmallAdapter()
    case 'bge-base':         return makeBgeBaseAdapter()
    case 'embedding-gemma':  return makeEmbeddingGemmaAdapter()
    case 'openai-3-large':   return makeOpenAI3LargeAdapter()
    default: {
      // Exhaustiveness check — TS will complain if a new EmbedderName is
      // added without a switch arm.
      const _exhaustive: never = name
      throw new Error(`Unhandled embedder name: ${String(_exhaustive)}`)
    }
  }
}

/**
 * Resolve which embedder to use based on PLUR_EMBEDDER. Returns the default
 * (embedding-gemma) when unset; logs a single warning and falls back to
 * default on unknown values rather than throwing — the active embedder is
 * determined at process start and we don't want a typo in an env var to
 * brick the engine.
 */
let warnedUnknown = false
export function resolveEmbedderName(env: NodeJS.ProcessEnv = process.env): EmbedderName {
  const raw = env.PLUR_EMBEDDER?.trim()
  if (!raw) return DEFAULT_EMBEDDER
  if (EMBEDDER_NAMES.includes(raw as EmbedderName)) return raw as EmbedderName
  if (!warnedUnknown) {
    logger.warning(
      `[embedders] PLUR_EMBEDDER="${raw}" not recognised. Falling back to "${DEFAULT_EMBEDDER}". Known: ${EMBEDDER_NAMES.join(', ')}`,
    )
    warnedUnknown = true
  }
  return DEFAULT_EMBEDDER
}

/** Reset the unknown-env-var warning latch. Test-only. */
export function _resetResolveWarnings(): void {
  warnedUnknown = false
}
