import { describe, expect, it, vi } from 'vitest'
import { Config } from '../src/config.js'
import { createEngine } from '../src/engine.js'
import { cfg } from './helpers/config.js'

const config = () => cfg({})

describe('createEngine against the REAL @plur-ai/core', () => {
  it('constructs an engine — the production path, not a fake', async () => {
    // The regression this file exists for: core is `"type": "module"` and its
    // exports map declares no `require` condition, so the previous
    // createRequire()-based loader threw ERR_PACKAGE_PATH_NOT_EXPORTED on every
    // real install. The catch swallowed it, the plugin registered every surface,
    // and it recalled nothing. Every other suite passed, because every other
    // suite injects a client.
    const engine = createEngine(config())
    await expect(engine.ready()).resolves.toBe(true)
  })

  it('can actually reach the store through the facade', async () => {
    const engine = createEngine(config())
    await expect(engine.list!()).resolves.toBeInstanceOf(Array)
    const status = await engine.status!()
    expect(status.storage_root).toBeTypeOf('string')
  })

  it('resolves the module exactly once however many calls arrive', async () => {
    const importCore = vi.fn(() => import('@plur-ai/core'))
    const engine = createEngine(config(), importCore)
    await Promise.all([engine.ready(), engine.list!(), engine.status!(), engine.ready()])
    expect(importCore).toHaveBeenCalledTimes(1)
  })
})

describe('createEngine when core is unavailable', () => {
  const missing = () => Promise.reject(new Error('ERR_MODULE_NOT_FOUND'))

  it('reports not-ready rather than throwing at mount time', async () => {
    const engine = createEngine(config(), missing)
    await expect(engine.ready()).resolves.toBe(false)
  })

  it('logs a warning when the engine fails to load (#941)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const engine = createEngine(config(), missing)
    await engine.ready()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toMatch(/memory engine unavailable/)
    expect(warn.mock.calls[0][0]).toMatch(/ERR_MODULE_NOT_FOUND/)
    warn.mockRestore()
  })

  it('degrades every read to empty instead of taking the host down', async () => {
    const engine = createEngine(config(), missing)
    await expect(engine.recall!('x')).resolves.toEqual([])
    await expect(engine.list!()).resolves.toEqual([])
    await expect(engine.status!()).resolves.toEqual({})
    await expect(engine.injectHybrid!('x')).resolves.toEqual({ count: 0 })
  })

  it('degrades every write to a no-op instead of rejecting', async () => {
    const engine = createEngine(config(), missing)
    await expect(engine.learn!('x')).resolves.toBeUndefined()
    await expect(engine.forget!('id')).resolves.toBeUndefined()
    await expect(engine.feedback!('id', 'positive')).resolves.toBeUndefined()
    await expect(engine.capture!('x')).resolves.toBeUndefined()

  })

  it('treats a module with no Plur export as unavailable, not as a crash', async () => {
    const engine = createEngine(config(), async () => ({ nothing: true }))
    await expect(engine.ready()).resolves.toBe(false)
  })

  it('survives a constructor that throws, e.g. a WASM store that will not init', async () => {
    const engine = createEngine(config(), async () => ({
      Plur: class { constructor() { throw new Error('wasm init failed') } },
    }))
    await expect(engine.ready()).resolves.toBe(false)
  })
})

describe('the facade shape', () => {
  it('accepts a default-wrapped namespace as well as a named export', async () => {
    const Plur = class { async list() { return [{ id: 'a', statement: 'b' }] } }
    const engine = createEngine(config(), async () => ({ default: { Plur } }))
    await expect(engine.ready()).resolves.toBe(true)
  })

  it('falls back to BM25 inject when the build of core has no hybrid path', async () => {
    const inject = vi.fn(async () => ({ directives: 'use pnpm', count: 1 }))
    const engine = createEngine(config(), async () => ({ Plur: class { inject = inject } }))
    const out = await engine.injectHybrid!('task', { scope: 's' })
    expect(inject).toHaveBeenCalledWith('task', { scope: 's' })
    expect(out).toMatchObject({ directives: 'use pnpm', count: 1 })
  })

  it('passes the configured store path to the constructor', async () => {
    const seen: Array<{ path?: string }> = []
    const engine = createEngine(cfg({ path: '/tmp/elsewhere' }), async () => ({
      Plur: class { constructor(o: { path?: string }) { seen.push(o) } },
    }))
    await engine.ready()
    expect(seen[0]).toEqual({ path: '/tmp/elsewhere' })
  })
})
