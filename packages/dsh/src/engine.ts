/**
 * Constructing the real PLUR engine.
 *
 * `@plur-ai/core` is an ES module (`"type": "module"`, and its `exports` map
 * declares only an `import` condition). `createRequire(...)('@plur-ai/core')`
 * therefore throws `ERR_PACKAGE_PATH_NOT_EXPORTED` — which an earlier version
 * of this file swallowed, so the plugin registered every tool, skill and prompt
 * section and then recalled nothing, on every install. Unit tests never saw it
 * because they inject a client through `apply`'s third parameter.
 *
 * So: `import()`, not `require()`. Cordis calls `apply` synchronously and
 * cannot await, so this returns a facade immediately and resolves the real
 * engine behind it on first use. Every call site already awaits, so nothing
 * downstream has to know.
 *
 * @module
 */
import type { Config } from './config.js'
import type { PlurClient } from './client.js'

/** The constructor shape core exports. */
type PlurCtor = new (options: { path?: string }) => PlurClient

/** A facade that can also report whether the engine came up. */
export interface Engine extends PlurClient {
  /** Resolves true once the real engine is constructed, false if it cannot be. */
  ready(): Promise<boolean>
}

/**
 * Load `@plur-ai/core` and construct the engine.
 *
 * Deliberately not eager: core pulls in a WASM store, and a machine where that
 * fails to initialise must degrade to "no memory" rather than take down the
 * host agent at plugin-load time.
 *
 * @param config - supplies the optional store path.
 * @param importCore - overridable for tests.
 * @returns the engine, or undefined when core cannot be loaded.
 */
async function loadEngine(
  config: Config,
  importCore: () => Promise<unknown>,
): Promise<PlurClient | undefined> {
  try {
    const mod = await importCore() as { Plur?: PlurCtor; default?: { Plur?: PlurCtor } }
    // Tolerate both a named export and a default-wrapped namespace: bundlers
    // and Node disagree about interop often enough to be worth two lines.
    const Plur = mod.Plur ?? mod.default?.Plur
    if (typeof Plur !== 'function') return undefined
    return new Plur({ path: config.path })
  } catch {
    return undefined
  }
}

/**
 * Build the engine facade.
 *
 * Returns synchronously so Cordis's synchronous `apply` can wire it, while the
 * real engine loads on first call. Every method mirrors {@link PlurClient} and
 * resolves to `undefined` when the engine is unavailable — the same shape the
 * call sites already handle with `?.`.
 *
 * @param config - plugin configuration.
 * @param importCore - overridable module loader, for tests.
 * @returns the facade.
 */
export function createEngine(
  config: Config,
  importCore: () => Promise<unknown> = () => import('@plur-ai/core'),
): Engine {
  let pending: Promise<PlurClient | undefined> | undefined
  const engine = (): Promise<PlurClient | undefined> => (pending ??= loadEngine(config, importCore))

  return {
    ready: async () => (await engine()) !== undefined,

    // Hybrid is the primary path; a build of core without it falls back to
    // BM25 here rather than at the call site, which cannot see inside.
    injectHybrid: async (task, options) => {
      const plur = await engine()
      return (await (plur?.injectHybrid ?? plur?.inject)?.call(plur, task, options)) ?? { engrams: [] }
    },
    inject: async (task, options) => (await (await engine())?.inject?.(task, options)) ?? { engrams: [] },
    recall: async (query, options) => (await (await engine())?.recall?.(query, options)) ?? [],
    learn: async (statement, context) => (await engine())?.learn?.(statement, context),
    forget: async (id, reason, options) => (await engine())?.forget?.(id, reason, options),
    feedback: async (id, signal, scope) => (await engine())?.feedback?.(id, signal, scope),
    capture: async (summary, context) => (await engine())?.capture?.(summary, context),
    compactLearn: async input => (await engine())?.compactLearn?.(input),
    list: async options => (await (await engine())?.list?.(options)) ?? [],
    status: async () => (await (await engine())?.status?.()) ?? {},
  }
}
