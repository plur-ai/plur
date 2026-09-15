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
})
