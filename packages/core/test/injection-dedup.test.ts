import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { appendHistory, computeQueryHash, isRecentDuplicateInjection, generateInjectionId } from '../src/history.js'

describe('cross-process injection dedup (#975)', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-dedup-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('detects a duplicate co_injection with same query_hash and engram IDs', () => {
    const queryHash = computeQueryHash('what is the project status')
    const ids = ['eng-1', 'eng-2', 'eng-3']

    // Write the first injection
    appendHistory(root, {
      event: 'co_injection',
      engram_id: generateInjectionId(),
      timestamp: new Date().toISOString(),
      data: { ids, query_hash: queryHash, tokens_used: 500, source: 'inject' },
    })

    // The same query+IDs within the window = duplicate
    expect(isRecentDuplicateInjection(root, queryHash, ids)).toBe(true)
  })

  it('does NOT flag as duplicate when engram IDs differ', () => {
    const queryHash = computeQueryHash('what is the project status')

    appendHistory(root, {
      event: 'co_injection',
      engram_id: generateInjectionId(),
      timestamp: new Date().toISOString(),
      data: { ids: ['eng-1', 'eng-2'], query_hash: queryHash, tokens_used: 500, source: 'inject' },
    })

    // Same query but different engrams selected = NOT a duplicate
    expect(isRecentDuplicateInjection(root, queryHash, ['eng-1', 'eng-3'])).toBe(false)
  })

  it('does NOT flag as duplicate when query differs', () => {
    const ids = ['eng-1', 'eng-2']

    appendHistory(root, {
      event: 'co_injection',
      engram_id: generateInjectionId(),
      timestamp: new Date().toISOString(),
      data: { ids, query_hash: computeQueryHash('query one'), tokens_used: 500, source: 'inject' },
    })

    // Different query = NOT a duplicate even with same IDs
    expect(isRecentDuplicateInjection(root, computeQueryHash('query two'), ids)).toBe(false)
  })

  it('does NOT flag old events outside the window', () => {
    const queryHash = computeQueryHash('old query')
    const ids = ['eng-1']

    // Write an event with a timestamp 10 seconds ago
    const old = new Date(Date.now() - 10_000).toISOString()
    appendHistory(root, {
      event: 'co_injection',
      engram_id: generateInjectionId(),
      timestamp: old,
      data: { ids, query_hash: queryHash, tokens_used: 100, source: 'inject' },
    })

    // Outside the 5s window = NOT a duplicate
    expect(isRecentDuplicateInjection(root, queryHash, ids, 5_000)).toBe(false)
  })

  it('is order-insensitive on engram IDs', () => {
    const queryHash = computeQueryHash('order test')

    appendHistory(root, {
      event: 'co_injection',
      engram_id: generateInjectionId(),
      timestamp: new Date().toISOString(),
      data: { ids: ['b', 'a', 'c'], query_hash: queryHash, tokens_used: 100, source: 'inject' },
    })

    // Same IDs in different order = IS a duplicate
    expect(isRecentDuplicateInjection(root, queryHash, ['c', 'a', 'b'])).toBe(true)
  })

  it('returns false on empty/missing history', () => {
    expect(isRecentDuplicateInjection(root, 'abc123', ['eng-1'])).toBe(false)
  })
})
