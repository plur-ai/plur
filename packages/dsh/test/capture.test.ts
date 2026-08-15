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
    await h.fire('agent/turn-stopping', { agent: { id: 'a', session: { events: [assistant('the answer')] } } })
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
    await h.fire('agent/turn-stopping', { agent: { id: 'a', session: { events: [assistant('x')] } } })
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
    await h.fire('agent/turn-stopping', { agent: { id: 'a', session: { events: [assistant('y'.repeat(5000))] } } })
    await settle()
    expect(capture.mock.calls[0]![0].length).toBe(2000)
  })

  it('captures nothing when the turn produced no assistant text', async () => {
    const capture = vi.fn(async () => {})
    const h = harness({ capture })
    await h.fire('agent/turn-stopping', { agent: { id: 'a', session: { events: [] } } })
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
      h.fire('agent/turn-stopping', { agent: { id: 'a', session: { events: [assistant('x')] } } }),
    ).resolves.toBeDefined()
    await settle()
  })
})

describe('registerCapture — compaction writes NOTHING', () => {
  // 0.1.0 deliberately has no learn-before-compaction. The previous version
  // called a `compactLearn()` core has never implemented (a no-op), and the
  // version after that called `ingest()` — which WRITES unless `extract_only`
  // is passed, defaulting the scope to `global`. That put one project's
  // conversation into the store every other project reads from, with core's
  // patterns dropping negations along the way: "Never mention that Acme is
  // churning" is stored as "mention that Acme is churning".
  //
  // These tests exist so re-adding it is a deliberate act, not an accident.

  it('subscribes to session/event for nothing — no store call on compaction', async () => {
    const calls: string[] = []
    const spy = new Proxy({}, {
      get: (_t, name: string) => { calls.push(name); return async () => undefined },
    }) as Record<string, unknown>
    const h = harness(spy)
    await h.fire('session/event', { events: [assistant('private client detail')] }, { type: 'compaction/start' })
    await settle()
    expect(calls.filter(c => c !== 'then'), 'compaction reached the store').toEqual([])
  })

  it('never calls ingest — it writes to global unless extract_only is passed', async () => {
    const ingest = vi.fn(async () => [])
    const h = harness({ ingest })
    await h.fire('session/event', { events: [assistant('x')] }, { type: 'compaction/start' })
    await settle()
    expect(ingest).not.toHaveBeenCalled()
  })
})
