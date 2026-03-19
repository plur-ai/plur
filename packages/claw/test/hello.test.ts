import { describe, it, expect } from 'vitest'
import plugin, { PlurHelloEngine } from '../src/index.js'

describe('PLUR ContextEngine — hello world', () => {
  it('plugin has correct metadata', () => {
    expect(plugin.id).toBe('plur-claw')
    expect(plugin.kind).toBe('context-engine')
  })

  it('registers via plugin API', () => {
    let registeredId: string | undefined
    let registeredFactory: (() => any) | undefined
    const mockApi = {
      registerContextEngine: (id: string, factory: () => any) => {
        registeredId = id
        registeredFactory = factory
      },
    }
    plugin.register(mockApi as any)
    expect(registeredId).toBe('plur-claw')
    expect(registeredFactory).toBeDefined()

    const engine = registeredFactory!()
    expect(engine).toBeInstanceOf(PlurHelloEngine)
  })

  it('bootstrap returns success', async () => {
    const engine = new PlurHelloEngine()
    const result = await engine.bootstrap({ sessionId: 'test-1', sessionFile: '/tmp/test' })
    expect(result.bootstrapped).toBe(true)
  })

  it('ingest processes messages', async () => {
    const engine = new PlurHelloEngine()
    const result = await engine.ingest({
      sessionId: 'test-1',
      message: { role: 'user', content: 'Hello world' },
    })
    expect(result.ingested).toBe(true)
  })

  it('assemble returns messages with systemPromptAddition', async () => {
    const engine = new PlurHelloEngine()
    const result = await engine.assemble({
      sessionId: 'test-1',
      messages: [{ role: 'user', content: 'test' }],
      tokenBudget: 4000,
    })
    expect(result.messages).toHaveLength(1)
    expect(result.estimatedTokens).toBeGreaterThan(0)
    expect(result.systemPromptAddition).toContain('PLUR')
  })

  it('compact returns ok', async () => {
    const engine = new PlurHelloEngine()
    const result = await engine.compact({
      sessionId: 'test-1',
      sessionFile: '/tmp/test',
    })
    expect(result.ok).toBe(true)
    expect(result.compacted).toBe(false)
  })

  it('info is correct', () => {
    const engine = new PlurHelloEngine()
    expect(engine.info.id).toBe('plur-claw')
    expect(engine.info.name).toBe('PLUR Memory Engine')
    expect(engine.info.ownsCompaction).toBe(false)
  })
})
