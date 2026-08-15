/**
 * PLUR memory for DeepSeek Harness.
 *
 * Engrams reach the model through a `ctx.systemPrompt` section that dsh
 * re-renders on every assembly, NOT through an appended `user/message`.
 *
 * That distinction is load-bearing. dsh projects injected user messages into
 * derived history verbatim (`deriveEventMessage` returns `event.data` with no
 * `form` check) and nothing removes them, so tail injection would accrete a
 * fresh block on every step until compaction — silently inflating the user's
 * context and bill. `form: 'snapshot'` does NOT prevent this; it is a
 * presentation label a client renderer reads to pick an icon. Do not
 * "simplify" this back into appending to `PreStepDecision.messages`.
 * See docs/specs/2026-08-14-dsh-plugin-design.md §1.
 *
 * @module @plur-ai/dsh
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
// Side-effect type imports. Each of these packages augments Cordis's Context and
// Events via `declare module '@deepseek-ai/cordis'`, which is how `ctx.systemPrompt`,
// `ctx.tools`, and the `agent/*` event names become typed here.
import '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-system-prompt'
import '@deepseek-ai/dsh-tools'
import type { PlurClient } from './client.js'
import { registerCapture } from './capture.js'
import { registerCommands } from './commands.js'
import { Config } from './config.js'
import { createCounters } from './counters.js'
import { createWriteQueue, guard } from './guard.js'
import { registerLearning } from './learn.js'
import { createMemoryCache, renderBlock } from './memory-section.js'
import { createRefreshPolicy } from './refresh.js'
import { createScopeResolver, readScope } from './scope.js'
import { recallQueryFrom, type LogEvent } from './session-log.js'
import { readWorkspaceScope } from './workspace-scope.js'
import { registerSkills } from './skills.js'
import { createEngine } from './engine.js'
import { createViewer } from './viewer.js'
import { registerTools } from './tools.js'

export { Config }
export type { PlurClient }

/** Cordis plugin name, used by loader diagnostics and as the context source tag. */
export const name = 'plur'

/** Services this plugin needs before it activates. */
export const inject = ['systemPrompt', 'tools']

/** Kept in step with package.json by scripts/release.sh --dsh. */
export const VERSION = '0.1.0'

/**
 * Section order. The convention in dsh is -100 harness identity, 0 deployment
 * persona, 100-199 tool guidance. Memory sits with tool guidance: it is
 * operating context, not a competing persona.
 */
const SECTION_ORDER = 120

/**
 * Ceiling on tracked live agents.
 *
 * Per-agent state is normally reclaimed on `agent/disposed`, but a host that
 * drops sessions on disconnect or crash may never emit it. Without a cap, a
 * long-lived server accumulates cached blocks for dead sessions forever.
 * Evicting the oldest is safe: the state is a cache, and a still-live agent
 * simply repopulates it on its next step.
 */
const MAX_TRACKED_AGENTS = 512

/** Live per-agent state, disposed with the agent. */
interface AgentState {
  /** Monotonic refresh counter; a completed refresh writes only if it is still the latest. */
  generation: number
  /** True while a refresh is in flight, so a wedged store cannot pile up work. */
  refreshing: boolean
}

/**
 * The structural slice of a live dsh Agent this plugin reads.
 *
 * Deliberately structural rather than importing `Agent`: the concrete type is
 * large and moving fast on a pre-1.0 dependency, and everything here needs is
 * the id, the event log, and the workspace directory.
 */
interface AgentLike {
  readonly id?: string
  readonly session?: {
    readonly events?: readonly LogEvent[]
    readonly header?: { readonly cwd?: string }
  }
}

/**
 * Mount the plugin.
 *
 * @param ctx - the Cordis context to register against.
 * @param config - validated plugin configuration.
 * @param injected - test seam for the PLUR client. Production passes nothing and
 *   the engine is constructed from config.
 */
export function apply(ctx: Context, config: Config, injected?: PlurClient): void {
  // Cordis calls apply(ctx, config) with two arguments, so the third parameter
  // is a TEST seam only. In production the engine is constructed here — an
  // earlier build left it undefined in production, which registered every
  // surface and then silently recalled nothing.
  const plur = injected ?? createEngine(config)
  const counters = createCounters()
  const cache = createMemoryCache()
  const refresh = createRefreshPolicy({ refreshIntervalMs: config.refreshIntervalMs })
  // The REAL workspace reader, not a stub: without it every session on a
  // multi-session host collapses onto the configured default scope, ignoring
  // each workspace's own .plur.yaml.
  const scopes = createScopeResolver(config, readWorkspaceScope)
  const live = new Map<string, AgentState>()
  // ONE queue for the whole plugin's ENGRAM WRITES — learn, capture, and the
  // tools. Previously learn.ts and capture.ts each made their own and the
  // tools bypassed queueing entirely.
  //
  // It is not, and does not claim to be, a serialization guarantee over every
  // store touch. `refreshBlock` calls `injectHybrid` outside it once per turn,
  // and that IS a write — core bumps `injection_count`, which on the YAML
  // backend rewrites the corpus (measured at 714ms on a 60-engram store).
  // Routing it through the queue would make a slow store stall the next turn's
  // recall behind the previous one, which is the opposite of keeping recall
  // off the turn path. Correctness is core's `_withStoreLock`; this queue is
  // about not interleaving OUR writes.
  const queue = createWriteQueue()
  const onError = () => counters.bump('errors_swallowed')

  /**
   * Resolve the scope of whichever session is calling.
   *
   * Tools receive the calling `agent` on their execution context; the
   * `session/event` paths receive the session. Both carry an id and a cwd,
   * which is all the resolver needs. Falling back to a single shared id here
   * would collapse every concurrent session onto one scope — the cross-project
   * leak this indirection exists to prevent.
   */
  const resolveScope = (caller?: {
    id?: string
    session?: { header?: { cwd?: string } }
    header?: { cwd?: string }
  }): Promise<string> => {
    const cwd = caller?.session?.header?.cwd ?? caller?.header?.cwd
    return scopes.resolve(caller?.id ?? `anon:${cwd ?? 'none'}`, cwd)
  }

  registerTools(ctx, { config, counters, plur, resolveScope, queue })
  registerLearning(ctx, { config, counters, plur, resolveScope, queue })
  registerCapture(ctx, { config, counters, plur, resolveScope, queue })
  // Skills and commands are OPTIONAL surfaces, so they mount in their own
  // scoped fibers via ctx.inject() rather than joining this plugin's `inject`
  // list. Two reasons, and the first one is a crash we shipped past every unit
  // test: Cordis throws on merely READING `ctx.skills` when `skills` is not
  // declared — a `typeof ctx.skills?.register` guard never runs, because the
  // property ACCESS throws first, which took the whole dsh boot down. Second,
  // making them hard requirements would stop memory working at all on a minimal
  // profile that composes no skill or command registry.
  // Started lazily by /plur-memory and stopped with the plugin, so a host that
  // never opens the viewer never binds a port.
  const viewer = createViewer(plur)
  // ctx.effect() is Cordis's disposal seam — there is no 'dispose' event. The
  // returned teardown runs when this plugin's fiber goes away, so unloading
  // PLUR also releases the viewer's port.
  ctx.effect(() => () => { void viewer.dispose() }, 'plur-viewer')

  // ONE section, registered once on the plugin's own context, keyed by the
  // agent the host passes for each assembly. This is verbatim the pattern
  // @deepseek-ai/dsh-plan-mode uses (`text: (context) => context.agent ...`),
  // including its explicit no-agent guard.
  //
  // The alternative — one section PER AGENT under the same name — throws by
  // contract on the duplicate, and the catch that hid it meant agents 2..N got
  // nothing while the surviving section served agent 1's memory to all of
  // them. `agent.ctx` is not the answer either: reading `agent.ctx.systemPrompt`
  // throws "cannot get property without inject" on a scope that did not
  // declare it.
  if (config.injectionMode !== 'off') {
    // Contained: this runs at mount, so a host whose section API has moved
    // would otherwise take the whole plugin — and the boot — down with it.
    try {
      const disposeSection = ctx.systemPrompt.section({
        name: 'plur:memory',
        order: SECTION_ORDER,
      // Synchronous and cache-only, so prompt assembly can never wait on, or
      // be broken by, the memory store. A diagnostic assembly carries no
      // agent; render nothing rather than somebody's memory.
        text: context => {
          const agentId = context?.agent?.id
          return agentId === undefined ? '' : cache.read(agentId)
        },
      })
      ctx.effect(() => () => { try { disposeSection() } catch { onError() } }, 'plur-section')
    } catch {
      onError()
    }
  }

  ctx.inject(['skills'], scoped => { registerSkills(scoped) })
  ctx.inject(['commands'], scoped => { registerCommands(scoped, { config, counters, viewer }) })

  if (config.injectionMode !== 'off') {
    ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      const agentId = (agent as { id?: string } | undefined)?.id
      if (agentId === undefined) return decision
      // `decision` is whatever the REST of the plugin chain returned — we
      // register with { prepend: true }, so a neighbour with one path that
      // forgets to return hands back undefined. Cordis's waterfall has no
      // containment, so an unguarded `.kind` here becomes a PLUR-branded crash
      // in someone else's plugin's name.
      if (decision?.kind === 'reject') return decision
      if (signal?.aborted === true) return decision

      const state = trackAgent(agentId)
      // An in-flight refresh means the store is slower than the user is typing.
      // Skipping is right: guard() times a call out but cannot CANCEL the work
      // behind it, so launching another would pile real work up in the host.
      if (state && !state.refreshing && refresh.shouldRefresh(agentId, step)) {
        refresh.markRefreshed(agentId)
        counters.bump('refresh_attempted')
        state.refreshing = true
        const generation = ++state.generation
        // Deliberately not awaited: a slow or wedged store must not stall the
        // turn. This turn renders whatever is cached; the next one sees the update.
        void refreshBlock(agentId, agent as AgentLike, turn, decision.messages, generation)
      }

      // Returned UNCHANGED. Injection happens through the prompt section.
      return decision
    }, { prepend: true })
  }

  // The payload is `{ agent }`, NOT the agent. Reading `.id` off the payload
  // always produced undefined, so nothing was ever reclaimed and eviction was
  // the only path that ran.
  ctx.on('agent/disposed', (payload: { agent?: { id?: string } }) => {
    const agentId = payload?.agent?.id
    if (agentId === undefined) return
    releaseAgent(agentId)
  })

  /** Drop the oldest tracked agents once the ceiling is reached. */
  function evictIfNeeded(): void {
    while (live.size >= MAX_TRACKED_AGENTS) {
      const oldest = live.keys().next()
      if (oldest.done) return
      releaseAgent(oldest.value)
    }
  }

  /** Tear down everything held for one agent. Safe to call for an unknown id. */
  function releaseAgent(agentId: string): void {
    live.delete(agentId)
    cache.clear(agentId)
    refresh.clear(agentId)
    scopes.clear(agentId)
  }

  /** Per-agent refresh bookkeeping. Creates it on first sight. */
  function trackAgent(agentId: string): AgentState {
    const existing = live.get(agentId)
    if (existing) return existing
    evictIfNeeded()
    const state: AgentState = { generation: 0, refreshing: false }
    live.set(agentId, state)
    return state
  }

  /**
   * Recompute and cache one agent's block.
   *
   * The ENTIRE body is inside `guard`, not just the store call. This function is
   * invoked with `void` from the pre-step listener, so anything that escapes it
   * becomes an unhandled promise rejection — which modern Node treats as fatal
   * and would take the user's whole agent down. Query construction reads
   * host-supplied data that can be malformed, so it must be inside the guard
   * too; an earlier version had it outside and a junk event array produced
   * exactly that unhandled rejection.
   */
  async function refreshBlock(
    agentId: string,
    agent: AgentLike | undefined,
    turn: number,
    proposed: readonly unknown[],
    generation: number,
  ): Promise<void> {
    const block = await guard(async () => {
      const events = agent?.session?.events ?? []
      const query = recallQueryFrom(events, turn, proposed)
      if (!query) return undefined
      const scope = await scopes.resolve(agentId, agent?.session?.header?.cwd)
      // Hybrid first; fall back to BM25-only exactly as @plur-ai/mcp does, so a
      // machine without the embedder still gets memory rather than nothing.
      const where = readScope(scope, config.includeGlobal)
      const injection = plur?.injectHybrid
        ? await plur.injectHybrid(query, where)
        : await plur?.inject?.(query, where)
      // By the COUNT, not by one per attempt. `/plur` exists to answer "why
      // didn't it remember that?", and during the inert-engine bug — when the
      // plugin recalled nothing at all, on every install — this counter still
      // incremented once per turn and read perfectly healthy.
      const rendered = injection?.count ?? 0
      for (let i = 0; i < rendered; i++) counters.bump('engrams_rendered')
      // Rendering is INSIDE the guard: a malformed engram must not escape either.
      return renderBlock(injection, config.injectionBudget)
    }, { timeoutMs: config.timeoutMs, onError })

    const state = live.get(agentId)
    if (state) state.refreshing = false
    if (block === undefined) return
    // Drop a stale result. Two turns can be in flight when the first recall is
    // slow; without this the older one lands last and the model is shown memory
    // retrieved for a question the user has already moved on from.
    if (!state || state.generation !== generation) return
    counters.bump(cache.write(agentId, block) ? 'blocks_written' : 'blocks_unchanged')
  }
}
