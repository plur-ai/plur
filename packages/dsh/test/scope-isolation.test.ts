/**
 * Cross-session scope isolation.
 *
 * dsh's default profile is a multi-session web server, so one plugin instance
 * serves several concurrent agents. Every path that touches the store —
 * injection, tools, auto-learn, capture — must resolve the CALLING session's
 * scope. A path that resolves a shared or default scope instead will silently
 * read one project's memories into another project's session, or write them
 * there. That is worse than no memory, and it is invisible without this test.
 */
import { describe, expect, it, vi } from 'vitest'
import type { PlurClient } from '../src/client.js'
import { Config } from '../src/config.js'
import { createCounters } from '../src/counters.js'
import { registerLearning } from '../src/learn.js'
import { registerTools } from '../src/tools.js'
import { cfg } from './helpers/config.js'

const settle = () => new Promise(r => setTimeout(r, 20))

/** Workspaces declare their own scope, as a real .plur.yaml would. */
const SCOPE_BY_CWD: Record<string, string> = {
  '/work/acme': 'project:acme',
  '/work/zeta': 'project:zeta',
}

function toolHarness(plur: PlurClient, config = cfg({})) {
  const tools: any[] = []
  const ctx = { tools: { register: (d: any) => { tools.push(d); return () => {} } } }
  const scopes = new Map<string, string>()
  registerTools(ctx as never, {
    config,
    counters: createCounters(),
    plur,
    queue: async <T,>(fn: () => Promise<T>) => { try { return await fn() } catch { return undefined } },

    resolveScope: async (agent?: { id?: string; session?: { header?: { cwd?: string } } }) => {
      const cwd = agent?.session?.header?.cwd
      const scope = (cwd && SCOPE_BY_CWD[cwd]) || config.scope || 'project:dsh'
      if (agent?.id) scopes.set(agent.id, scope)
      return scope
    },
  })
  return { tools, scopes }
}

const agentIn = (id: string, cwd: string) => ({ id, session: { header: { cwd } } })

describe('tools resolve the CALLING session scope', () => {
  it('plur_recall in workspace A does not read workspace B scope', async () => {
    const recall = vi.fn(async () => [])
    const { tools } = toolHarness({ recall })
    const tool = tools.find(t => t.name === 'plur_recall')!

    await tool.execute({ query: 'x' }, { agent: agentIn('a1', '/work/acme'), signal: new AbortController().signal })
    await tool.execute({ query: 'x' }, { agent: agentIn('a2', '/work/zeta'), signal: new AbortController().signal })

    expect(recall).toHaveBeenNthCalledWith(1, 'x', expect.objectContaining({ scope: 'project:acme' }))
    expect(recall).toHaveBeenNthCalledWith(2, 'x', expect.objectContaining({ scope: 'project:zeta' }))
  })

  it('plur_learn writes into the calling session scope, not a shared default', async () => {
    const learn = vi.fn(async () => {})
    const { tools } = toolHarness({ learn })
    const tool = tools.find(t => t.name === 'plur_learn')!

    await tool.execute({ statement: 'Deploy with pnpm.' }, { agent: agentIn('a1', '/work/acme'), signal: new AbortController().signal })

    expect(learn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ scope: 'project:acme' }))
  })

  it('plur_status reports the calling session scope', async () => {
    const { tools } = toolHarness({})
    const tool = tools.find(t => t.name === 'plur_status')!
    const value = await tool.execute({}, { agent: agentIn('a1', '/work/zeta'), signal: new AbortController().signal })
    expect(String(value.text)).toContain('project:zeta')
  })

  it('falls back to the configured default when the call carries no agent', async () => {
    const recall = vi.fn(async () => [])
    const { tools } = toolHarness({ recall })
    const tool = tools.find(t => t.name === 'plur_recall')!
    await tool.execute({ query: 'x' }, { signal: new AbortController().signal })
    expect(recall).toHaveBeenCalledWith('x', expect.objectContaining({ scope: 'project:dsh' }))
  })
})

describe('auto-learn resolves the originating session scope', () => {
  it('a correction in workspace A is not written to workspace B', async () => {
    const learn = vi.fn(async () => {})
    const listeners: Function[] = []
    const ctx = {
      on: (event: string, fn: Function) => {
        if (event === 'session/event') listeners.push(fn)
        return () => {}
      },
    }
    const config = cfg({})
    registerLearning(ctx as never, {
      config,
      counters: createCounters(),
      plur: { learn },
    queue: async <T,>(fn: () => Promise<T>) => { try { return await fn() } catch { return undefined } },

      resolveScope: async (session?: { header?: { cwd?: string } }) => {
        const cwd = session?.header?.cwd
        return (cwd && SCOPE_BY_CWD[cwd]) || config.scope || 'project:dsh'
      },
    })

    const event = {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Always deploy with pnpm.' }] },
    }
    await Promise.all(listeners.map(fn => fn({ id: 's1', header: { cwd: '/work/acme' } }, event)))
    await settle()

    expect(learn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ scope: 'project:acme' }))
  })
})
