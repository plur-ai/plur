import { describe, it, expect, vi, afterEach } from 'vitest'
import { rmSync, writeFileSync, mkdirSync } from 'fs'
import { agyIncrementCounter, agyCounterPath, agySessionDir } from '../src/lib/agy-hook-io.js'

/**
 * spec/formal/PlurSpec/HookCounters.lean §1, findings/hook-counters.md.
 * The Antigravity counter is the same ticket counter as the Codex one. The
 * racing hook is replayed in-process: a second agyIncrementCounter runs right
 * after the first one's read of the counter file and before it returns.
 */

let interleave: (() => void) | null = null
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    readFileSync: ((...a: Parameters<typeof actual.readFileSync>) => {
      const r = actual.readFileSync(...a)
      const other = interleave
      interleave = null
      other?.()
      return r
    }) as typeof actual.readFileSync,
  }
})

const SID = `formal-agy-${process.pid}`
afterEach(() => {
  interleave = null
  for (const n of ['race', 'race3', 'chain']) rmSync(agyCounterPath(SID, n), { force: true })
})

describe('Antigravity hook counter under a race', () => {
  it('two racing guard hooks get distinct counts, so exactly one denies', () => {
    mkdirSync(agySessionDir(), { recursive: true, mode: 0o700 })
    const p = agyCounterPath(SID, 'race')
    writeFileSync(p, '', { mode: 0o600 })
    let b = 0
    interleave = () => { b = agyIncrementCounter(p) }
    const a = agyIncrementCounter(p)
    expect([a, b].sort()).toEqual([1, 2])
    // hook-agy-guard denies while the count is at most MAX_BLOCKS_BEFORE_FALLBACK (1).
    expect([a, b].filter(n => n <= 1)).toHaveLength(1)
  })

  it('a chain of racing increments loses none: five hooks, each racing the next, count 1..5', () => {
    mkdirSync(agySessionDir(), { recursive: true, mode: 0o700 })
    const p = agyCounterPath(SID, 'chain')
    writeFileSync(p, '', { mode: 0o600 })
    const got: number[] = []
    const hookAt = (left: number): void => {
      if (left > 1) interleave = () => hookAt(left - 1)
      got.push(agyIncrementCounter(p))
    }
    hookAt(5)
    expect(got.sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5])
  })
})
