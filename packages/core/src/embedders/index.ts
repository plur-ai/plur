/**
 * Embedder factory — Sprint 0 PR 4 (feat/embedder-bake-off).
 *
 * One uniform interface (`EmbedderAdapter`) across four candidate models:
 *
 *   - minilm            sentence-transformers/all-MiniLM-L6-v2     (384d, 22M)
 *   - bge-small         BAAI/bge-small-en-v1.5                     (384d, 33M)
 *   - bge-base          BAAI/bge-base-en-v1.5                      (768d, 110M)
 *   - embedding-gemma   google/EmbeddingGemma-300M (ONNX community) (768d, 300M)
 *
 * Pick one via PLUR_EMBEDDER env var or programmatically via `getEmbedder()`.
 *
 *   PLUR_EMBEDDER=bge-base node -e "..."   # 768d, pgvector column resized
 *   getEmbedder('embedding-gemma').embed(text)
 *
 * Wiring:
 *   - benchmark/run.ts uses this to map --embedder flag to a real adapter
 *   - storage-pglite.ts reads adapter.dim to size its vector(N) column
 *   - embeddings.ts will route through the active adapter in PR 5
 */
import { logger } from '../logger.js'
import { makeMiniLMAdapter } from './minilm.js'
import { makeBgeSmallAdapter } from './bge-small.js'
import { makeBgeBaseAdapter } from './bge-base.js'
import { makeEmbeddingGemmaAdapter } from './embedding-gemma.js'
import type { EmbedderAdapter } from './types.js'

export type { EmbedderAdapter } from './types.js'

/** All embedder names supported by the factory. Drives benchmark CLI parsing. */
export const EMBEDDER_NAMES = ['minilm', 'bge-small', 'bge-base', 'embedding-gemma'] as const
export type EmbedderName = typeof EMBEDDER_NAMES[number]

/**
 * Default embedder when PLUR_EMBEDDER is unset. We pick `bge-small` because
 * that is the model the v0.9.x runtime actually loads in embeddings.ts —
 * keeping the default here aligned avoids a silent behavior change when the
 * factory is wired into the engine.
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
 * (bge-small) when unset; logs a single warning and falls back to default on
 * unknown values rather than throwing — the active embedder is determined at
 * process start and we don't want a typo in an env var to brick the engine.
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
