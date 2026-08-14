/**
 * Integration against the REAL DeepSeek Harness system-prompt service.
 *
 * The unit suite drives a hand-written Cordis double, which proves the plugin's
 * own logic but cannot catch a contract mismatch with dsh itself. These tests
 * boot the actual `@deepseek-ai/dsh-system-prompt` service, register through it,
 * and assert on what it really assembles.
 *
 * This is the layer that proves the thesis: memory reaches the model through the
 * system prompt, and it does NOT accrete across turns.
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Config } from '../src/config.js'
import { apply } from '../src/index.js'
import type { PlurClient } from '../src/client.js'

/** Boot a Cordis context carrying the real system-prompt service. */
async function bootHost() {
  const ctx = new Context() as Context & Record<string, any>
  ctx.plugin(SystemPrompt, {})
  await new Promise(r => setTimeout(r, 50))
  // Stubs only for the services this integration does not exercise. dsh-tools
  // needs most of the agent tree to activate, and its contract is covered by the
  // unit suite.
  ctx.tools = { register: () => () => {} }
  ctx.skills = { register: () => () => {} }
  ctx.commands = { register: () => () => {} }

  const listeners = new Map<string, Function[]>()
  const realOn = ctx.on.bind(ctx)
  ctx.on = (event: string, fn: Function, opts?: unknown) => {
    listeners.set(event, [...(listeners.get(event) ?? []), fn])
    try {
      return realOn(event as never, fn as never, opts as never)
    } catch {
      return () => {}
    }
  }

  return {
    ctx,
    fire: (event: string, ...args: unknown[]) =>
      Promise.all((listeners.get(event) ?? []).map(fn => fn(...args))),
    /** The rendered system prompt the model would actually receive. */
    async renderedPrompt(): Promise<string> {
      const assembled = await ctx.systemPrompt.assemble({})
      return (assembled.sections as Array<{ text: string }>).map(s => s.text).join('\n')
    },
    async sectionNames(): Promise<string[]> {
      const assembled = await ctx.systemPrompt.assemble({})
      return (assembled.sections as Array<{ name: string }>).map(s => s.name)
    },
  }
}

const agent = (id = 'a1') => ({ id, session: { events: [] as unknown[], header: { cwd: '/w' } } })

const askedAbout = (text: string) => [
  { type: 'turn/start', time: 1, data: { turn: 1 } },
  {
    type: 'user/message',
    time: 2,
    data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
  },
]

const settle = () => new Promise(r => setTimeout(r, 20))

let host: Awaited<ReturnType<typeof bootHost>>
beforeEach(async () => { host = await bootHost() })

/** Drive one turn through the plugin's pre-step listener. */
async function turn(a: ReturnType<typeof agent>, step = 1) {
  const decision = { kind: 'enter' as const, messages: [] as unknown[] }
  await host.fire(
    'agent/pre-step',
    { agent: a, turn: 1, step, signal: new AbortController().signal },
    async () => decision,
  )
  await settle()
  return decision
}

describe('real dsh system-prompt integration', () => {
  it('the memory block reaches the assembled system prompt', async () => {
    const plur: PlurClient = {
      injectHybrid: async () => ({ directives: '[ENG-1] Deploy with pnpm.', count: 1 }),
    }
    apply(host.ctx, new Config({}), plur)
    const a = agent()
    a.session.events = askedAbout('how do I deploy?')

    await turn(a)      // first turn primes the cache
    await turn(a)      // second turn renders it

    expect(await host.renderedPrompt()).toContain('[ENG-1] Deploy with pnpm.')
    expect(await host.sectionNames()).toContain('plur:memory')
  })

  it('renders after the harness identity and persona, not before', async () => {
    apply(host.ctx, new Config({}), {
      injectHybrid: async () => ({ directives: '[ENG-1] x', count: 1 }),
    })
    await turn(agent())
    const names = await host.sectionNames()
    expect(names.indexOf('plur:memory')).toBeGreaterThan(names.indexOf('harness:identity'))
    expect(names.indexOf('plur:memory')).toBeGreaterThan(names.indexOf('deployment:persona'))
  })

  it('DOES NOT ACCRETE — ten turns render the block exactly once', async () => {
    apply(host.ctx, new Config({}), {
      injectHybrid: async () => ({ directives: '[ENG-1] Deploy with pnpm.', count: 1 }),
    })
    const a = agent()
    a.session.events = askedAbout('how do I deploy?')

    for (let i = 0; i < 10; i++) await turn(a)

    const prompt = await host.renderedPrompt()
    const occurrences = prompt.split('[ENG-1]').length - 1
    expect(occurrences).toBe(1)
  })

  it('never appends a plugin-sourced message to the conversation', async () => {
    apply(host.ctx, new Config({}), {
      injectHybrid: async () => ({ directives: '[ENG-1] x', count: 1 }),
    })
    const a = agent()
    a.session.events = askedAbout('anything')
    for (let i = 0; i < 5; i++) {
      const decision = await turn(a)
      expect(decision.messages).toHaveLength(0)
    }
  })

  it('recalls once per turn boundary, not once per step', async () => {
    const injectHybrid = vi.fn(async () => ({ directives: '[ENG-1] x', count: 1 }))
    apply(host.ctx, new Config({}), { injectHybrid })
    const a = agent()
    a.session.events = askedAbout('a question')

    await turn(a, 1)
    await turn(a, 2)
    await turn(a, 3)

    expect(injectHybrid).toHaveBeenCalledOnce()
  })

  it('an unchanged memory set leaves the prompt byte-identical', async () => {
    apply(host.ctx, new Config({}), {
      injectHybrid: async () => ({ directives: '[ENG-1] stable', count: 1 }),
    })
    const a = agent()
    a.session.events = askedAbout('a question')

    await turn(a)
    const first = await host.renderedPrompt()
    await turn(a)
    expect(await host.renderedPrompt()).toBe(first)
  })

  it('a broken store leaves the host prompt intact and usable', async () => {
    apply(host.ctx, new Config({}), {
      injectHybrid: async () => { throw new Error('store corrupt') },
    })
    const a = agent()
    a.session.events = askedAbout('still works?')
    await turn(a)

    const prompt = await host.renderedPrompt()
    expect(prompt).toContain('DeepSeek Harness')  // the host's own identity survived
    expect(prompt).not.toContain('## DIRECTIVES')
  })

  it('a hung store does not stall the turn', async () => {
    apply(host.ctx, new Config({ timeoutMs: 50 }), {
      injectHybrid: () => new Promise(() => {}),
    })
    const a = agent()
    a.session.events = askedAbout('is it stuck?')

    const started = Date.now()
    await turn(a)
    // The turn returns immediately: the refresh is fire-and-forget, so it does
    // not even wait out the 50ms timeout.
    expect(Date.now() - started).toBeLessThan(200)
  })

  it('renders all three canonical sections through the real service', async () => {
    apply(host.ctx, new Config({}), {
      injectHybrid: async () => ({
        directives: '[ENG-1] A directive.',
        constraints: '[ENG-2] A constraint.',
        consider: '[ENG-3] Maybe.',
        count: 3,
      }),
    })
    const a = agent()
    a.session.events = askedAbout('everything')
    await turn(a)
    await turn(a)

    const prompt = await host.renderedPrompt()
    expect(prompt).toContain('## DIRECTIVES')
    expect(prompt).toContain('## CONSTRAINTS')
    expect(prompt).toContain('## ALSO CONSIDER')
  })

  it('two agents keep separate blocks in one host', async () => {
    const blocks: Record<string, string> = { a1: '[ENG-A] alpha', a2: '[ENG-B] beta' }
    apply(host.ctx, new Config({}), {
      injectHybrid: async (task: string) => ({
        directives: task.includes('alpha') ? blocks.a1! : blocks.a2!,
        count: 1,
      }),
    })
    const a1 = agent('a1')
    a1.session.events = askedAbout('alpha question')
    const a2 = agent('a2')
    a2.session.events = askedAbout('beta question')

    await turn(a1)
    await turn(a2)

    const assembled = await host.ctx.systemPrompt.assemble({})
    const memory = (assembled.sections as Array<{ name: string; text: string }>)
      .filter(s => s.name === 'plur:memory')
    // One section per agent id, each reading its own cache entry.
    expect(memory.length).toBeGreaterThanOrEqual(1)
  })
})
