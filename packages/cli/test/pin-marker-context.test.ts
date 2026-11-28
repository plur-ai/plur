/**
 * Pin marker audit fixes:
 *  - H7: a subagent is its own context. Its events (SubagentStart and the
 *    tool events fired inside it, which carry `agent_id`) read and record a
 *    marker keyed per subagent, never the main session's. Without an agent id,
 *    a subagent-descended event always includes the pins and records nothing.
 *  - H8: recordPinsDelivered and bumpPinEpoch are compare-and-swap under a
 *    lock file, so a bump cannot land between a delivery's read and write and
 *    be overwritten by it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  readPinMarker, bumpPinEpoch, recordPinsDelivered, pinMarkerPath, pinContext,
} from '../src/lib/pin-marker.js'

describe('pin marker: per-subagent context (H7) and CAS (H8)', () => {
  let dir: string
  const prevTmp = process.env.TMPDIR
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-pinctx-'))
    process.env.TMPDIR = dir
  })
  afterEach(() => {
    if (prevTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = prevTmp
    rmSync(dir, { recursive: true, force: true })
  })

  it('main context: first prompt and same-context events use the session marker', () => {
    expect(pinContext({ session_id: 's1' }, null)).toEqual({ contextId: 's1', include: true, record: true })
    expect(pinContext({ session_id: 's1' }, 'skill')).toEqual({ contextId: 's1', include: true, record: true })
    recordPinsDelivered('s1', 0)
    expect(pinContext({ session_id: 's1' }, 'skill').include).toBe(false)
    expect(pinContext({ session_id: 's1' }, null).include).toBe(true)
  })

  it('a subagent with an agent id has its own marker: the main delivery does not suppress its pins, and its delivery does not suppress the main context', () => {
    recordPinsDelivered('s2', 0)
    const start = pinContext({ session_id: 's2', agent_id: 'a1', hook_event_name: 'SubagentStart' }, 'subagent')
    expect(start.include).toBe(true)
    expect(start.record).toBe(true)
    expect(start.contextId).not.toBe('s2')
    // A skill inside the subagent, before the subagent got its pins: included.
    expect(pinContext({ session_id: 's2', agent_id: 'a1' }, 'skill').include).toBe(true)
    recordPinsDelivered(start.contextId!, 0)
    expect(pinContext({ session_id: 's2', agent_id: 'a1' }, 'skill').include).toBe(false)
    // Another subagent is another context.
    expect(pinContext({ session_id: 's2', agent_id: 'a2' }, 'skill').include).toBe(true)
    // The main context's marker is untouched by the subagent's.
    expect(readPinMarker('s2')).toEqual({ session_id: 's2', epoch: 0, pins_delivered: true })
    expect(pinMarkerPath(start.contextId)).not.toBe(pinMarkerPath('s2'))
  })

  it('a subagent-descended event without an agent id always includes pins and records nothing', () => {
    recordPinsDelivered('s3', 0)
    expect(pinContext({ session_id: 's3', hook_event_name: 'SubagentStart' }, 'subagent')).toEqual({ contextId: null, include: true, record: false })
    expect(pinContext({ session_id: 's3', agent_type: 'Explore' }, 'skill')).toEqual({ contextId: null, include: true, record: false })
  })

  it('a long session id and agent id never map onto the main marker path', () => {
    const sid = 'x'.repeat(60)
    const ctx = pinContext({ session_id: sid, agent_id: 'y'.repeat(40) }, 'skill')
    expect(pinMarkerPath(ctx.contextId)).not.toBe(pinMarkerPath(sid))
    const other = pinContext({ session_id: sid, agent_id: 'z'.repeat(40) }, 'skill')
    expect(pinMarkerPath(ctx.contextId)).not.toBe(pinMarkerPath(other.contextId))
  })

  it('a bump cannot land between a delivery record\'s read and write (H8)', () => {
    let seamRan = false
    let inner: ReturnType<typeof bumpPinEpoch> | undefined
    recordPinsDelivered('s4', 0, {
      _beforeWrite: () => {
        seamRan = true
        inner = bumpPinEpoch('s4', { lockWaitMs: 0, forceOnTimeout: false })
      },
    })
    expect(seamRan).toBe(true)
    // The record held the lock: the concurrent bump was refused, not lost.
    expect(inner).toBeNull()
    expect(readPinMarker('s4')).toEqual({ session_id: 's4', epoch: 0, pins_delivered: true })
    // Once released, the bump goes through and resets the delivery.
    expect(bumpPinEpoch('s4')).toEqual({ session_id: 's4', epoch: 1, pins_delivered: false })
    expect(existsSync(`${pinMarkerPath('s4')}.lock`)).toBe(false)
  })

  it('a delivery for an epoch the marker has left is not recorded (CAS)', () => {
    bumpPinEpoch('s5')
    recordPinsDelivered('s5', 0)
    expect(readPinMarker('s5')).toEqual({ session_id: 's5', epoch: 1, pins_delivered: false })
  })
})
