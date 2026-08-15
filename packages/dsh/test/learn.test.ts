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

describe('auto-learn precision — these fire unattended and write permanently', () => {
  // Every string below became a stored engram before the patterns were
  // tightened. They are ordinary conversation, not corrections.
  const chatter = [
    'I never got the confirmation email from them.',
    'Actually I think we already shipped that last week.',
    'It always takes forever to build on this machine.',
    'Hmm, actually never mind, ignore that.',
    // Sentence-initial by construction, so the anchor alone cannot reject it.
    "Never mind that, let's move on to the next item.",
    "I'm not sure — the client never replied about the invoice.",
  ]
  for (const text of chatter) {
    it(`does not learn from: ${text}`, () => {
      expect(detectLearning(text)).toBeUndefined()
    })
  }

  // And these must still be caught, or the tightening went too far.
  const real = [
    'Always use pnpm in this project.',
    'Never commit secrets to the repo.',
    'We never deploy on Fridays.',
    'You should always run the migration first.',
    'No, use the staging bucket for that.',
    'Correction, the endpoint is /v2/search not /v1/search.',
  ]
  for (const text of real) {
    it(`still learns from: ${text}`, () => {
      expect(detectLearning(text), text).toBeDefined()
    })
  }

  it('finds a correction buried in a long turn, and stores only that sentence', () => {
    // The length gate used to reject the whole MESSAGE before the sentence
    // loop ran, so a real correction inside a long turn vanished with no
    // counter bumped — the "I told it and it forgot" report, undiagnosable.
    const long = `${'Some context about the deploy pipeline. '.repeat(14)}No, use pnpm rather than npm here.`
    expect(long.length).toBeGreaterThan(500)
    const found = detectLearning(long)
    expect(found, 'a long turn swallowed the correction').toBeDefined()
    expect(found!.statement).toBe('No, use pnpm rather than npm here.')
    expect(found!.statement.length).toBeLessThan(100)
  })

  it('still refuses a single sentence that is a wall of text', () => {
    expect(detectLearning(`Always ${'x'.repeat(600)}`)).toBeUndefined()
  })
})

