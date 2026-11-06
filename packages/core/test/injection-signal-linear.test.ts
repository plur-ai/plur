/**
 * Security audit 2026-11-06 (hardening): the reply rater's tokenizer trimmed
 * quote marks and dashes with /^['-]+|['-]+$/, which backtracks
 * quadratically on one token holding a long interior run ("a----…--b"), and
 * rateInjectedEngrams re-tokenized the whole reply once per injected engram.
 * Now the trim is an index loop, the reply is tokenized once, and only its
 * last 64 KiB are rated.
 */
import { describe, it, expect } from 'vitest'
import { detectInjectionSignal, rateInjectedEngrams } from '../src/injection-signal.js'

describe('injection-signal stays linear on adversarial replies (security audit 2026-11-06)', () => {
  it('a 200k-char interior hyphen run finishes in under 200 ms', () => {
    const reply = 'a' + '-'.repeat(200_000) + 'b'
    const t0 = performance.now()
    detectInjectionSignal('use pnpm for installs', reply)
    expect(performance.now() - t0).toBeLessThan(200)
  })

  it('a 60k-char interior run inside the rated tail finishes in under 200 ms', () => {
    const reply = 'a' + '-'.repeat(60_000) + 'b'
    const t0 = performance.now()
    detectInjectionSignal('use pnpm for installs', reply)
    expect(performance.now() - t0).toBeLessThan(200)
  })

  it('a 200k-char interior apostrophe run finishes in under 200 ms', () => {
    const reply = 'x' + "'".repeat(200_000) + 'y'
    const t0 = performance.now()
    detectInjectionSignal('use pnpm for installs', reply)
    expect(performance.now() - t0).toBeLessThan(200)
  })

  it('rating ten engrams against a 200k adversarial reply finishes in under 200 ms', () => {
    const reply = ('a' + '-'.repeat(20_000) + 'b ').repeat(10)
    const engrams = Array.from({ length: 10 }, (_, i) => ({ id: `ENG-${i}`, statement: `dummy statement number ${i} about builds` }))
    const t0 = performance.now()
    rateInjectedEngrams(engrams, reply)
    expect(performance.now() - t0).toBeLessThan(200)
  })

  it('keeps its verdicts: trimmed words, quoted-then-corrected, and the reply tail', () => {
    expect(detectInjectionSignal('use pnpm for installs', "Sure — I'll 'use pnpm for installs' now.").signal).toBe('positive')
    expect(detectInjectionSignal('use pnpm for installs', 'Do not use pnpm for installs.').signal).toBe('negative')
    const rated = rateInjectedEngrams(
      [{ id: 'ENG-A', statement: 'use pnpm for installs' }, { id: 'ENG-B', statement: 'tag releases with semver' }],
      'filler words here. '.repeat(10_000) + 'I will use pnpm for installs.',
    )
    expect(rated.map(r => r.id)).toEqual(['ENG-A'])
  })
})
