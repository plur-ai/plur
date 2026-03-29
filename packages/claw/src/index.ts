import { PlurContextEngine, type PlurContextEngineOptions } from './context-engine.js'
import { ensureSystemPrompt, PLUR_SYSTEM_SECTION } from './system-prompt.js'
import { checkForUpdate } from '@plur-ai/core'

// Re-export everything consumers might need
export { PlurContextEngine, type PlurContextEngineOptions }
export { ensureSystemPrompt, PLUR_SYSTEM_SECTION }
export type {
  ContextEngine, AssembleResult, IngestResult, CompactResult, BootstrapResult,
  AgentMessage,
} from './types.js'

// Shared engine singleton
let engine: PlurContextEngine | null = null
function getEngine(path: string): PlurContextEngine {
  if (!engine) engine = new PlurContextEngine({ path, auto_learn: true, auto_capture: true, injection_budget: 2000 })
  return engine
}

/**
 * PLUR OpenClaw Plugin — default export.
 *
 * When installed via `openclaw plugins install @plur-ai/claw`, OpenClaw
 * loads this as the plugin entry point. Registers:
 * - ContextEngine (memory injection, episode capture, learning extraction)
 * - Event hooks (before_agent_start for recall, agent_end for capture)
 * - SYSTEM.md auto-setup with memory instructions
 * - Service lifecycle
 *
 * Tools and slash commands are registered separately via the .mjs plugin
 * wrapper (which imports TypeBox from OpenClaw's runtime). This default
 * export provides the core memory functionality that works without TypeBox.
 */
const plugin = {
  id: 'plur-claw',
  name: 'PLUR Memory Engine',
  description: 'Persistent, learnable memory for OpenClaw agents. Local-first, no cloud required.',
  version: '0.3.2',
  kind: 'memory' as const,

  register(api: any) {
    const cfg = api.pluginConfig || {}
    const path = cfg.path || process.env.PLUR_PATH || `${process.env.HOME || '/root'}/.plur`

    // 1. Auto-setup SYSTEM.md
    const workspacePath = api.config?.agents?.defaults?.workspace || `${process.env.HOME || '/root'}/.openclaw/workspace`
    try {
      const result = ensureSystemPrompt(workspacePath)
      if (result.appended) api.logger.info(`PLUR: appended memory instructions to ${result.path}`)
      else if (result.updated) api.logger.info(`PLUR: updated memory instructions in ${result.path}`)
      else api.logger.info(`PLUR: memory instructions up to date`)
    } catch (err: any) {
      api.logger.warn(`PLUR: could not update SYSTEM.md: ${err.message}`)
    }

    // 2. Register context engine
    api.registerContextEngine('plur', () => {
      const e = getEngine(path)
      api.logger.info(`PLUR ContextEngine — engrams: ${e.plur.status().engram_count}`)
      return e
    })

    // 3. Event hooks (alongside ContextEngine for redundancy)
    api.on('before_agent_start', (event: any, ctx: any) => {
      const e = getEngine(path)
      const task = typeof event?.prompt === 'string' ? event.prompt : ''
      if (!task) return
      const injection = e.plur.inject(task, { budget: 2000 })
      if (injection.count === 0) return
      const lines = ['<plur-memory>']
      if (injection.directives) lines.push(injection.directives)
      if (injection.consider) lines.push(injection.consider)
      lines.push('</plur-memory>')
      return { prependContext: lines.join('\n') }
    })

    api.on('agent_end', (event: any, ctx: any) => {
      const e = getEngine(path)
      const messages = event?.messages
      if (Array.isArray(messages) && messages.length > 0) {
        const last = messages[messages.length - 1]
        const content = typeof last?.content === 'string' ? last.content :
          Array.isArray(last?.content) ? last.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : ''
        if (content.length > 10) {
          const summary = content.replace(/<plur-memory>[\s\S]*?<\/plur-memory>/g, '').trim().slice(0, 200) || 'Turn completed'
          e.plur.capture(summary, { agent: 'openclaw', session_id: ctx?.sessionId })
        }
      }
    })

    // 4. Slash commands
    if (typeof api.registerCommand === 'function') {
      api.registerCommand({
        name: 'learn',
        description: 'Save something to PLUR memory',
        acceptsArgs: true,
        handler: (ctx: any) => {
          if (!ctx.args?.trim()) return { text: 'Usage: /learn <statement to remember>' }
          const engram = getEngine(path).plur.learn(ctx.args.trim(), { source: 'openclaw:slash' })
          return { text: `Remembered: "${ctx.args.trim()}" (${engram.id})` }
        },
      })

      api.registerCommand({
        name: 'recall',
        description: 'Search PLUR memories',
        acceptsArgs: true,
        handler: (ctx: any) => {
          if (!ctx.args?.trim()) return { text: 'Usage: /recall <search query>' }
          const results = getEngine(path).plur.recall(ctx.args.trim(), { limit: 10 })
          if (!Array.isArray(results) || !results.length) return { text: 'No matching memories.' }
          return { text: `Found ${results.length} memories:\n${results.map((r: any, i: number) => `${i + 1}. [${r.id}] ${r.statement}`).join('\n')}` }
        },
      })

      api.registerCommand({
        name: 'forget',
        description: 'Retire a PLUR memory by ID',
        acceptsArgs: true,
        handler: (ctx: any) => {
          if (!ctx.args?.trim()) return { text: 'Usage: /forget <engram-id>' }
          getEngine(path).plur.forget(ctx.args.trim())
          return { text: `Retired: ${ctx.args.trim()}` }
        },
      })

      api.registerCommand({
        name: 'sync',
        description: 'Sync PLUR memories across devices via git',
        acceptsArgs: true,
        handler: (ctx: any) => {
          const remote = ctx.args?.trim() || undefined
          const result = getEngine(path).plur.sync(remote)
          return { text: `Sync: ${result.action}${result.message ? ` — ${result.message}` : ''}` }
        },
      })

      api.registerCommand({
        name: 'sync-status',
        description: 'Check PLUR sync status',
        acceptsArgs: false,
        handler: () => {
          const status = getEngine(path).plur.syncStatus()
          const parts = [`Sync status: ${status.initialized ? 'initialized' : 'not initialized'}`]
          if (status.remote) parts.push(`Remote: ${status.remote}`)
          if (status.dirty) parts.push('(uncommitted changes)')
          if (status.ahead) parts.push(`${status.ahead} ahead`)
          if (status.behind) parts.push(`${status.behind} behind`)
          return { text: parts.join('\n') }
        },
      })
    }

    // 5. CLI commands
    if (typeof api.registerCli === 'function') {
      api.registerCli((cliCtx: any) => {
        const cmd = cliCtx.program
          .command('plur')
          .description('PLUR memory management')
          .action(() => {
            const s = getEngine(path).plur.status()
            console.log(`PLUR Memory Status:`)
            console.log(`  Engrams: ${s.engram_count}`)
            console.log(`  Episodes: ${s.episode_count}`)
            console.log(`  Packs: ${s.pack_count}`)
            console.log(`  Storage: ${s.storage_root}`)
          })
        cmd
          .command('sync [remote]')
          .description('Sync memories via git')
          .action((remote?: string) => {
            const result = getEngine(path).plur.sync(remote)
            console.log(`Sync: ${result.action}${result.message ? ` — ${result.message}` : ''}`)
          })
      }, { commands: ['plur'] })
    }

    // 6. Service lifecycle
    api.registerService({
      id: 'plur-claw',
      start: () => api.logger.info(`PLUR: started (path: ${path})`),
      stop: () => api.logger.info('PLUR: stopped'),
    })

    api.logger.info(`PLUR registered: context engine + hooks + slash commands + CLI`)

    // Non-blocking version check
    checkForUpdate('@plur-ai/claw', plugin.version, (r) => {
      if (r.updateAvailable) {
        api.logger.warn(`PLUR update available: ${r.current} → ${r.latest}. Run: npm update @plur-ai/claw`)
      }
    })
  },
}

export default plugin
