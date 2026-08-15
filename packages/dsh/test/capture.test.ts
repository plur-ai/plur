import { describe, expect, it, vi } from 'vitest'
import { registerCapture } from '../src/capture.js'
import { Config } from '../src/config.js'
import { createCounters } from '../src/counters.js'
import { cfg } from './helpers/config.js'

const settle = () => new Promise(r => setTimeout(r, 10))

function harness(plur: Record<string, unknown>, config = cfg({})) {
  const listeners = new Map<string, Function[]>()
  const ctx = {
    on: (event: string, fn: Function) => {
      listeners.set(event, [...(listeners.get(event) ?? []), fn])
      return () => {}
    },
  }
  registerCapture(ctx as never, {
    config,
    counters: createCounters(),
    plur: plur as never,
    queue: async <T,>(fn: () => Promise<T>) => { try { return await fn() } catch { return undefined } },
    resolveScope: async () => config.scope ?? 'project:dsh',
  })
  return {
    fire: (event: string, ...args: unknown[]) =>
      Promise.all((listeners.get(event) ?? []).map(fn => fn(...args))),
    listeners,
  }
}

const assistant = (text: string) => ({
  type: 'assistant/message',
  time: 1,
  data: { message: { content: [{ type: 'text', text }] } },
})

describe('registerCapture — episode capture', () => {
  it('captures the last assistant message at turn end', async () => {
    const capture = vi.fn(async () => {})
    const h = harness({ capture })
    await h.fire('agent/turn-stopping', { session: { events: [assistant('the answer')] } })
    await settle()
    expect(capture).toHaveBeenCalledWith('the answer', expect.any(Object))
  })

  it('records the resolved scope as a tag — core has no scoped timeline', async () => {
    // This asserted `{ scope }` for months. Core's CaptureContext has no such
    // field, so every episode was written with the scope silently discarded;
    // nothing caught it because the package was never typechecked. Core keeps
    // one timeline per store, so a tag is the only place the scope survives.
    const capture = vi.fn(async (_summary: string, _context?: unknown) => {})
    const h = harness({ capture }, cfg({ scope: 'project:acme' }))
    await h.fire('agent/turn-stopping', { session: { events: [assistant('x')] } })
    await settle()
    expect(capture).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tags: ['scope:project:acme'] }),
    )
    expect(capture.mock.calls[0]![1]).not.toHaveProperty('scope')
  })

  it('truncates a very long summary rather than bloating the store', async () => {
    const capture = vi.fn(async (_summary: string, _context?: unknown) => {})
    const h = harness({ capture })
    await h.fire('agent/turn-stopping', { session: { events: [assistant('y'.repeat(5000))] } })
    await settle()
    expect(capture.mock.calls[0]![0].length).toBe(2000)
  })

  it('captures nothing when the turn produced no assistant text', async () => {
    const capture = vi.fn(async () => {})
    const h = harness({ capture })
    await h.fire('agent/turn-stopping', { session: { events: [] } })
    await settle()
    expect(capture).not.toHaveBeenCalled()
  })

  it('does nothing when autoCapture is off', async () => {
    const capture = vi.fn(async () => {})
    const h = harness({ capture }, cfg({ autoCapture: false }))
    expect(h.listeners.size).toBe(0)
  })

  it('a throwing store does not surface to the caller', async () => {
    const h = harness({ capture: async () => { throw new Error('down') } })
    await expect(
      h.fire('agent/turn-stopping', { session: { events: [assistant('x')] } }),
    ).resolves.toBeDefined()
    await settle()
  })
})

describe('registerCapture — learn before compaction', () => {
  it('subscribes compaction/start via session/event, not as a Cordis event', () => {
    const h = harness({ ingest: async () => [{ statement: 'Use pnpm, never npm.' }], learn: async () => ({ id: 'x' }) })
    // compaction/start is a SessionEventMap entry; ctx.on('compaction/start') would never fire.
    expect(h.listeners.has('compaction/start')).toBe(false)
    expect(h.listeners.has('session/event')).toBe(true)
  })

  it('extracts learnings from the range about to be shadowed', async () => {
    // The whole point: this range is about to be summarised away, so anything
    // worth keeping has to be turned into an engram BEFORE it goes.
    const learn = vi.fn(async () => ({ id: 'x' }))
    const ingest = vi.fn(async () => [{ statement: 'Use pnpm, never npm.' }])
    const h = harness({ ingest, learn }, cfg({ scope: 'project:acme' }))
    const session = { events: [assistant('about to be summarised')] }
    await h.fire('session/event', session, { type: 'compaction/start' })
    await settle()
    // ingest() receives the conversation text...
    expect(ingest).toHaveBeenCalledWith(
      expect.stringContaining('about to be summarised'),
      expect.objectContaining({ source: 'dsh:compaction' }),
    )
    // ...and each candidate it returns is actually written, into the session's
    // own scope. Before this, the compaction hook called a core method that
    // does not exist, so nothing was ever learned here.
    expect(learn).toHaveBeenCalledWith('Use pnpm, never npm.',
      expect.objectContaining({ scope: 'project:acme', source: 'dsh:compaction' }))
  })

  it('writes nothing when the range yields no candidates', async () => {
    const learn = vi.fn(async () => ({ id: 'x' }))
    const h = harness({ ingest: async () => [], learn })
    await h.fire('session/event', { events: [assistant('nothing quotable')] }, { type: 'compaction/start' })
    await settle()
    expect(learn).not.toHaveBeenCalled()
  })

  it('bounds how much one compaction can write', async () => {
    // A long session can yield a great many candidates, and a compaction
    // boundary is exactly when nobody is watching.
    const learn = vi.fn(async () => ({ id: 'x' }))
    const many = Array.from({ length: 50 }, (_, i) => ({ statement: `candidate ${i}` }))
    const h = harness({ ingest: async () => many, learn })
    await h.fire('session/event', { events: [assistant('long session')] }, { type: 'compaction/start' })
    await settle()
    expect(learn.mock.calls.length).toBeLessThanOrEqual(12)
    expect(learn.mock.calls.length).toBeGreaterThan(0)
  })

  it('skips a range with no conversation text at all', async () => {
    const ingest = vi.fn(async () => [])
    const h = harness({ ingest })
    await h.fire('session/event', { events: [{ type: 'tool/call', time: 1, data: {} }] }, { type: 'compaction/start' })
    await settle()
    expect(ingest).not.toHaveBeenCalled()
  })

  it('ignores other session events', async () => {
    const learn = vi.fn(async () => ({ id: 'x' }))
    const ingest = vi.fn(async () => [{ statement: 'Use pnpm, never npm.' }])
    const h = harness({ ingest, learn })
    await h.fire('session/event', { events: [] }, { type: 'turn/start' })
    await settle()
    expect(ingest).not.toHaveBeenCalled()
  })

  it('tolerates a malformed event', async () => {
    const h = harness({ ingest: async () => [{ statement: 'Use pnpm, never npm.' }], learn: async () => ({ id: 'x' }) })
    await expect(h.fire('session/event', null, null)).resolves.toBeDefined()
  })
})
