import { describe, it, expect, vi } from 'vitest'

const { PlurCtor } = vi.hoisted(() => {
  const PlurCtor = vi.fn(function (this: any, opts: any) {
    this.injectHybrid = vi.fn().mockResolvedValue({ count: 0, directives: '', constraints: '', consider: '', injected_ids: [], tokens_used: 0 })
    this.learnRouted = vi.fn().mockResolvedValue(undefined)
  })
  return { PlurCtor }
})

vi.mock('@plur-ai/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@plur-ai/core')>()
  return { ...actual, Plur: PlurCtor }
})

// Import PlurPlugin AFTER the mock is registered
const { PlurPlugin } = await import('../src/index.js')

describe('Plur construction — cwd wiring', () => {
  it('constructs Plur with cwd set to the resolved scope root (worktree)', async () => {
    PlurCtor.mockClear()

    await PlurPlugin({ directory: '/tmp/some-dir', worktree: '/tmp/real-worktree' } as any)

    expect(PlurCtor).toHaveBeenCalledTimes(1)
    expect(PlurCtor.mock.calls[0][0]).toMatchObject({ cwd: '/tmp/real-worktree' })
    // Would FAIL if: cwd line changed to cwd: process.cwd() or cwd property removed entirely
  })

  it('falls back to directory when worktree is the degenerate "/"', async () => {
    PlurCtor.mockClear()

    await PlurPlugin({ directory: '/tmp/plain-dir', worktree: '/' } as any)

    expect(PlurCtor).toHaveBeenCalledTimes(1)
    expect(PlurCtor.mock.calls[0][0]).toMatchObject({ cwd: '/tmp/plain-dir' })
    // Would FAIL if: resolveScopeRoot logic changed to accept "/" as valid, or if readProjectConfig not called with plain-dir
  })

  it('falls back to process.cwd() when neither directory nor worktree is provided', async () => {
    PlurCtor.mockClear()

    await PlurPlugin({} as any)

    expect(PlurCtor).toHaveBeenCalledTimes(1)
    expect(PlurCtor.mock.calls[0][0]).toMatchObject({ cwd: process.cwd() })
    // Would FAIL if: resolveScopeRoot fallback changed or cwd wiring removed
  })

  // D1 (2026-09 audit): the default constructor behaviour walks `cwd`
  // looking for a `.plur/engrams.yaml` and, if found, registers it as a
  // STORE in the user's GLOBAL `~/.plur/config.yaml` — silently and
  // permanently. `cwd` here is the session's git root, exactly where a
  // cloned repo would ship one. This plugin must never let that happen as a
  // side effect of merely loading.
  it('constructs Plur with autoDiscover: false (D1)', async () => {
    PlurCtor.mockClear()

    await PlurPlugin({ directory: '/tmp/some-dir' } as any)

    expect(PlurCtor).toHaveBeenCalledTimes(1)
    expect(PlurCtor.mock.calls[0][0]).toMatchObject({ autoDiscover: false })
    // Would FAIL if: the `autoDiscover: false` option were dropped from the
    // `new Plur(...)` call in index.ts, reverting to core's (dangerous for
    // this use case) default of `true`.
  })
})

describe('Plur construction — error boundary (D7, 2026-09 audit)', () => {
  it('degrades to no-memory (empty hook map) instead of rejecting when Plur construction throws', async () => {
    // `new Plur()` sits before any `safe()` wrapper exists (there is no
    // session yet) — a hostile `.plur.yaml` naming an already-registered
    // scope, or any other constructor-time failure, must not reject the
    // plugin factory's promise and break opencode's plugin load / the
    // host's startup.
    PlurCtor.mockImplementationOnce(() => { throw new Error('scope already registered') })

    const hooks = await PlurPlugin({ directory: '/tmp/some-dir' } as any)
    expect(hooks).toBeDefined()
    // Every hook is optional on the Hooks type — an empty object is a
    // legitimate "no memory this session" hook map, not a broken one.
    expect(hooks['chat.message']).toBeUndefined()
    expect(hooks.dispose).toBeUndefined()
  })
})
