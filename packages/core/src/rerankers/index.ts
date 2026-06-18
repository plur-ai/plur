/**
 * Reranker factory — Sprint 0 cross-encoder reranker stage (#220).
 *
 * One uniform interface (`RerankerAdapter`) across reranker models. Only one
 * adapter ships in this PR — bge-reranker-v2-m3 — but the factory shape is
 * here so future API-backed rerankers (cohere, voyage, zeroentropy) drop in
 * without changing call sites.
 *
 *   PLUR_RERANKER=bge-reranker-v2-m3   # opt in to the local cross-encoder
 *   PLUR_RERANKER=off                  # explicit skip (default)
 *
 * The reranker is OFF by default. PLUR's "no API key, no surprise latency"
 * posture extends to the model load cost: the BGE reranker adds ~50-500ms
 * per query (depending on K) and ~300 MB of resident weights once loaded.
 * Callers that want it set PLUR_RERANKER explicitly or pass
 * `rerank: true` to recallHybrid / injectHybrid.
 *
 * The "off" sentinel is a real adapter object whose scoreBatch is a no-op
 * — `isRerankerOff()` lets the recall path skip the rerank stage entirely
 * without an extra `if (!reranker)` branch in the hot path.
 */
import { logger } from '../logger.js'
import { makeBgeRerankerV2M3Adapter } from './bge-reranker-v2-m3.js'
import type { RerankerAdapter } from './types.js'

export type { RerankerAdapter } from './types.js'

/** All reranker names supported by the factory. */
export const RERANKER_NAMES = ['bge-reranker-v2-m3', 'off'] as const
export type RerankerName = typeof RERANKER_NAMES[number]

/**
 * Default reranker when PLUR_RERANKER is unset.
 *
 * Opt-in posture: the default is "off" until we have benchmark evidence that
 * the latency/memory cost is worth it on PLUR's typical recall workloads.
 * Issue #220 records the rollout plan — flip to bge-reranker-v2-m3 once the
 * LongMemEval-S ablation shows the expected R@1 lift.
 */
export const DEFAULT_RERANKER: RerankerName = 'off'

/** Sentinel name used by the off adapter. */
const OFF_NAME = 'off'

/** Singleton cache so two callers asking for the same name share the loaded model. */
const adapterCache = new Map<RerankerName, RerankerAdapter>()

/** Reset cached adapters. Test-only. */
export function _resetRerankerCache(): void {
  adapterCache.clear()
}

/**
 * The "off" adapter. Returns zero for every pair — the recall path treats
 * this as "no reranking happened" and falls back to the RRF order.
 *
 * `isRerankerOff(adapter)` distinguishes this sentinel from a real adapter
 * so the recall code can skip the loop entirely instead of paying for N
 * pointless zero-scores.
 */
const OFF_ADAPTER: RerankerAdapter = {
  name: OFF_NAME,
  modelId: '<off>',
  async score(): Promise<number> { return 0 },
  async scoreBatch(_q, docs): Promise<number[]> { return docs.map(() => 0) },
}

/** Returns true if the given adapter is the no-op "off" sentinel. */
export function isRerankerOff(adapter: RerankerAdapter): boolean {
  return adapter.name === OFF_NAME
}

/** Build (and cache) the adapter for a given name. Throws on unknown names. */
export function getReranker(name?: RerankerName): RerankerAdapter {
  const resolved = name ?? resolveRerankerName()
  if (!RERANKER_NAMES.includes(resolved)) {
    throw new Error(`Unknown reranker "${resolved}". Known: ${RERANKER_NAMES.join(', ')}`)
  }
  let adapter = adapterCache.get(resolved)
  if (!adapter) {
    adapter = build(resolved)
    adapterCache.set(resolved, adapter)
  }
  return adapter
}

function build(name: RerankerName): RerankerAdapter {
  switch (name) {
    case 'bge-reranker-v2-m3': return makeBgeRerankerV2M3Adapter()
    case 'off':                return OFF_ADAPTER
    default: {
      const _exhaustive: never = name
      throw new Error(`Unhandled reranker name: ${String(_exhaustive)}`)
    }
  }
}

/**
 * Resolve which reranker to use based on PLUR_RERANKER. Returns the default
 * (off) when unset; logs a single warning and falls back to default on
 * unknown values rather than throwing — the active reranker is determined
 * at process start and we don't want a typo in an env var to brick recall.
 */
let warnedUnknown = false
export function resolveRerankerName(env: NodeJS.ProcessEnv = process.env): RerankerName {
  const raw = env.PLUR_RERANKER?.trim()
  if (!raw) return DEFAULT_RERANKER
  if (RERANKER_NAMES.includes(raw as RerankerName)) return raw as RerankerName
  if (!warnedUnknown) {
    logger.warning(
      `[rerankers] PLUR_RERANKER="${raw}" not recognised. Falling back to "${DEFAULT_RERANKER}". Known: ${RERANKER_NAMES.join(', ')}`,
    )
    warnedUnknown = true
  }
  return DEFAULT_RERANKER
}

/** Reset the unknown-env-var warning latch. Test-only. */
export function _resetResolveWarnings(): void {
  warnedUnknown = false
}
