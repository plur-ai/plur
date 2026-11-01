import { describe, it, expect, vi, afterEach } from 'vitest'
import { rmSync, writeFileSync, mkdirSync } from 'fs'
import { incrementCounter, counterPath, sessionDir, hybridEnabled } from '../src/lib/codex-hook-io.js'

/**
 * spec/formal/PlurSpec/HookCounters.lean §1, findings/hook-counters.md.
 * The racing hook is replayed in-process: a second incrementCounter runs
 * right after the first one's read of the counter file and before it returns.
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

const SID = `formal-hc-${process.pid}`
afterEach(() => {
  interleave = null
  for (const n of ['race', 'race3']) rmSync(counterPath(SID, n), { force: true })
})

describe('Codex hook counter under a race', () => {
  it('two racing guard hooks get distinct counts, so exactly one denies', () => {
    mkdirSync(sessionDir(), { recursive: true, mode: 0o700 })
    const p = counterPath(SID, 'race')
    writeFileSync(p, '', { mode: 0o600 })
    let b = 0
    interleave = () => { b = incrementCounter(p) }
    const a = incrementCounter(p)
    expect([a, b].sort()).toEqual([1, 2])
    // hook-codex-guard denies while the count is at most MAX_BLOCKS_BEFORE_FALLBACK (1).
    expect([a, b].filter(n => n <= 1)).toHaveLength(1)
  })

  it('a race followed by a later call still counts 1..3', () => {
    mkdirSync(sessionDir(), { recursive: true, mode: 0o700 })
    const p = counterPath(SID, 'race3')
    writeFileSync(p, '', { mode: 0o600 })
    let b = 0
    interleave = () => { b = incrementCounter(p) }
    const a = incrementCounter(p)
    const c = incrementCounter(p)
    expect([a, b, c].sort()).toEqual([1, 2, 3])
  })
})

describe('hybridEnabled off switch', () => {
  it('every off spelling, in any case and padding, turns hybrid injection off', () => {
    for (const v of ['0', 'false', 'off', 'no', 'FALSE', ' Off ', 'No']) {
      expect(hybridEnabled({ PLUR_HOOK_HYBRID: v })).toBe(false)
      expect(hybridEnabled({ PLUR_CODEX_HYBRID: v })).toBe(false)
    }
    for (const v of ['1', 'true', 'on', 'yes', '']) expect(hybridEnabled({ PLUR_HOOK_HYBRID: v })).toBe(true)
    expect(hybridEnabled({})).toBe(true)
    // PLUR_HOOK_HYBRID wins over the alias.
    expect(hybridEnabled({ PLUR_HOOK_HYBRID: '1', PLUR_CODEX_HYBRID: 'off' })).toBe(true)
  })
})
