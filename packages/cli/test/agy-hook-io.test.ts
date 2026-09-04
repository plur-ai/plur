import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, writeFileSync, statSync, existsSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  agySessionDir,
  agySentinelPath,
  agyCounterPath,
  agyMarkSessionStarted,
  agyIsSessionStarted,
  agyIncrementCounter,
  cleanupStaleAgySessionFiles,
  agyTextHash,
  readAgyTurnCache,
  writeAgyTurnCache,
} from '../src/lib/agy-hook-io.js'

/**
 * Pins for the agy copies of behaviours codex-hook-io.test.ts already pins
 * (evaluator audit M15: deliberate duplication with no drift detector is
 * duplication waiting to drift), plus the turn-cache validation rules all
 * three audits converged on.
 */

const SID = 'agy-io-test-conversation'

function clean() {
  for (const n of ['a', 'b', 'turncache']) rmSync(agyCounterPath(SID, n), { force: true })
  rmSync(agySentinelPath(SID), { force: true })
}
beforeEach(clean)
afterEach(clean)

describe('sentinel + counters (drift pins vs codex-hook-io)', () => {
  it('marks and detects a started session', () => {
    expect(agyIsSessionStarted(SID)).toBe(false)
    agyMarkSessionStarted(SID)
    expect(agyIsSessionStarted(SID)).toBe(true)
  })

  it('sanitizes ids so a traversal attempt cannot escape the session dir', () => {
    const p = agySentinelPath('../../etc/passwd')
    expect(p.startsWith(agySessionDir())).toBe(true)
    expect(p).not.toContain('..')
  })

  it('treats a corrupt counter file as zero rather than NaN', () => {
    agyMarkSessionStarted(SID) // ensures the dir exists
    writeFileSync(agyCounterPath(SID, 'b'), 'not a number')
    expect(agyIncrementCounter(agyCounterPath(SID, 'b'))).toBe(1)
  })

  it('reports an unwritable counter as exceeded so guards fail open', () => {
    const unwritable = join(agySessionDir(), 'no-such-dir', 'nested', 'counter')
    expect(agyIncrementCounter(unwritable)).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('sweeps stale files and keeps fresh ones', () => {
    agyMarkSessionStarted(SID)
    const stale = agyCounterPath(SID, 'a')
    writeFileSync(stale, '1')
    const old = Date.now() / 1000 - 8 * 24 * 60 * 60
    utimesSync(stale, old, old)
    cleanupStaleAgySessionFiles()
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(agySentinelPath(SID))).toBe(true)
  })

  it('does not throw when the session dir does not exist', () => {
    const missing = join(tmpdir(), 'plur-agy-sessions-does-not-exist')
    rmSync(missing, { recursive: true, force: true })
    expect(() => cleanupStaleAgySessionFiles(Date.now(), missing)).not.toThrow()
  })
})

describe('turn cache validation', () => {
  const sample = () => ({
    conversationId: SID,
    step: 4,
    textHash: agyTextHash('hello'),
    message: '[PLUR Memory] recalled text',
  })

  it('round-trips', () => {
    writeAgyTurnCache(sample())
    expect(readAgyTurnCache(SID)).toEqual(sample())
  })

  // Data-loss audit F8: this file holds recalled engram content. World- or
  // group-readable modes on shared /tmp expose every conversation's memory.
  it('writes the cache file 0600 on POSIX', () => {
    if (process.platform === 'win32') return
    writeAgyTurnCache(sample())
    expect(statSync(agyCounterPath(SID, 'turncache')).mode & 0o777).toBe(0o600)
  })

  it('rejects a record whose embedded conversationId differs (path collision, F9)', () => {
    writeAgyTurnCache({ ...sample(), conversationId: 'agy-io-test.conversation' })
    // Same sanitized path, different exact id → must read as no cache.
    expect(readAgyTurnCache(SID)).toBeNull()
  })

  it.each([
    ['poisoned step 1e308', { step: 1e308 }],
    ['string step', { step: '4' }],
    ['missing message', { message: undefined }],
    ['numeric message', { message: 42 }],
  ])('rejects an invalid record: %s', (_label, patch) => {
    agyMarkSessionStarted(SID)
    writeFileSync(
      agyCounterPath(SID, 'turncache'),
      JSON.stringify({ ...sample(), ...patch }),
    )
    expect(readAgyTurnCache(SID)).toBeNull()
  })

  it('treats a torn file as no cache', () => {
    agyMarkSessionStarted(SID)
    writeFileSync(agyCounterPath(SID, 'turncache'), '{"conversationId":"' + SID + '","step)')
    expect(readAgyTurnCache(SID)).toBeNull()
  })
})
