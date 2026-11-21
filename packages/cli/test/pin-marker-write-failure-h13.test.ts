/**
 * H13: a compaction (SessionStart compact/clear/resume) bumps the pin
 * marker's epoch, which resets "pins delivered". If that write fails, the old
 * marker — still saying the pins were delivered — would stay, and every skill,
 * agent and plan-mode event after the compaction would leave the pins out of
 * a context that no longer has them. A failed bump removes the marker instead
 * (no marker = include the pins) and leaves a note in hook-runs.json.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const failures = { rename: false }
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  return {
    ...real,
    renameSync: (from: string, to: string) => {
      // Only the marker's rename fails (the hook-runs note is written through the same module).
      if (failures.rename && String(to).endsWith('.pins')) throw Object.assign(new Error(`EACCES: permission denied, rename '${from}'`), { code: 'EACCES' })
      return real.renameSync(from, to)
    },
  }
})

import { mkdtempSync, rmSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { readPinMarker, bumpPinEpoch, recordPinsDelivered, shouldIncludePins } from '../src/lib/pin-marker.js'
import { readHookNotes } from '../src/lib/hook-runs.js'

describe('pin marker: a failed epoch bump (H13)', () => {
  let dir: string
  const prev = { TMPDIR: process.env.TMPDIR, PLUR_PATH: process.env.PLUR_PATH }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-pinmark-h13-'))
    process.env.TMPDIR = dir
    process.env.PLUR_PATH = join(dir, 'store')
    failures.rename = false
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    failures.rename = false
    rmSync(dir, { recursive: true, force: true })
  })

  it('removes the stale "delivered" marker so the next skill event includes the pins, and records a note', () => {
    recordPinsDelivered('s1', 0)
    expect(readPinMarker('s1')).toEqual({ session_id: 's1', epoch: 0, pins_delivered: true })
    expect(shouldIncludePins('skill', readPinMarker('s1'))).toBe(false)

    failures.rename = true
    const bumped = bumpPinEpoch('s1')
    failures.rename = false

    expect(bumped).toBeNull()
    expect(readPinMarker('s1')).toBeNull()
    expect(shouldIncludePins('skill', readPinMarker('s1'))).toBe(true)
    const note = readHookNotes(join(dir, 'store')).claude?.pin_marker
    expect(note, JSON.stringify(readHookNotes(join(dir, 'store')))).toBeDefined()
    expect(String(note!.error)).toMatch(/EACCES/)
    expect(Number.isFinite(Date.parse(String(note!.at)))).toBe(true)
    // no temp file is left behind
    expect(readdirSync(join(dir, 'plur-sessions')).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  it('a successful bump still returns the new marker', () => {
    recordPinsDelivered('s2', 0)
    expect(bumpPinEpoch('s2')).toEqual({ session_id: 's2', epoch: 1, pins_delivered: false })
    expect(readPinMarker('s2')).toEqual({ session_id: 's2', epoch: 1, pins_delivered: false })
  })
})
