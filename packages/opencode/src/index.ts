import { Plur, renderMemoryBlock } from '@plur-ai/core'
import { BlockCache } from './block.js'
import { RenderPath } from './capability.js'
import { TurnBuffer } from './turn.js'
import { learnFromTurn, learnFromUserText } from './learn.js'
import { OPENCODE_PLUGIN_VERSION } from './version.js'

const log = (msg: string) => { if (process.env.PLUR_DEBUG) console.error(`[plur:opencode] ${msg}`) }

/** Never let a memory failure break the agent's turn. */
async function safe(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn() } catch (err) { log(`${label} failed: ${(err as Error).message}`) }
}

export const PlurPlugin = async (ctx: any) => {
  const plur = ctx?._plur ?? new Plur({})
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
    'chat.message': async (input: any, output: any) => {
      await safe('chat.message', async () => {
        const query = (output?.parts ?? [])
          .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
          .map((p: any) => p.text).join('\n')
        const injection = await plur.injectHybrid(query, {})
        blocks.set(input.sessionID, renderMemoryBlock({ injection }))
        log(`recall for ${input.sessionID}: ${injection?.count ?? 0} engrams`)

        // Secondary learning path: corrections/preferences from the user's
        // own text — the same text the recall query above was built from.
        // Fire-and-forget: never stall the turn on a slow store.
        void learnFromUserText(plur, query).catch((e) =>
          log(`learn (user) failed: ${(e as Error).message}`))

        // Safety net: system.transform is the preferred, non-accreting path.
        // If a full turn has gone by without it firing (see RenderPath),
        // opencode no longer supports it — fall back to injecting here so
        // memory keeps working instead of silently vanishing.
        if (path.shouldFallback()) {
          const block = blocks.get(input.sessionID)
          if (block) {
            output.parts.push({
              id: `prt_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
              sessionID: input.sessionID,
              messageID: input.messageID ?? output.message?.id,
              type: 'text',
              text: block,
              synthetic: true,
            })
            log('system.transform unavailable — using chat.message fallback (accretes)')
          }
        }
      })
    },

    // Renderer — once per model request (3x in a tool-calling turn). O(1):
    // reads the cache, never recalls. `system` is rebuilt by the host each
    // request, so this never accumulates.
    'experimental.chat.system.transform': async (input: any, output: any) => {
      await safe('system.transform', async () => {
        const block = input.sessionID ? blocks.get(input.sessionID) : undefined
        if (block) output.system.push(block)
        path.markRendered()
      })
    },

    // Turn accumulation + debounced self-report learning.
    event: async ({ event }: any) => {
      await safe('event', async () => {
        if (event.type === 'message.part.updated' && event.properties?.part?.type === 'text') {
          turns.append(event.properties.part.sessionID, event.properties.part.text ?? '')
        }
        if (event.type === 'session.idle') {
          const sessionID = event.properties?.sessionID
          // markTurn() goes ONLY here. Calling it from chat.message would
          // latch the fallback on turn one of every session, before
          // system.transform has had any chance to render at all.
          path.markTurn()
          const texts = turns.takeIfFresh(sessionID)
          if (!texts) return
          // Fire-and-forget: never stall the turn on a slow store. One-shot
          // takeIfFresh already guards against session.idle's double-fire —
          // this only runs once per turn.
          void learnFromTurn(plur, texts).catch((e) =>
            log(`learn (turn) failed: ${(e as Error).message}`))
        }
        if (event.type === 'session.deleted') {
          const sessionID = event.properties?.info?.id
          blocks.clear(sessionID)
          turns.clear(sessionID)
        }
      })
    },

    dispose: async () => { blocks.clearAll() },
  }
}

export default PlurPlugin
