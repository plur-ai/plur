import { describe, expect, it, vi } from 'vitest'
import { createViewer } from '../src/viewer.js'
import { registerCommands } from '../src/commands.js'
import { createCounters } from '../src/counters.js'
import { Config } from '../src/config.js'
import type { Context } from '@deepseek-ai/cordis'
import type { PlurClient } from '../src/client.js'
import { cfg } from './helpers/config.js'

/** A viewer start that records its calls instead of binding a port. */
function fakeStart() {
  const close = vi.fn(async () => {})
  // Typed parameters, so `mock.calls[0][0]` is the options object rather than
  // an empty tuple TypeScript refuses to index.
  const start = vi.fn(async (_opts: {
    load: () => Promise<readonly unknown[]>
    where: string
    openPath?: string
    port?: number
  }) => ({ url: 'http://127.0.0.1:41234/', close }))
  return { start, close }
}

const PLUR: PlurClient = {
  list: async () => [{ id: 'ENG-2026-0814-001', statement: 'x' }],
  status: async () => ({ storage_root: '/tmp/store', engram_count: 1 }),
}

describe('createViewer', () => {
  it('starts on first open and returns the URL', async () => {
    const { start } = fakeStart()
    const viewer = createViewer(PLUR, { startViewer: start })
    expect(await viewer.open()).toBe('http://127.0.0.1:41234/')
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('reuses the running server instead of leaking a second one', async () => {
    const { start } = fakeStart()
    const viewer = createViewer(PLUR, { startViewer: start })
    const urls = [await viewer.open(), await viewer.open(), await viewer.open()]
    expect(new Set(urls).size).toBe(1)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('does not race two servers when opened concurrently', async () => {
    const { start } = fakeStart()
    const viewer = createViewer(PLUR, { startViewer: start })
    await Promise.all([viewer.open(), viewer.open(), viewer.open()])
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('closes the server on dispose', async () => {
    const { start, close } = fakeStart()
    const viewer = createViewer(PLUR, { startViewer: start })
    await viewer.open()
    await viewer.dispose()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('disposes without a running server', async () => {
    const { start, close } = fakeStart()
    const viewer = createViewer(PLUR, { startViewer: start })
    await expect(viewer.dispose()).resolves.toBeUndefined()
    expect(start).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('starts again after a dispose rather than handing back a dead URL', async () => {
    const { start } = fakeStart()
    const viewer = createViewer(PLUR, { startViewer: start })
    await viewer.open()
    await viewer.dispose()
    await viewer.open()
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('reads the store path from status and passes it as the reveal target', async () => {
    const { start } = fakeStart()
    await createViewer(PLUR, { startViewer: start }).open()
    expect(start.mock.calls[0]![0]).toMatchObject({ where: '/tmp/store', openPath: '/tmp/store' })
  })

  it('still serves when status is broken — a diagnostic must not block reading memory', async () => {
    const { start } = fakeStart()
    const broken: PlurClient = { ...PLUR, status: async () => { throw new Error('corrupt') } }
    await createViewer(broken, { startViewer: start }).open()
    expect(start.mock.calls[0]![0].where).toBe('')
    // No path resolved means no reveal button rather than a reveal of ''.
    expect(start.mock.calls[0]![0].openPath).toBeUndefined()
  })

  it('surfaces a missing engine as an error, not a crash', async () => {
    const viewer = createViewer(undefined, { startViewer: fakeStart().start })
    await expect(viewer.open()).rejects.toThrow(/not installed/i)
  })

  it('recovers from a failed start instead of caching the failure forever', async () => {
    let attempt = 0
    const start = vi.fn(async (_opts: unknown) => {
      if (++attempt === 1) throw new Error('EADDRINUSE')
      return { url: 'http://127.0.0.1:41235/', close: async () => {} }
    })
    const viewer = createViewer(PLUR, { startViewer: start })
    await expect(viewer.open()).rejects.toThrow('EADDRINUSE')
    expect(await viewer.open()).toBe('http://127.0.0.1:41235/')
  })

  it('serves whatever list returns, and an empty store is not an error', async () => {
    const { start } = fakeStart()
    const empty: PlurClient = { ...PLUR, list: undefined }
    await createViewer(empty, { startViewer: start }).open()
    await expect(start.mock.calls[0]![0].load()).resolves.toEqual([])
  })
})

describe('the /plur-memory command', () => {
  /** A minimal command registry standing in for the host's. */
  function hostWith() {
    const registered: Array<{ name: string; description: string; execute: () => unknown }> = []
    const ctx = {
      commands: { register: (c: never) => { registered.push(c); return () => {} } },
    } as unknown as Context
    return { ctx, registered }
  }

  const deps = () => ({ config: cfg({}), counters: createCounters() })

  it('registers alongside /plur rather than replacing it', () => {
    const { ctx, registered } = hostWith()
    registerCommands(ctx, { ...deps(), viewer: createViewer(PLUR, { startViewer: fakeStart().start }) })
    expect(registered.map(c => c.name).sort()).toEqual(['plur', 'plur-memory'])
  })

  it('returns the viewer URL', async () => {
    const { ctx, registered } = hostWith()
    registerCommands(ctx, { ...deps(), viewer: createViewer(PLUR, { startViewer: fakeStart().start }) })
    const out = String(await registered.find(c => c.name === 'plur-memory')!.execute())
    expect(out).toContain('http://127.0.0.1:41234/')
    expect(out).toContain('read-only')
  })

  it('reports a start failure as text instead of throwing into the host', async () => {
    const { ctx, registered } = hostWith()
    const start = vi.fn(async (_opts: unknown) => { throw new Error('port busy') })
    registerCommands(ctx, { ...deps(), viewer: createViewer(PLUR, { startViewer: start }) })
    const out = String(await registered.find(c => c.name === 'plur-memory')!.execute())
    expect(out).toContain('port busy')
  })

  it('says so plainly when there is no engine', async () => {
    const { ctx, registered } = hostWith()
    registerCommands(ctx, deps())
    const out = String(await registered.find(c => c.name === 'plur-memory')!.execute())
    expect(out).toMatch(/unavailable/i)
  })

  it('is a no-op on a host with no command registry', () => {
    expect(() => registerCommands({} as Context, deps())).not.toThrow()
  })

  it('disposes every command it registered, not just the last', () => {
    const disposed: string[] = []
    const ctx = {
      commands: {
        register: (c: { name: string }) => () => { disposed.push(c.name) },
      },
    } as unknown as Context
    registerCommands(ctx, deps())()
    expect(disposed.sort()).toEqual(['plur', 'plur-memory'])
  })
})
