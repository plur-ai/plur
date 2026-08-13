import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  shouldOutputJson,
  outputText,
  outputInfo,
  outputError,
  setQuiet,
  isQuiet,
  type OutputOptions,
} from '../src/output.js'

describe('output', () => {
  it('returns true when json flag is set', () => {
    expect(shouldOutputJson({ json: true })).toBe(true)
  })

  it('returns false when json flag is explicitly false', () => {
    expect(shouldOutputJson({ json: false })).toBe(false)
  })
})

// #730 — the --quiet plumbing. outputText is primary output (never
// suppressed), outputInfo is informational (suppressed by quiet, per-call or
// global), outputError always reaches stderr.
describe('output --quiet (#730)', () => {
  let out: string[]
  let err: string[]
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    out = []
    err = []
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      out.push(String(chunk))
      return true
    }) as never)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      err.push(String(chunk))
      return true
    }) as never)
  })

  afterEach(() => {
    setQuiet(false) // never leak global state into other tests
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  it('outputText always writes, even under global quiet', () => {
    setQuiet(true)
    outputText('primary result')
    expect(out.join('')).toBe('primary result\n')
  })

  it('outputInfo writes by default', () => {
    outputInfo('progress line')
    expect(out.join('')).toBe('progress line\n')
  })

  it('outputInfo is suppressed by per-call quiet', () => {
    outputInfo('progress line', { quiet: true })
    expect(out).toHaveLength(0)
  })

  it('outputInfo is suppressed by global quiet set at the entry point', () => {
    setQuiet(true)
    outputInfo('progress line')
    expect(out).toHaveLength(0)
  })

  it('per-call options override the global flag in both directions', () => {
    setQuiet(true)
    outputInfo('explicitly loud', { quiet: false })
    expect(out.join('')).toBe('explicitly loud\n')

    setQuiet(false)
    outputInfo('explicitly quiet', { quiet: true })
    expect(out.join('')).toBe('explicitly loud\n') // unchanged
  })

  it('isQuiet reflects the per-call override, else the global flag', () => {
    expect(isQuiet()).toBe(false)
    setQuiet(true)
    expect(isQuiet()).toBe(true)
    expect(isQuiet({ quiet: false } as OutputOptions)).toBe(false)
    setQuiet(false)
    expect(isQuiet({ quiet: true } as OutputOptions)).toBe(true)
  })

  it('outputError writes to stderr and ignores quiet entirely', () => {
    setQuiet(true)
    outputError('something broke')
    expect(err.join('')).toBe('something broke\n')
    expect(out).toHaveLength(0)
  })
})
