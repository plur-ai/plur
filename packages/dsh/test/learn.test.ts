import { describe, expect, it, vi } from 'vitest'
import { Config } from '../src/config.js'
import { createCounters } from '../src/counters.js'
import { detectLearning, registerLearning } from '../src/learn.js'
import { cfg } from './helpers/config.js'

const settle = () => new Promise(r => setTimeout(r, 10))

describe('detectLearning', () => {
  it('catches an explicit correction', () => {
    expect(detectLearning('No, use pnpm not npm here.')).toBeDefined()
  })

  it('catches an always/never rule', () => {
    expect(detectLearning('Always pin the dsh packages to one release line.')).toBeDefined()
  })

  it('catches a use-X-not-Y instruction', () => {
    expect(detectLearning('Use the next dist-tag not latest for dsh.')).toBeDefined()
  })

  it('ignores short chatter', () => {
    expect(detectLearning('ok')).toBeUndefined()
    expect(detectLearning('thanks!')).toBeUndefined()
  })

  it('ignores a plain question', () => {
    expect(detectLearning('What does this function do?')).toBeUndefined()
  })

  it('ignores an overlong message rather than storing a wall of text', () => {
    expect(detectLearning(`Always ${'x'.repeat(600)}`)).toBeUndefined()
  })

  it('extracts the matching sentence, not the whole message', () => {
    const found = detectLearning('Here is some preamble. Always pin the deps. And some trailing chatter.')
    expect(found?.statement).toBe('Always pin the deps.')
  })
})

function harness(plur: Record<string, unknown>, config = cfg({})) {
  const listeners: Function[] = []
  const ctx = {
    on: (event: string, fn: Function) => {
      if (event === 'session/event') listeners.push(fn)
      return () => {}
    },
  }
  registerLearning(ctx as never, {
    config,
    counters: createCounters(),
    plur: plur as never,
    queue: async <T,>(fn: () => Promise<T>) => { try { return await fn() } catch { return undefined } },
    resolveScope: async () => config.scope ?? 'project:dsh',
  })
  return (event: unknown) => Promise.all(listeners.map(fn => fn({ id: 's1' }, event)))
}

const userMessage = (text: string) => ({
  type: 'user/message',
  data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
})

describe('registerLearning', () => {
  it('learns from a user correction', async () => {
    const learn = vi.fn(async () => {})
    await harness({ learn })(userMessage('Always pin the dsh packages.'))
    await settle()
    expect(learn).toHaveBeenCalled()
  })

  it('writes to the resolved scope, never the ambient global store', async () => {
    const learn = vi.fn(async () => {})
    await harness({ learn }, cfg({ scope: 'project:acme' }))(userMessage('Always pin the deps.'))
    await settle()
    expect(learn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ scope: 'project:acme' }))
  })

  it('ignores plugin-sourced messages so it never learns from its own injection', async () => {
    const learn = vi.fn(async () => {})
    await harness({ learn })({
      type: 'user/message',
      data: { source: { kind: 'plugin', plugin: 'plur' }, content: [{ type: 'text', text: 'Always pin the deps.' }] },
    })
    await settle()
    expect(learn).not.toHaveBeenCalled()
  })

  it('ignores non-message events', async () => {
    const learn = vi.fn(async () => {})
    await harness({ learn })({ type: 'turn/start', data: { turn: 1 } })
    await settle()
    expect(learn).not.toHaveBeenCalled()
  })

  it('does nothing when autoLearn is off', async () => {
    const learn = vi.fn(async () => {})
    await harness({ learn }, cfg({ autoLearn: false }))(userMessage('Always pin the deps.'))
    await settle()
    expect(learn).not.toHaveBeenCalled()
  })

  it('a throwing store does not surface to the caller', async () => {
    const fire = harness({ learn: async () => { throw new Error('store down') } })
    await expect(fire(userMessage('Always pin the deps.'))).resolves.toBeDefined()
    await settle()
  })

  it('tolerates a malformed event without throwing', async () => {
    const fire = harness({ learn: async () => {} })
    await expect(fire({ type: 'user/message', data: null })).resolves.toBeDefined()
    await expect(fire(null)).resolves.toBeDefined()
  })
})
