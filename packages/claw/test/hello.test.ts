import { describe, it, expect } from 'vitest'
import plugin from '../src/index.js'
import { PlurContextEngine } from '../src/context-engine.js'

describe('PLUR ContextEngine plugin', () => {
  it('plugin has correct metadata', () => {
    expect(plugin.id).toBe('plur-claw')
    expect(plugin.kind).toBe('context-engine')
    expect(plugin.version).toBe('0.1.0')
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
    expect(engine).toBeInstanceOf(PlurContextEngine)
    expect(engine.info.id).toBe('plur-claw')
  })
})
