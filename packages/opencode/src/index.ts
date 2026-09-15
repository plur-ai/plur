import { Plur, renderMemoryBlock, readProjectConfig, type ProjectConfig } from '@plur-ai/core'
// Type-only: the host contract is untyped at runtime — `@opencode-ai/plugin`
// is an optional peerDependency and this import must never become a runtime
// require. Typechecking the hook map against it turns a renamed/changed
// `experimental.` hook into a build failure instead of a silent no-op.
import type { Plugin, Hooks } from '@opencode-ai/plugin'
import { BlockCache } from './block.js'
import { RenderPath } from './capability.js'
import { TurnBuffer } from './turn.js'
import { learnFromTurn, learnFromUserText } from './learn.js'
import { OPENCODE_PLUGIN_VERSION } from './version.js'
import { resolveScopeRoot } from './scope.js'

const log = (msg: string) => { if (process.env.PLUR_DEBUG) console.error(`[plur:opencode] ${msg}`) }

/** Never let a memory failure break the agent's turn. */
async function safe(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn() } catch (err) { log(`${label} failed: ${(err as Error).message}`) }
}

export const PlurPlugin: Plugin = async (ctx) => {
  const scopeRoot = resolveScopeRoot(ctx ?? {})
  // `_plur` is a test-only injection seam, not part of the host contract —
  // narrowly typed here rather than widening `ctx` itself.
  const plur = (ctx as { _plur?: Plur })?._plur ?? new Plur({ path: process.env.PLUR_PATH, cwd: scopeRoot })
  const projectConfig = readProjectConfig(scopeRoot)
  log(`scope root: ${scopeRoot}`)
  if (projectConfig.scope) log(`project scope: ${projectConfig.scope}`)
  if (projectConfig.domain) log(`project domain: ${projectConfig.domain}`)
  const blocks = new BlockCache()
  const path = new RenderPath()
  const turns = new TurnBuffer()
  void OPENCODE_PLUGIN_VERSION

  return {
    // Recall trigger — once per user turn. Injects nothing under normal
    // operation: system.transform (below) is the rendering path, and a part
    // pushed here would persist into session history and accrete one stale
    // block per turn. The one exception is the RenderPath fallback below —
    // once a full turn has passed with system.transform never firing, this
    // DOES push a part, accepting the accretion because a working-but-
    // accreting path beats memory silently vanishing.
    'chat.message': async (input, output) => {
      await safe('chat.message', async () => {
        // Record this turn's user messageID so the event handler below can
        // exclude its parts from the turn buffer — message.part.updated
        // fires for the user's own submitted message too, not just the
        // assistant's streamed reply (confirmed against the real binary).
        turns.markUserMessage(input.sessionID, output.message?.id)

        const query = (output?.parts ?? [])
          .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
          .map((p: any) => p.text).join('\n')
        const injection = await plur.injectHybrid(query, {
          scope: projectConfig.scope,
        })
        blocks.set(input.sessionID, renderMemoryBlock({ injection }))
        log(`recall for ${input.sessionID}: ${injection?.count ?? 0} engrams`)

        // Secondary learning path: corrections/preferences from the user's
        // own text — the same text the recall query above was built from.
        // Fire-and-forget: never stall the turn on a slow store.
        void learnFromUserText(plur, query, projectConfig).catch((e) =>
          log(`learn (user) failed: ${(e as Error).message}`))

        // Safety net: system.transform is the preferred, non-accreting path.
        // If a full turn has gone by without it firing (see RenderPath),
        // opencode no longer supports it — fall back to injecting here so
        // memory keeps working instead of silently vanishing.
        if (path.shouldFallback(input.sessionID)) {
          const block = blocks.get(input.sessionID)
          const messageID = input.messageID ?? output.message?.id
          if (block && typeof messageID === 'string') {
            output.parts.push({
              id: `prt_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
              sessionID: input.sessionID,
              messageID,
              type: 'text',
              text: block,
              synthetic: true,
            })
            log('system.transform unavailable — using chat.message fallback (accretes)')
          } else if (block) {
            // Per the spec's Known Gotcha #1: a part with messageID undefined
            // gets the ENTIRE user message rejected by opencode
            // ("invalid user part before save"), and turn.ts's exclusion
            // check short-circuits on a falsy messageID — so it would also
            // get harvested as if it were the assistant's own text. Degrade
            // to no-injection rather than either of those.
            log('system.transform unavailable and no messageID resolved — skipping fallback injection')
          }
        }
      })
    },

    // Renderer — once per model request (3x in a tool-calling turn). O(1):
    // reads the cache, never recalls. `system` is rebuilt by the host each
    // request, so this never accumulates.
    'experimental.chat.system.transform': async (input, output) => {
      await safe('system.transform', async () => {
        const block = input.sessionID ? blocks.get(input.sessionID) : undefined
        if (block) output.system.push(block)
        if (input.sessionID) path.markRendered(input.sessionID)
      })
    },

    // Turn accumulation + debounced self-report learning.
    event: async ({ event }) => {
      await safe('event', async () => {
        if (event.type === 'message.part.updated' && event.properties?.part?.type === 'text') {
          const part = event.properties.part
          // Cumulative snapshot per part id, latest wins — TurnBuffer.append
          // also excludes parts whose messageID is this session's recorded
          // user message (see markUserMessage above and turn.ts's docstring).
          turns.append(part.sessionID, part.id, part.messageID, part.text ?? '')
        }
        if (event.type === 'session.idle') {
          const sessionID = event.properties?.sessionID
          // markTurn() goes ONLY here. Calling it from chat.message would
          // latch the fallback on turn one of every session, before
          // system.transform has had any chance to render at all.
          path.markTurn(sessionID)
          const texts = turns.takeIfFresh(sessionID)
          if (!texts) return
          // Fire-and-forget: never stall the turn on a slow store. One-shot
          // takeIfFresh already guards against session.idle's double-fire —
          // this only runs once per turn.
          void learnFromTurn(plur, texts, projectConfig).catch((e) =>
            log(`learn (turn) failed: ${(e as Error).message}`))
        }
        if (event.type === 'session.deleted') {
          const sessionID = event.properties?.info?.id
          blocks.clear(sessionID)
          turns.clear(sessionID)
          path.clear(sessionID)
        }
      })
    },

    // Context is about to be dropped. Carry memory across the cut, and learn
    // from what is being discarded. Never set `output.prompt` — that replaces
    // the host's compaction prompt entirely.
    'experimental.session.compacting': async (input, output) => {
      await safe('compacting', async () => {
        const block = blocks.get(input.sessionID)
        if (block) output.context.push(block)
        const texts = turns.takeIfFresh(input.sessionID)
        if (texts) void learnFromTurn(plur, texts, projectConfig).catch((e) =>
          log(`learn (compacting) failed: ${(e as Error).message}`))
      })
    },

    dispose: async () => {
      await safe('dispose', async () => {
        blocks.clearAll()
      })
    },
  } satisfies Hooks
}

export default PlurPlugin
