import { describe, expect, it, vi } from 'vitest'
import { createWriteQueue, guard } from '../src/guard.ts'

describe('guard', () => {
  it('returns the value on success', async () => {
    expect(await guard(async () => 42, { timeoutMs: 1000 })).toBe(42)
  })

  it('swallows a rejection and returns undefined', async () => {
    const onError = vi.fn()
    const r = await guard(async () => { throw new Error('boom') }, { timeoutMs: 1000, onError })
    expect(r).toBeUndefined()
    expect(onError).toHaveBeenCalledOnce()
  })

  it('swallows a synchronous throw raised before the promise exists', async () => {
    const r = await guard(() => { throw new Error('sync boom') }, { timeoutMs: 1000 })
    expect(r).toBeUndefined()
  })

  it('times out a hung call and returns undefined', async () => {
    const r = await guard(() => new Promise(() => {}), { timeoutMs: 20 })
    expect(r).toBeUndefined()
  })

  it('does not leave a pending timer after a fast success', async () => {
    vi.useFakeTimers()
    try {
      await expect(guard(async () => 'ok', { timeoutMs: 60_000 })).resolves.toBe('ok')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never rejects, even when the error observer itself throws', async () => {
    const r = await guard(
      async () => { throw new Error('boom') },
      { timeoutMs: 1000, onError: () => { throw new Error('observer boom') } },
    )
    expect(r).toBeUndefined()
  })
})

describe('createWriteQueue', () => {
  it('serializes overlapping writes', async () => {
    const q = createWriteQueue()
    const order: string[] = []
    const slow = async () => { await new Promise(r => setTimeout(r, 20)); order.push('a') }
    const fast = async () => { order.push('b') }
    await Promise.all([q(slow), q(fast)])
    expect(order).toEqual(['a', 'b'])
  })

  it('a rejected write does not poison the queue', async () => {
    const q = createWriteQueue()
    await q(async () => { throw new Error('bad') })
    expect(await q(async () => 'next')).toBe('next')
  })

  it('a rejected write resolves undefined rather than rejecting', async () => {
    const q = createWriteQueue()
    await expect(q(async () => { throw new Error('bad') })).resolves.toBeUndefined()
  })
})
