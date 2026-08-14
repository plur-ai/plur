import { describe, expect, it, vi } from 'vitest'
import { Config } from '../src/config.ts'
import { apply, name } from '../src/index.ts'

/** Minimal Cordis-shaped double: records registrations and lets tests fire events. */
function makeCtx() {
  const listeners = new Map<string, Function[]>()
  const sections: any[] = []
  const tools: any[] = []
  const skills: any[] = []
  const commands: any[] = []
  const ctx: any = {
    on: (event: string, fn: Function) => {
      listeners.set(event, [...(listeners.get(event) ?? []), fn])
      return () => {}
    },
    systemPrompt: { section: (s: any) => { sections.push(s); return () => {} } },
    tools: { register: (d: any) => { tools.push(d); return () => {} } },
    skills: { register: (s: any) => { skills.push(s); return () => {} } },
    commands: { register: (c: any) => { commands.push(c); return () => {} } },
    logger: { warn: vi.fn(), info: vi.fn() },
  }
  return {
    ctx,
    sections,
    tools,
    skills,
    commands,
    listeners,
    fire: (event: string, ...args: any[]) =>
      Promise.all((listeners.get(event) ?? []).map(fn => fn(...args))),
  }
}

const agent = (id = 'a1') => ({
  id,
  session: { events: [], header: { cwd: '/w' } },
})

const preStepInput = (a = agent(), step = 1) =>
  ({ agent: a, turn: 1, step, signal: new AbortController().signal })

/** Let queued microtasks and the fire-and-forget refresh settle. */
const settle = () => new Promise(r => setTimeout(r, 10))

describe('plugin contract', () => {
  it('exports the Cordis plugin surface', () => {
    expect(name).toBe('plur')
    expect(typeof apply).toBe('function')
  })

  it('registers a pre-step listener', () => {
    const h = makeCtx()
    apply(h.ctx, new Config({}))
    expect(h.listeners.has('agent/pre-step')).toBe(true)
  })
})

describe('injection is prompt-section only', () => {
  it('NEVER appends to the pre-step decision', async () => {
    const h = makeCtx()
    apply(h.ctx, new Config({}))
    const decision = { kind: 'enter' as const, messages: [] as unknown[] }
    const [result] = await h.fire('agent/pre-step', preStepInput(), async () => decision)
    expect(result).toBe(decision)
    expect(result.messages).toHaveLength(0)
  })

  it('registers the plur:memory section once per agent', async () => {
    const h = makeCtx()
    apply(h.ctx, new Config({}))
    const a = agent()
    const next = async () => ({ kind: 'enter' as const, messages: [] })
    await h.fire('agent/pre-step', preStepInput(a, 1), next)
    await h.fire('agent/pre-step', preStepInput(a, 2), next)
    expect(h.sections.filter(s => s.name === 'plur:memory')).toHaveLength(1)
  })

  it('the section text provider is synchronous and returns a string', async () => {
    const h = makeCtx()
    apply(h.ctx, new Config({}))
    await h.fire('agent/pre-step', preStepInput(), async () => ({ kind: 'enter', messages: [] }))
    const section = h.sections.find(s => s.name === 'plur:memory')!
    expect(typeof section.text()).toBe('string')
  })

  it('orders the section after the persona', async () => {
    const h = makeCtx()
    apply(h.ctx, new Config({}))
    await h.fire('agent/pre-step', preStepInput(), async () => ({ kind: 'enter', messages: [] }))
    expect(h.sections.find(s => s.name === 'plur:memory')!.order).toBeGreaterThan(0)
  })

  it('does not register the section when injectionMode is off', async () => {
    const h = makeCtx()
    apply(h.ctx, new Config({ injectionMode: 'off' }))
    await h.fire('agent/pre-step', preStepInput(), async () => ({ kind: 'enter', messages: [] }))
    expect(h.sections).toHaveLength(0)
  })

  it('renders recalled engrams into the section on the next turn', async () => {
    const h = makeCtx()
    const plur = { recall: async () => [{ id: 'ENG-1', statement: 'Pin your deps.', confidence: 0.9 }] }
    apply(h.ctx, new Config({}), plur)
    const a = agent()
    a.session.events = [
      { type: 'turn/start', time: 1, data: { turn: 1 } },
      { type: 'user/message', time: 2, data: { content: [{ type: 'text', text: 'how do I install?' }], source: { kind: 'user' } } },
    ] as never
    await h.fire('agent/pre-step', preStepInput(a, 1), async () => ({ kind: 'enter', messages: [] }))
    await settle()
    expect(h.sections.find(s => s.name === 'plur:memory')!.text()).toContain('[ENG-1] Pin your deps.')
  })
})

describe('failure discipline', () => {
  it('returns the delegated decision unchanged when it is a reject', async () => {
    const h = makeCtx()
    apply(h.ctx, new Config({}))
    const decision = { kind: 'reject' as const }
    const [result] = await h.fire('agent/pre-step', preStepInput(), async () => decision)
    expect(result).toBe(decision)
  })

  it('returns the delegated decision even when recall throws', async () => {
    const h = makeCtx()
    apply(h.ctx, new Config({}), { recall: async () => { throw new Error('plur down') } })
    const decision = { kind: 'enter' as const, messages: [] }
    const [result] = await h.fire('agent/pre-step', preStepInput(), async () => decision)
    await settle()
    expect(result).toBe(decision)
  })

  it('does not reject when recall throws — the turn must survive', async () => {
    const h = makeCtx()
    apply(h.ctx, new Config({}), { recall: async () => { throw new Error('plur down') } })
    const a = agent()
    a.session.events = [
      { type: 'turn/start', time: 1, data: { turn: 1 } },
      { type: 'user/message', time: 2, data: { content: [{ type: 'text', text: 'hello there' }], source: { kind: 'user' } } },
    ] as never
    await expect(
      h.fire('agent/pre-step', preStepInput(a, 1), async () => ({ kind: 'enter', messages: [] })),
    ).resolves.toBeDefined()
    await settle()
    expect(h.sections.find(s => s.name === 'plur:memory')!.text()).toBe('')
  })

  it('survives a host whose systemPrompt.section throws', async () => {
    const h = makeCtx()
    h.ctx.systemPrompt.section = () => { throw new Error('host api changed') }
    apply(h.ctx, new Config({}))
    const decision = { kind: 'enter' as const, messages: [] }
    const [result] = await h.fire('agent/pre-step', preStepInput(), async () => decision)
    expect(result).toBe(decision)
  })

  it('skips work when the signal is already aborted', async () => {
    const h = makeCtx()
    const recall = vi.fn(async () => [])
    apply(h.ctx, new Config({}), { recall })
    const controller = new AbortController()
    controller.abort()
    const decision = { kind: 'enter' as const, messages: [] }
    const [result] = await h.fire(
      'agent/pre-step',
      { agent: agent(), turn: 1, step: 1, signal: controller.signal },
      async () => decision,
    )
    await settle()
    expect(result).toBe(decision)
    expect(recall).not.toHaveBeenCalled()
  })
})

describe('registrations', () => {
  it('registers exactly five model-facing tools', () => {
    const h = makeCtx()
    apply(h.ctx, new Config({}))
    expect(h.tools.map(t => t.name).sort()).toEqual(
      ['plur_feedback', 'plur_forget', 'plur_learn', 'plur_recall', 'plur_status'],
    )
  })

  it('registers the plur-memory skill and the /plur command', () => {
    const h = makeCtx()
    apply(h.ctx, new Config({}))
    expect(h.skills.map(s => s.name)).toContain('plur-memory')
    expect(h.commands.map(c => c.name)).toContain('plur')
  })

  it('clears cached state when an agent is disposed', async () => {
    const h = makeCtx()
    const plur = { recall: async () => [{ id: 'ENG-1', statement: 'Remembered.', confidence: 0.9 }] }
    apply(h.ctx, new Config({}), plur)
    const a = agent()
    a.session.events = [
      { type: 'turn/start', time: 1, data: { turn: 1 } },
      { type: 'user/message', time: 2, data: { content: [{ type: 'text', text: 'a real question' }], source: { kind: 'user' } } },
    ] as never
    await h.fire('agent/pre-step', preStepInput(a, 1), async () => ({ kind: 'enter', messages: [] }))
    await settle()
    const section = h.sections.find(s => s.name === 'plur:memory')!
    expect(section.text()).not.toBe('')
    await h.fire('agent/disposed', a)
    expect(section.text()).toBe('')
  })
})
