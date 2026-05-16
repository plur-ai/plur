import { describe, it, expect } from 'vitest'
import plugin from '../src/index.js'

type EventHandler = (event: any, ctx: any) => any

function makeApi(path: string) {
  const handlers: Record<string, EventHandler[]> = {}
  const api = {
    pluginConfig: { path },
    config: { agents: { defaults: { workspace: '/tmp/plur-canary-workspace' } } },
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    registerContextEngine: () => {},
    on: (event: string, handler: EventHandler) => {
      if (!handlers[event]) handlers[event] = []
      handlers[event].push(handler)
    },
    registerCommand: () => {},
    registerCli: () => {},
    registerService: () => {},
    fire: (event: string, eventData: any = {}) =>
      (handlers[event] ?? []).map((h) => h(eventData, {})),
  }
  return api
}

describe('claw canary wiring', () => {
  it('no warning before threshold is reached', () => {
    const api = makeApi('/tmp/plur-canary-a')
    plugin.register(api as any)
    const [result1] = api.fire('before_agent_start', { prompt: 'task one' })
    const [result2] = api.fire('before_agent_start', { prompt: 'task two' })
    expect(result1?.prependContext ?? '').not.toContain('⚠️')
    expect(result2?.prependContext ?? '').not.toContain('⚠️')
  })

  it('injects warning after threshold ticks with no agent_end', () => {
    const api = makeApi('/tmp/plur-canary-b')
    plugin.register(api as any)
    api.fire('before_agent_start', { prompt: 'turn 1' })
    api.fire('before_agent_start', { prompt: 'turn 2' })
    const [result] = api.fire('before_agent_start', { prompt: 'turn 3' })
    expect(result?.prependContext).toContain('⚠️')
    expect(result?.prependContext).toContain('agent_end')
  })

  it('no warning when agent_end fires normally', () => {
    const api = makeApi('/tmp/plur-canary-c')
    plugin.register(api as any)
    api.fire('before_agent_start', { prompt: 'turn 1' })
    api.fire('agent_end', { messages: [] })
    api.fire('before_agent_start', { prompt: 'turn 2' })
    api.fire('agent_end', { messages: [] })
    const [result] = api.fire('before_agent_start', { prompt: 'turn 3' })
    expect(result?.prependContext ?? '').not.toContain('⚠️')
  })

  it('warning clears after agent_end fires (hot-reload recovery)', () => {
    const api = makeApi('/tmp/plur-canary-d')
    plugin.register(api as any)
    // 3 turns with no agent_end — warning fires
    api.fire('before_agent_start', { prompt: 'turn 1' })
    api.fire('before_agent_start', { prompt: 'turn 2' })
    const [warned] = api.fire('before_agent_start', { prompt: 'turn 3' })
    expect(warned?.prependContext).toContain('⚠️')
    // agent_end fires — canary recovers
    api.fire('agent_end', { messages: [] })
    const [cleared] = api.fire('before_agent_start', { prompt: 'turn 4' })
    expect(cleared?.prependContext ?? '').not.toContain('⚠️')
  })

  it('warning includes the fix command', () => {
    const api = makeApi('/tmp/plur-canary-e')
    plugin.register(api as any)
    api.fire('before_agent_start', { prompt: 'turn 1' })
    api.fire('before_agent_start', { prompt: 'turn 2' })
    const [result] = api.fire('before_agent_start', { prompt: 'turn 3' })
    expect(result?.prependContext).toContain('allowConversationAccess')
  })
})
