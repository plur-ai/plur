/**
 * Formal-verification run (Adapters cluster, candidate 6, mcp-integrations#4):
 * a dsh write tool reports success only when an engine performed the write.
 * The engine facade deliberately degrades a write to a resolved no-op when
 * core cannot load (engine.test.ts pins that), so the tools must not read
 * "resolved" as "written".
 */
import { describe, expect, it, vi } from 'vitest'
import { createCounters } from '../src/counters.js'
import { createEngine } from '../src/engine.js'
import { registerTools } from '../src/tools.js'
import { registerLearning } from '../src/learn.js'
import { createWriteQueue } from '../src/guard.js'
import { cfg } from './helpers/config.js'

const missing = () => Promise.reject(new Error('ERR_MODULE_NOT_FOUND'))

function tools(plur: unknown) {
  const out: any[] = []
  const ctx = { tools: { register: (d: any) => { out.push(d); return () => {} } } }
  const counters = createCounters()
  registerTools(ctx as any, {
    config: cfg({}), counters, plur: plur as never, queue: createWriteQueue(),
    resolveScope: async () => 'project:dsh',
  })
  const run = async (name: string, args: unknown) => {
    const t = out.find(x => x.name === name)
    const v = await t.execute(args, { signal: new AbortController().signal })
    return t.output.render(args, v).map((b: any) => b.text).join('\n')
  }
  return { run, counters }
}

describe('dsh writes report what happened (formal Adapters #6)', () => {
  it('with core unloadable, plur_learn does not say "Stored." and counts nothing', async () => {
    const { run, counters } = tools(createEngine(cfg({}), missing, () => {}))
    const out = await run('plur_learn', { statement: 'Always pin the deps.' })
    expect(out).not.toMatch(/^Stored\./)
    expect(out).toMatch(/Could not store/)
    expect(counters.snapshot().learn_captured ?? 0).toBe(0)
  })

  it('with core unloadable, plur_forget / plur_feedback do not claim success', async () => {
    const { run } = tools(createEngine(cfg({}), missing, () => {}))
    expect(await run('plur_forget', { id: 'ENG-1' })).not.toMatch(/^Retired\./)
    expect(await run('plur_feedback', { id: 'ENG-1', signal: 'positive' })).not.toMatch(/^Recorded\./)
  })

  it('with no client at all, plur_learn does not say "Stored."', async () => {
    const { run } = tools(undefined)
    expect(await run('plur_learn', { statement: 'Always pin the deps.' })).toMatch(/Could not store/)
  })

  it('auto-learn does not count a capture the facade silently dropped', async () => {
    const listeners: Function[] = []
    const counters = createCounters()
    registerLearning({ on: (_e: string, fn: Function) => { listeners.push(fn); return () => {} } } as never, {
      config: cfg({}), counters, plur: createEngine(cfg({}), missing, () => {}) as never,
      queue: createWriteQueue(), resolveScope: async () => 'project:dsh',
    })
    await Promise.all(listeners.map(fn => fn({ id: 's1' }, {
      type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Always pin the dsh packages.' }] },
    })))
    await new Promise(r => setTimeout(r, 50))
    expect(counters.snapshot().learn_captured ?? 0).toBe(0)
  })

  it('good case: a working engine still stores and counts', async () => {
    const learn = vi.fn(async () => ({ id: 'ENG-1' }))
    const { run, counters } = tools({ learn, ready: async () => true })
    expect(await run('plur_learn', { statement: 'Always pin.' })).toMatch(/^Stored\./)
    expect(counters.snapshot().learn_captured).toBe(1)
    const bare = tools({ learn })   // injected client without ready(): trusted as-is
    expect(await bare.run('plur_learn', { statement: 'Always pin.' })).toMatch(/^Stored\./)
  })
})
