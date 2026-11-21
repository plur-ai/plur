/**
 * Embedder factory — one `EmbedderAdapter` interface across models:
 *   minilm (384d), bge-small (384d), bge-base (768d), embedding-gemma (768d, opt-in), openai-3-large (3072d, API,
 *   opt-in, needs OPENAI_API_KEY).
 * Pick via the PLUR_EMBEDDER env var or `getEmbedder()`. storage-pglite.ts sizes its vector(N) column from
 * adapter.dim; embeddings.ts routes through the active adapter. DEFAULT_EMBEDDER below is authoritative for the
 * default — do not infer it from this header.
 */
import { logger } from '../logger.js'
import { makeMiniLMAdapter } from './minilm.js'
import { makeBgeSmallAdapter } from './bge-small.js'
import { makeBgeBaseAdapter } from './bge-base.js'
import { makeEmbeddingGemmaAdapter } from './embedding-gemma.js'
import { makeOpenAI3LargeAdapter } from './openai.js'
import type { EmbedderAdapter } from './types.js'

export type { EmbedderAdapter, EmbedRole } from './types.js'

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
 * BGE-small stays the default: in an embedder bake-off EmbeddingGemma tied
 * it on R@5, lost on R@1, and cost 2.4x peak RSS plus 11x p99 latency, and the
 * sample was too small to justify a switch.
 *
 * Opt in to embedding-gemma via PLUR_EMBEDDER=embedding-gemma; the adapter is
 * bundled and tested.
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
 * ({@link DEFAULT_EMBEDDER}) when unset; logs a single warning and falls back to
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
