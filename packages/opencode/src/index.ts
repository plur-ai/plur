import { Plur, renderMemoryBlock } from '@plur-ai/core'
import { BlockCache } from './block.js'
import { OPENCODE_PLUGIN_VERSION } from './version.js'

const log = (msg: string) => { if (process.env.PLUR_DEBUG) console.error(`[plur:opencode] ${msg}`) }

/** Never let a memory failure break the agent's turn. */
async function safe(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn() } catch (err) { log(`${label} failed: ${(err as Error).message}`) }
}

export const PlurPlugin = async (ctx: any) => {
  const plur = ctx?._plur ?? new Plur({})
  const blocks = new BlockCache()
  void OPENCODE_PLUGIN_VERSION

  return {
    // Recall trigger — once per user turn. Injects NOTHING: a part pushed here
    // is persisted into session history and accretes one stale block per turn.
    'chat.message': async (input: any, output: any) => {
      await safe('chat.message', async () => {
        const query = (output?.parts ?? [])
          .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
          .map((p: any) => p.text).join('\n')
        const injection = await plur.injectHybrid(query, {})
        blocks.set(input.sessionID, renderMemoryBlock({ injection }))
        log(`recall for ${input.sessionID}: ${injection?.count ?? 0} engrams`)
      })
    },

    // Renderer — once per model request (3x in a tool-calling turn). O(1):
    // reads the cache, never recalls. `system` is rebuilt by the host each
    // request, so this never accumulates.
    'experimental.chat.system.transform': async (input: any, output: any) => {
      await safe('system.transform', async () => {
        const block = input.sessionID ? blocks.get(input.sessionID) : undefined
        if (block) output.system.push(block)
      })
    },

    dispose: async () => { blocks.clearAll() },
  }
}

export default PlurPlugin
