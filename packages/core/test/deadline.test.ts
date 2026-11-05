import { describe, it, expect, vi, afterEach } from 'vitest'
import { withDeadline, DEADLINE_MISSED } from '../src/index.js'

afterEach(() => { vi.useRealTimers() })

describe('withDeadline', () => {
  it('returns the value when the promise settles first, even a falsy one', async () => {
    expect(await withDeadline(Promise.resolve(0), 1000)).toBe(0)
    expect(await withDeadline(Promise.resolve(null), 1000)).toBeNull()
  })

  it('returns DEADLINE_MISSED when the deadline passes first and clears its timer either way', async () => {
    vi.useFakeTimers()
    const never = new Promise<string>(() => {})
    const raced = withDeadline(never, 50)
    await vi.advanceTimersByTimeAsync(50)
    expect(await raced).toBe(DEADLINE_MISSED)
    expect(vi.getTimerCount()).toBe(0)
    await withDeadline(Promise.resolve('x'), 50)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates a rejection that arrives before the deadline', async () => {
    await expect(withDeadline(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom')
  })
})
