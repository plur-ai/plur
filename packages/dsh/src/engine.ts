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
import { resolve } from 'node:path'
import type { FolderPolicy, Plur } from '@plur-ai/core'
import type { Config } from './config.js'
import type { PlurClient } from './client.js'

/** The constructor shape core exports. */
type PlurCtor = new (options: { path?: string }) => Plur

/** One session folder's answer: the client bound to its policy, or `off` with the words to relay. */
export type FolderMemory =
  | { off: false; plur: PlurClient; mode: string }
  | { off: true; message: string }

/** Ceiling on per-folder engine instances kept alive. */
const MAX_FOLDER_INSTANCES = 32

/** A facade that can also report whether the engine came up. */
export interface Engine extends PlurClient {
  /** Resolves true once the real engine is constructed, false if it cannot be. */
  ready(): Promise<boolean>
  /**
   * Is `dir` trusted (`plur trust`)? False when the engine is unavailable or
   * the check throws — the workspace-scope gate fails closed (decision E3).
   */
  trusts(dir: string): Promise<boolean>
  /** Can the engine answer `trusts` at all? Picks an honest remedy (audit 1228-c). */
  trustSupport(): Promise<'ok' | 'no-engine' | 'no-trust'>
  /** The folder map's decision for a session folder (security audit 2026-11-06). */
  forFolder(cwd: string | undefined): Promise<FolderMemory>
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
 * @param warn - called once on load failure; defaults to console.warn.
 * @returns the engine, or undefined when core cannot be loaded.
 */
async function loadEngine(
  config: Config,
  importCore: () => Promise<unknown>,
  warn: (msg: string) => void,
): Promise<{ plur: Plur; Plur: PlurCtor } | undefined> {
  try {
    const mod = await importCore() as { Plur?: PlurCtor; default?: { Plur?: PlurCtor } }
    // Tolerate both a named export and a default-wrapped namespace: bundlers
    // and Node disagree about interop often enough to be worth two lines.
    const Plur = mod.Plur ?? mod.default?.Plur
    if (typeof Plur !== 'function') return undefined
    return { plur: new Plur({ path: config.path }), Plur }
  } catch (error) {
    warn(`[plur] memory engine unavailable, continuing without memory: ${error}`)
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
 * @param warn - called once if the engine fails to load; defaults to console.warn.
 * @returns the facade.
 */
export function createEngine(
  config: Config,
  importCore: () => Promise<unknown> = () => import('@plur-ai/core'),
  warn: (msg: string) => void = (msg) => console.warn(msg),
): Engine {
  let pending: Promise<{ plur: Plur; Plur: PlurCtor } | undefined> | undefined
  const loaded = () => (pending ??= loadEngine(config, importCore, warn))
  const engine = async (): Promise<PlurClient | undefined> => (await loaded())?.plur

  // security audit 2026-11-06: one instance per folder, since remote-only is bound per instance.
  const folders = new Map<string, { inst: Plur; client: PlurClient }>()
  const off = (message: string): FolderMemory => ({ off: true, message })

  const facade: Engine = {
    ready: async () => (await engine()) !== undefined,
    trustSupport: async () => {
      const plur = await engine()
      if (!plur) return 'no-engine'
      return typeof plur.isDirectoryTrusted === 'function' ? 'ok' : 'no-trust'
    },
    trusts: async (dir) => {
      try {
        return (await engine())?.isDirectoryTrusted?.(dir) === true
      } catch {
        return false
      }
    },

    // Hybrid is the primary path; a build of core without it falls back to
    // BM25 here rather than at the call site, which cannot see inside.
    injectHybrid: async (task, options) => {
      const plur = await engine()
      return (await (plur?.injectHybrid ?? plur?.inject)?.call(plur, task, options)) ?? { count: 0 }
    },
    inject: async (task, options) => (await (await engine())?.inject?.(task, options)) ?? { count: 0 },
    recall: async (query, options) => (await (await engine())?.recall?.(query, options)) ?? [],
    learn: async (statement, context) => (await engine())?.learn?.(statement, context),
    forget: async (id, reason, options) => (await engine())?.forget?.(id, reason, options),
    feedback: async (id, signal, scope) => (await engine())?.feedback?.(id, signal, scope),
    capture: async (summary, context) => (await engine())?.capture?.(summary, context),
    list: async options => (await (await engine())?.list?.(options)) ?? [],
    status: async () => (await (await engine())?.status?.()) ?? {},

    // security audit 2026-11-06: resolved per call; `off` or an unreadable map reads and writes nothing.
    forFolder: async (cwd) => {
      const core = await loaded()
      // No engine: every method above already degrades to a no-op.
      if (!core) return { off: false, plur: facade, mode: 'on' }
            const dir = resolve(cwd ?? process.cwd())
      let policy: FolderPolicy
      try {
        policy = core.plur.resolveFolderPolicy(dir, { readOnly: true })
      } catch (error) {
        return off(`PLUR is off here: the folder decision for ${JSON.stringify(dir)} could not be resolved (${error}); nothing is read or written.`)
      }
      if (policy.mode === 'off' || policy.reason === 'malformed-map' || policy.reason === 'resolver-error') {
        return off(`PLUR is off for this folder (${JSON.stringify(dir)}): your folder map turns memory off here or could not be read, so nothing was read or written. `
          + 'This is not an error — carry on without memory. Only the user can turn it back on, from a terminal (plur folders list).')
      }
      let entry = folders.get(dir)
      if (!entry) {
        while (folders.size >= MAX_FOLDER_INSTANCES) {
          const [oldest, evicted] = folders.entries().next().value as [string, { inst: Plur }]
          folders.delete(oldest)
          try { evicted.inst.close?.() } catch { /* best effort */ }
        }
        const inst = new core.Plur({ path: config.path })
        // Only the PlurClient surface: core's own `ready()` resolves void, which `writable()` reads as "no engine".
        const client: PlurClient = {
          injectHybrid: inst.injectHybrid?.bind(inst),
          inject: inst.inject?.bind(inst),
          recall: inst.recall?.bind(inst),
          isDirectoryTrusted: inst.isDirectoryTrusted?.bind(inst),
          learn: inst.learn?.bind(inst),
          forget: inst.forget?.bind(inst),
          feedback: inst.feedback?.bind(inst),
          capture: inst.capture?.bind(inst),
          list: inst.list?.bind(inst),
          status: inst.status?.bind(inst),
        }
        entry = { inst, client }
        folders.set(dir, entry)
      }
      entry.inst.bindFolderPolicy(dir, policy)
      return { off: false, plur: entry.client, mode: policy.mode }
    },
  }
  return facade
}
