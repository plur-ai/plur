/**
 * Formal-verification apply phase, decision S3 ("hard-cap"), 2026-09-26.
 *
 * A dsh write that exceeds its soft timeout (`timeoutMs`) keeps the write-queue
 * slot until it settles, or until a larger hard cap elapses; then the queue
 * releases the slot with a warning. A tool call still answers UNAVAILABLE at
 * the soft timeout. Before: auto-learn/capture enqueued
 * `queue(() => guard(write, soft))`, so the slot was released at the soft
 * timeout while the write kept running and the next write overlapped it.
 * spec/formal/findings/adapters.md §6(b), PlurSpec/Adapters.lean §6.
 */
import { describe, expect, it, vi } from 'vitest'
import { createCounters } from '../src/counters.js'
import { registerLearning } from '../src/learn.js'
import { registerTools } from '../src/tools.js'
import { createWriteQueue } from '../src/guard.js'
import { cfg } from './helpers/config.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function learning(plur: unknown, timeoutMs: number, queue = createWriteQueue({ hardCapMs: 5_000 })) {
  const listeners: Function[] = []
  const counters = createCounters()
  registerLearning({ on: (_e: string, fn: Function) => { listeners.push(fn); return () => {} } } as never, {
    config: cfg({ timeoutMs }), counters, plur: plur as never, queue,
    resolveScope: async () => 'project:dsh',
  })
  const say = (text: string) => Promise.all(listeners.map(fn => fn({ id: 's1' }, {
    type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  })))
  return { say, counters, queue }
}

describe('dsh write queue: soft timeout does not release the slot (S3)', () => {
  it('an auto-learn write past its soft timeout still serialises the next write', async () => {
    const order: string[] = []
    let n = 0
    const learn = vi.fn(async (statement: string) => {
      const me = ++n
      order.push(`start${me}`)
      await sleep(120)
      order.push(`end${me}`)
      return { id: `ENG-${me}`, statement }
    })
    const { say } = learning({ learn, ready: async () => true }, 20)
    await say('Always pin the dsh packages.')
    await say('Never skip the lockfile review.')
    await sleep(400)
    expect(order).toEqual(['start1', 'end1', 'start2', 'end2'])
  })

  it('a write that never settles is released at the hard cap, with a warning', async () => {
    const released: number[] = []
    const q = createWriteQueue({ hardCapMs: 60, onRelease: ms => released.push(ms) })
    const hung = q(() => new Promise<never>(() => {}))
    const next = q(async () => 'next ran')
    const winner = await Promise.race([next, sleep(1_000).then(() => 'still wedged')])
    expect(winner).toBe('next ran')
    await expect(hung).resolves.toBeUndefined()
    expect(released).toEqual([60])
  })

  it('a tool write still answers UNAVAILABLE at the soft timeout, and holds the slot', async () => {
    const out: any[] = []
    const ctx = { tools: { register: (d: any) => { out.push(d); return () => {} } } }
    const order: string[] = []
    const learn = vi.fn(async () => { order.push('tool-start'); await sleep(150); order.push('tool-end'); return { id: 'ENG-1' } })
    const queue = createWriteQueue({ hardCapMs: 5_000 })
    registerTools(ctx as any, {
      config: cfg({ timeoutMs: 20 }), counters: createCounters(), plur: { learn, ready: async () => true } as never,
      queue, resolveScope: async () => 'project:dsh',
    })
    const t = out.find(x => x.name === 'plur_learn')
    const v = await t.execute({ statement: 'Always pin the deps.' }, { signal: new AbortController().signal })
    const text = t.output.render({}, v).map((b: any) => b.text).join('\n')
    expect(text).not.toMatch(/^Stored\./)
    await queue(async () => { order.push('next') })
    expect(order).toEqual(['tool-start', 'tool-end', 'next'])
  })

  it('good case: fast writes still run in order and resolve their values', async () => {
    const q = createWriteQueue()
    expect(await Promise.all([q(async () => 1), q(async () => 2)])).toEqual([1, 2])
  })
})
