import { describe, it, expect } from 'vitest'
import { resolveProbeTimeoutMs } from '../src/commands/doctor.js'

// PLUR_DOCTOR_TIMEOUT parsing (#273, PR #303). Invalid values must fall back
// to the 300s default: a NaN setTimeout delay is coerced to 1ms by Node, which
// would instantly fail the probe with "probe timeout after NaNms" — the exact
// symptom the configurable timeout exists to fix.
describe('resolveProbeTimeoutMs (PLUR_DOCTOR_TIMEOUT)', () => {
  it('defaults to 300s when the env var is unset', () => {
    expect(resolveProbeTimeoutMs(undefined)).toBe(300_000)
  })

  it('converts a valid value from seconds to milliseconds', () => {
    expect(resolveProbeTimeoutMs('120')).toBe(120_000)
    expect(resolveProbeTimeoutMs('5')).toBe(5_000)
  })

  it('falls back to 300s on garbage input', () => {
    expect(resolveProbeTimeoutMs('abc')).toBe(300_000)
  })

  it('falls back to 300s on empty string (PLUR_DOCTOR_TIMEOUT= in shell/CI)', () => {
    expect(resolveProbeTimeoutMs('')).toBe(300_000)
  })

  it('falls back to 300s on zero and negative values', () => {
    expect(resolveProbeTimeoutMs('0')).toBe(300_000)
    expect(resolveProbeTimeoutMs('-30')).toBe(300_000)
  })

  it('tolerates trailing junk the way parseInt does (e.g. "90s")', () => {
    // parseInt('90s') === 90 — accepted by design; documents the behavior.
    expect(resolveProbeTimeoutMs('90s')).toBe(90_000)
  })
})
