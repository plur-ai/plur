/**
 * Adversarial suite: deliberate attempts to break the plugin.
 *
 * The governing invariant is that a PLUR failure must never fail the host's
 * turn, and must never silently inflate the user's context. Every test here is
 * an attack on one of those two properties. A failure in this file is a bug that
 * would surface as "PLUR broke my coding session".
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlurClient } from '../src/client.js'
import { Config } from '../src/config.js'
import { apply } from '../src/index.js'
import { createWriteQueue, guard } from '../src/guard.js'
import { renderBlock } from '../src/memory-section.js'
import { recallQueryFrom } from '../src/session-log.js'
import { cfg } from './helpers/config.js'

async function boot(plur?: PlurClient, config = cfg({})) {
  const ctx = new Context() as Context & Record<string, any>
  ctx.plugin(SystemPrompt, {})
  await new Promise(r => setTimeout(r, 50))
  ctx.tools = { register: () => () => {} } as never
  ctx.skills = { register: () => () => {} } as never
  ctx.commands = { register: () => () => {} } as never

  const listeners = new Map<string, Function[]>()
  const realOn = ctx.on.bind(ctx)
  ctx.on = ((event: string, fn: Function, opts?: unknown) => {
    listeners.set(event, [...(listeners.get(event) ?? []), fn])
    try { return realOn(event as never, fn as never, opts as never) } catch { return () => {} }
  }) as never

  apply(ctx, config, plur)

  return {
    ctx,
    fire: (event: string, ...args: unknown[]) =>
      Promise.all((listeners.get(event) ?? []).map(fn => fn(...args))),
    async prompt(): Promise<string> {
      const a = await ctx.systemPrompt.assemble({})
      return (a.sections as Array<{ text: string }>).map(s => s.text).join('\n')
    },
  }
}

const agent = (id: unknown = 'a1', events: unknown[] = []) =>
  ({ id, session: { events, header: { cwd: '/w' } } })

const asked = (text: string) => [
  { type: 'turn/start', time: 1, data: { turn: 1 } },
  { type: 'user/message', time: 2, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } },
]

const settle = () => new Promise(r => setTimeout(r, 30))

/**
 * Fail the test on ANY unhandled rejection.
 *
 * The refresh path is invoked with `void`, so a throw that escapes it never
 * reaches the caller — it becomes an unhandled rejection, which modern Node
 * treats as fatal. Without this hook every test below asserted only on the
 * `fire()` promise and passed while the plugin was in fact throwing: two real
 * crashes (a junk event array and a non-iterable `messages`) hid behind green
 * ticks until the runner reported them separately.
 */
let unhandled: unknown[] = []
const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
beforeEach(() => {
  unhandled = []
  process.on('unhandledRejection', onUnhandled)
})
afterEach(async () => {
  await new Promise(r => setTimeout(r, 30))
  process.off('unhandledRejection', onUnhandled)
  expect(unhandled.map(String)).toEqual([])
})

async function turn(h: Awaited<ReturnType<typeof boot>>, a: unknown, step = 1) {
  const decision = { kind: 'enter' as const, messages: [] as unknown[] }
  await h.fire('agent/pre-step', { agent: a, turn: 1, step, signal: new AbortController().signal }, async () => decision)
  await settle()
  return decision
}

describe('hostile: a malicious or broken store', () => {
  it('survives null from injectHybrid', async () => {
    const h = await boot({ injectHybrid: async () => null as never })
    await expect(turn(h, agent('a1', asked('hi there')))).resolves.toBeDefined()
    expect(await h.prompt()).not.toContain('## DIRECTIVES')
  })

  it('survives a completely wrong shape', async () => {
    const h = await boot({ injectHybrid: async () => 'not an object' as never })
    await expect(turn(h, agent('a1', asked('hi there')))).resolves.toBeDefined()
  })

  it('survives non-string directives', async () => {
    const h = await boot({ injectHybrid: async () => ({ directives: { evil: true } as never, count: 1 }) })
    await expect(turn(h, agent('a1', asked('hi there')))).resolves.toBeDefined()
  })

  it('survives a getter that throws when read', async () => {
    const hostile = { count: 1, get directives(): string { throw new Error('boom') } }
    const h = await boot({ injectHybrid: async () => hostile as never })
    await expect(turn(h, agent('a1', asked('hi there')))).resolves.toBeDefined()
  })

  it('survives a store that rejects synchronously', async () => {
    const h = await boot({ injectHybrid: (() => { throw new Error('sync') }) as never })
    await expect(turn(h, agent('a1', asked('hi there')))).resolves.toBeDefined()
  })

  it('bounds a 50MB directives payload to the configured budget', async () => {
    const huge = 'x'.repeat(50_000_000)
    const h = await boot({ injectHybrid: async () => ({ directives: huge, count: 1 }) })
    await turn(h, agent('a1', asked('hi there')))
    await turn(h, agent('a1', asked('hi there')))
    // Budget is 2000 tokens ~= 8000 chars. Anything near 50MB is a failure.
    expect((await h.prompt()).length).toBeLessThan(20_000)
  })

  it('a client missing every method degrades to no memory', async () => {
    const h = await boot({})
    await expect(turn(h, agent('a1', asked('hi there')))).resolves.toBeDefined()
    expect(await h.prompt()).not.toContain('## DIRECTIVES')
  })
})

describe('hostile: malformed agents and sessions', () => {
  it('ignores an agent with no id rather than caching under undefined', async () => {
    const injectHybrid = vi.fn(async () => ({ directives: 'x', count: 1 }))
    const h = await boot({ injectHybrid })
    await turn(h, { session: { events: asked('hi there') } })
    expect(injectHybrid).not.toHaveBeenCalled()
  })

  it('tolerates a null session', async () => {
    const h = await boot({ injectHybrid: async () => ({ directives: 'x', count: 1 }) })
    await expect(turn(h, { id: 'a1', session: null })).resolves.toBeDefined()
  })

  it('tolerates an events array full of junk', async () => {
    const junk = [null, undefined, 42, 'string', { type: 'user/message' }, { data: {} }]
    const h = await boot({ injectHybrid: async () => ({ directives: 'x', count: 1 }) })
    await expect(turn(h, agent('a1', junk))).resolves.toBeDefined()
  })

  it('a disposed agent that fires again does not resurrect stale memory', async () => {
    const h = await boot({ injectHybrid: async () => ({ directives: '[ENG-1] stale', count: 1 }) })
    const a = agent('a1', asked('hi there'))
    await turn(h, a)
    await turn(h, a)
    expect(await h.prompt()).toContain('[ENG-1] stale')
    await h.fire('agent/disposed', a)
    expect(await h.prompt()).not.toContain('[ENG-1] stale')
  })

  it('disposal of an unknown agent is a no-op, not a crash', async () => {
    const h = await boot({})
    await expect(h.fire('agent/disposed', { id: 'never-seen' })).resolves.toBeDefined()
    await expect(h.fire('agent/disposed', null)).resolves.toBeDefined()
  })
})

describe('hostile: resource exhaustion', () => {
  it('200 agents do not leak sections after disposal', async () => {
    const h = await boot({ injectHybrid: async () => ({ directives: '[ENG-1] x', count: 1 }) })
    const agents = Array.from({ length: 200 }, (_, i) => agent(`a${i}`, asked('a question')))
    for (const a of agents) await turn(h, a)
    for (const a of agents) await h.fire('agent/disposed', a)
    const assembled = await h.ctx.systemPrompt.assemble({})
    const memory = (assembled.sections as Array<{ name: string }>).filter(s => s.name === 'plur:memory')
    expect(memory).toHaveLength(0)
  })

  it('caps tracked agents even when the host never emits agent/disposed', async () => {
    // A host that drops sessions on disconnect leaks one prompt-section
    // registration per dead session forever without a ceiling.
    const h = await boot({ injectHybrid: async () => ({ directives: '[ENG-1] x', count: 1 }) })
    for (let i = 0; i < 600; i++) await turn(h, agent(`leak${i}`, asked('a question')), 1)
    const assembled = await h.ctx.systemPrompt.assemble({})
    const memory = (assembled.sections as Array<{ name: string }>).filter(s => s.name === 'plur:memory')
    expect(memory.length).toBeLessThanOrEqual(512)
  })

  it('a retry storm on one turn triggers at most one recall', async () => {
    const injectHybrid = vi.fn(async () => ({ directives: 'x', count: 1 }))
    const h = await boot({ injectHybrid }, cfg({ refreshIntervalMs: 60_000 }))
    const a = agent('a1', asked('a question'))
    for (let i = 0; i < 50; i++) await turn(h, a, 1)
    expect(injectHybrid).toHaveBeenCalledOnce()
  })

  it('concurrent writes from many sessions stay serialized', async () => {
    const queue = createWriteQueue()
    let concurrent = 0
    let peak = 0
    const write = async () => {
      concurrent++
      peak = Math.max(peak, concurrent)
      await new Promise(r => setTimeout(r, 1))
      concurrent--
    }
    await Promise.all(Array.from({ length: 40 }, () => queue(write)))
    expect(peak).toBe(1)
  })

  it('guard does not leak timers under load', async () => {
    vi.useFakeTimers()
    try {
      await Promise.all(Array.from({ length: 100 }, () => guard(async () => 1, { timeoutMs: 60_000 })))
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('hostile: content that tries to escape', () => {
  it('does not execute or interpolate template syntax in engram text', async () => {
    const nasty = '${process.env.HOME} {{variable}} `whoami`'
    const h = await boot({ injectHybrid: async () => ({ directives: nasty, count: 1 }) })
    const a = agent('a1', asked('a question'))
    await turn(h, a)
    await turn(h, a)
    // Rendered verbatim — the plugin never evaluates engram content.
    expect(await h.prompt()).toContain('${process.env.HOME}')
  })

  it('handles engram text with null bytes and control characters', async () => {
    const h = await boot({ injectHybrid: async () => ({ directives: 'a bc', count: 1 }) })
    await expect(turn(h, agent('a1', asked('a question')))).resolves.toBeDefined()
  })

  it('handles multi-byte unicode without breaking the budget maths', async () => {
    const emoji = '🧠'.repeat(5000)
    const h = await boot({ injectHybrid: async () => ({ directives: emoji, count: 1 }) })
    const a = agent('a1', asked('a question'))
    await turn(h, a)
    await turn(h, a)
    expect((await h.prompt()).length).toBeLessThan(20_000)
  })

  it('a query built from hostile user text does not throw', () => {
    const events = [
      { type: 'turn/start', time: 1, data: { turn: 1 } },
      { type: 'user/message', time: 2, data: { content: [{ type: 'text', text: ' '.repeat(1000) }], source: { kind: 'user' } } },
    ]
    expect(() => recallQueryFrom(events, 1, [])).not.toThrow()
  })

  it('renderBlock never emits a partial engram when trimming', () => {
    const out = renderBlock(
      { directives: '[ENG-1] complete statement here', constraints: '', consider: '', count: 1 },
      2,
    )
    // Too small to fit: emit nothing rather than half a statement the model
    // would read as a complete instruction.
    expect(out === '' || out.includes('complete statement here')).toBe(true)
  })
})

describe('hostile: the host misbehaving', () => {
  it('survives next() rejecting', async () => {
    const h = await boot({ injectHybrid: async () => ({ directives: 'x', count: 1 }) })
    const failing = async () => { throw new Error('an inner plugin blew up') }
    await expect(
      h.fire('agent/pre-step', { agent: agent('a1'), turn: 1, step: 1, signal: new AbortController().signal }, failing),
    ).rejects.toThrow('an inner plugin blew up')
    // The rejection is the INNER plugin's, propagated unchanged — we neither
    // swallow another plugin's failure nor add one of our own.
  })

  it('survives a decision with no messages array', async () => {
    const h = await boot({ injectHybrid: async () => ({ directives: 'x', count: 1 }) })
    const decision = { kind: 'enter' } as never
    await expect(
      h.fire('agent/pre-step', { agent: agent('a1', asked('q')), turn: 1, step: 1, signal: new AbortController().signal }, async () => decision),
    ).resolves.toBeDefined()
  })

  it('survives an absent skills/commands registry', async () => {
    const ctx = new Context() as Context & Record<string, any>
    ctx.plugin(SystemPrompt, {})
    await new Promise(r => setTimeout(r, 50))
    ctx.tools = { register: () => () => {} } as never
    // No ctx.skills, no ctx.commands — a minimal host composition.
    expect(() => apply(ctx, cfg({}))).not.toThrow()
  })
})
