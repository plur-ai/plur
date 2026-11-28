/**
 * W2+4 / R7 (overhaul): pins load once per context. A per-session marker
 * records {session_id, epoch, pins_delivered}; the epoch goes up on
 * SessionStart with source compact, clear or resume; subagent start always
 * includes pins; skill, agent and plan-mode events leave them out only when
 * the current epoch records a successful delivery (fail open otherwise).
 * Keyed on the payload session_id only — never ppid.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  readPinMarker, bumpPinEpoch, recordPinsDelivered, shouldIncludePins, isEpochBumpStart, pinMarkerPath,
} from '../src/lib/pin-marker.js'

describe('pin marker', () => {
  let dir: string
  const prevTmp = process.env.TMPDIR
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-pinmark-'))
    process.env.TMPDIR = dir
  })
  afterEach(() => {
    if (prevTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = prevTmp
    rmSync(dir, { recursive: true, force: true })
  })

  it('no session id: no marker, pins included (no ppid fallback)', () => {
    expect(pinMarkerPath(undefined)).toBeNull()
    expect(pinMarkerPath('')).toBeNull()
    expect(readPinMarker(undefined)).toBeNull()
    expect(shouldIncludePins('skill', null)).toBe(true)
  })

  it('a delivery in the current epoch excludes pins from skill, agent and plan-mode events; subagent and first prompt always include', () => {
    const m0 = readPinMarker('s1')
    expect(m0).toBeNull()
    recordPinsDelivered('s1', 0)
    const m = readPinMarker('s1')!
    expect(m).toEqual({ session_id: 's1', epoch: 0, pins_delivered: true })
    for (const ev of ['skill', 'agent', 'plan_mode']) expect(shouldIncludePins(ev, m), ev).toBe(false)
    expect(shouldIncludePins('subagent', m)).toBe(true)
    expect(shouldIncludePins(null, m)).toBe(true)
  })

  it('an epoch bump (compaction, clear, resume) resets the delivery: events include pins until the next delivery', () => {
    recordPinsDelivered('s2', 0)
    const bumped = bumpPinEpoch('s2')
    expect(bumped).toEqual({ session_id: 's2', epoch: 1, pins_delivered: false })
    expect(shouldIncludePins('skill', readPinMarker('s2'))).toBe(true)
    recordPinsDelivered('s2', 1)
    expect(shouldIncludePins('skill', readPinMarker('s2'))).toBe(false)
  })

  it('a delivery recorded for a stale epoch does not mark the new one (a bump raced the injection)', () => {
    bumpPinEpoch('s3') // epoch 1
    recordPinsDelivered('s3', 0)
    expect(readPinMarker('s3')).toEqual({ session_id: 's3', epoch: 1, pins_delivered: false })
  })

  it('a marker for another session, or a corrupt one, reads as absent (fail open)', () => {
    recordPinsDelivered('s4', 0)
    const p = pinMarkerPath('s4')!
    writeFileSync(p, JSON.stringify({ session_id: 'other', epoch: 0, pins_delivered: true }))
    expect(readPinMarker('s4')).toBeNull()
    writeFileSync(p, '{not json')
    expect(readPinMarker('s4')).toBeNull()
    expect(shouldIncludePins('skill', readPinMarker('s4'))).toBe(true)
  })

  it('epoch bump starts: SessionStart with source compact, clear or resume', () => {
    expect(isEpochBumpStart({ hook_event_name: 'SessionStart', source: 'compact' })).toBe(true)
    expect(isEpochBumpStart({ hook_event_name: 'SessionStart', source: 'clear' })).toBe(true)
    expect(isEpochBumpStart({ hook_event_name: 'SessionStart', source: 'resume' })).toBe(true)
    expect(isEpochBumpStart({ hook_event_name: 'SessionStart', source: 'startup' })).toBe(false)
    expect(isEpochBumpStart({ hook_event_name: 'UserPromptSubmit', source: 'compact' })).toBe(false)
  })
})
