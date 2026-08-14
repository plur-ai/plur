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
import { guard } from './guard.js'
import { registerLearning } from './learn.js'
import { createMemoryCache, renderBlock } from './memory-section.js'
import { createRefreshPolicy } from './refresh.js'
import { createScopeResolver } from './scope.js'
import { recallQueryFrom, type LogEvent } from './session-log.js'
import { readWorkspaceScope } from './workspace-scope.js'
import { registerSkills } from './skills.js'
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

/** Live per-agent state, disposed with the agent. */
interface AgentState {
  disposeSection: () => void
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
 * @param plur - the PLUR client; injected for tests, resolved by the host otherwise.
 */
export function apply(ctx: Context, config: Config, plur?: PlurClient): void {
  const counters = createCounters()
  const cache = createMemoryCache()
  const refresh = createRefreshPolicy({ refreshIntervalMs: config.refreshIntervalMs })
  // The REAL workspace reader, not a stub: without it every session on a
  // multi-session host collapses onto the configured default scope, ignoring
  // each workspace's own .plur.yaml.
  const scopes = createScopeResolver(config, readWorkspaceScope)
  const live = new Map<string, AgentState>()
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

  registerTools(ctx, { config, counters, plur, resolveScope })
  registerLearning(ctx, { config, counters, plur, resolveScope })
  registerCapture(ctx, { config, counters, plur, resolveScope })
  registerSkills(ctx)
  registerCommands(ctx, { config, counters })

  if (config.injectionMode !== 'off') {
    ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      const agentId = (agent as { id?: string } | undefined)?.id
      if (agentId === undefined) return decision
      if (decision.kind === 'reject') return decision
      if (signal.aborted) return decision

      ensureSection(agentId)

      if (refresh.shouldRefresh(agentId, step)) {
        refresh.markRefreshed(agentId)
        counters.bump('refresh_attempted')
        // Deliberately not awaited: a slow or wedged store must not stall the
        // turn. This turn renders whatever is cached; the next one sees the update.
        void refreshBlock(agentId, agent as AgentLike, turn, decision.messages)
      }

      // Returned UNCHANGED. Injection happens through the prompt section.
      return decision
    }, { prepend: true })
  }

  ctx.on('agent/disposed', (agent: unknown) => {
    const agentId = (agent as { id?: string } | null)?.id
    if (agentId === undefined) return
    const state = live.get(agentId)
    if (state) {
      try {
        state.disposeSection()
      } catch {
        onError()
      }
      live.delete(agentId)
    }
    cache.clear(agentId)
    refresh.clear(agentId)
    scopes.clear(agentId)
  })

  /** Register this agent's prompt section exactly once. */
  function ensureSection(agentId: string): void {
    if (live.has(agentId)) return
    try {
      const disposeSection = ctx.systemPrompt.section({
        name: 'plur:memory',
        order: SECTION_ORDER,
        // Synchronous and cache-only, so prompt assembly can never wait on, or
        // be broken by, the memory store.
        text: () => cache.read(agentId),
      })
      live.set(agentId, { disposeSection })
    } catch {
      // A host API change must not crash the turn. Mark the agent as handled so
      // we do not retry the same failing registration on every step.
      live.set(agentId, { disposeSection: () => {} })
      onError()
    }
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
  ): Promise<void> {
    const block = await guard(async () => {
      const events = agent?.session?.events ?? []
      const query = recallQueryFrom(events, turn, proposed)
      if (!query) return undefined
      const scope = await scopes.resolve(agentId, agent?.session?.header?.cwd)
      // Hybrid first; fall back to BM25-only exactly as @plur-ai/mcp does, so a
      // machine without the embedder still gets memory rather than nothing.
      const injection = plur?.injectHybrid
        ? await plur.injectHybrid(query, { scope })
        : await plur?.inject?.(query, { scope })
      counters.bump('engrams_rendered')
      // Rendering is INSIDE the guard: a malformed engram must not escape either.
      return renderBlock(injection, config.injectionBudget)
    }, { timeoutMs: config.timeoutMs, onError })

    if (block === undefined) return
    counters.bump(cache.write(agentId, block) ? 'blocks_written' : 'blocks_unchanged')
  }
}
