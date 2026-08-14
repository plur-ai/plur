import { describe, expect, it } from 'vitest'
import { createRefreshPolicy } from '../src/refresh.js'

describe('createRefreshPolicy', () => {
  it('refreshes on the first step of a turn', () => {
    expect(createRefreshPolicy({ refreshIntervalMs: 0 }).shouldRefresh('a1', 1)).toBe(true)
  })

  it('does NOT refresh on later steps — one recall per user turn', () => {
    const p = createRefreshPolicy({ refreshIntervalMs: 0 })
    expect(p.shouldRefresh('a1', 2)).toBe(false)
    expect(p.shouldRefresh('a1', 7)).toBe(false)
  })

  it('suppresses a repeat within refreshIntervalMs — the retry-storm guard', () => {
    let t = 1000
    const p = createRefreshPolicy({ refreshIntervalMs: 500, now: () => t })
    expect(p.shouldRefresh('a1', 1)).toBe(true)
    p.markRefreshed('a1')
    t = 1200
    expect(p.shouldRefresh('a1', 1)).toBe(false)
    t = 1600
    expect(p.shouldRefresh('a1', 1)).toBe(true)
  })

  it('with interval 0 allows every turn boundary', () => {
    let t = 1000
    const p = createRefreshPolicy({ refreshIntervalMs: 0, now: () => t })
    expect(p.shouldRefresh('a1', 1)).toBe(true)
    p.markRefreshed('a1')
    t = 1001
    expect(p.shouldRefresh('a1', 1)).toBe(true)
  })

  it('tracks agents independently', () => {
    const t = 1000
    const p = createRefreshPolicy({ refreshIntervalMs: 500, now: () => t })
    p.shouldRefresh('a1', 1)
    p.markRefreshed('a1')
    expect(p.shouldRefresh('a2', 1)).toBe(true)
  })

  it('clear forgets an agent', () => {
    const t = 1000
    const p = createRefreshPolicy({ refreshIntervalMs: 500, now: () => t })
    p.markRefreshed('a1')
    p.clear('a1')
    expect(p.shouldRefresh('a1', 1)).toBe(true)
  })

  it('treats a step below 1 as not a turn boundary', () => {
    const p = createRefreshPolicy({ refreshIntervalMs: 0 })
    expect(p.shouldRefresh('a1', 0)).toBe(false)
  })
})
