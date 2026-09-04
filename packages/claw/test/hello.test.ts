import { describe, it, expect } from 'vitest'
import plugin from '../src/index.js'
import { PlurContextEngine } from '../src/context-engine.js'

describe('PLUR ContextEngine plugin', () => {
  it('plugin has correct metadata', () => {
    expect(plugin.id).toBe('plur-claw')
    expect(plugin.kind).toBe('memory')
    expect(plugin.version).toBe('0.17.1')
  })

  it('registers via plugin API', async () => {
    let registeredId: string | undefined
    let registeredFactory: (() => any) | undefined
    const mockApi = {
      pluginConfig: { path: '/tmp/plur-hello-test' },
      config: { agents: { defaults: { workspace: '/tmp/plur-hello-workspace' } } },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerContextEngine: (id: string, factory: () => any) => {
        registeredId = id
        registeredFactory = factory
      },
      on: () => {},
      registerCommand: () => {},
      registerCli: () => {},
      registerService: () => {},
    }
    plugin.register(mockApi as any)
    expect(registeredId).toBe('plur')
    expect(registeredFactory).toBeDefined()

    // The factory is async now — engine construction reaches core's async
    // store path — so the plugin API hands back a promise for the engine.
    const engine = await registeredFactory!()
    expect(engine).toBeInstanceOf(PlurContextEngine)
    expect(engine.info.id).toBe('plur-claw')
  })
})
