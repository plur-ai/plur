/**
 * Audit of #1228 (persistence slice), finding 3: `settleSpilledEvents` folded a
 * spill dated today into `pending/<today>.json` whenever counters.json still
 * carried an earlier date — it never rolled the stale counters.json over first,
 * as `recordEvent` does. The flush then shipped today's partial count at once,
 * and the events recorded later today shipped again at the next rollover: two
 * heartbeats for one date.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { settleSpilledEvents, recordEvent, readPendingCounters } from '../src/telemetry-counters.js'

const TODAY = '2026-09-27'
const YESTERDAY = '2026-09-26'
const now = () => new Date(`${TODAY}T10:00:00Z`)

describe('audit #1228 finding 3: settling spills rolls a stale counters.json over first', () => {
  let d: string
  let opts: Record<string, any>
  beforeEach(() => {
    d = mkdtempSync(join(tmpdir(), 'plur-audit-tel-'))
    opts = { env: { PLUR_TELEMETRY: 'on' }, countersPath: join(d, 'c.json'), installIdPath: join(d, 'id'), pendingDir: join(d, 'pending') }
  })
  afterEach(() => rmSync(d, { recursive: true, force: true }))

  it("yesterday goes to pending; today's spill lands in counters.json, and later events today join it (one heartbeat per date)", () => {
    writeFileSync(opts.countersPath, JSON.stringify({ date: YESTERDAY, learn: 5, recall: 0, session: 1 }))
    writeFileSync(`${opts.countersPath}.spill.11111111-1111-1111-1111-111111111111`, JSON.stringify({ e: 'learn', d: TODAY }) + '\n')

    expect(settleSpilledEvents({ ...opts, now })).toBe(true)

    // Yesterday is preserved as its own pending day, untouched.
    expect(readPendingCounters(YESTERDAY, opts)).toMatchObject({ date: YESTERDAY, learn: 5, session: 1 })
    // Today is NOT a pending day (that would ship it now, and again at rollover).
    expect(existsSync(join(opts.pendingDir, `${TODAY}.json`))).toBe(false)
    const c = JSON.parse(readFileSync(opts.countersPath, 'utf8'))
    expect(c).toMatchObject({ date: TODAY, learn: 1, session: 1 })

    recordEvent('learn', { ...opts, now })
    expect(JSON.parse(readFileSync(opts.countersPath, 'utf8'))).toMatchObject({ date: TODAY, learn: 2 })
    expect(readdirSync(opts.pendingDir)).toEqual([`${YESTERDAY}.json`])
  })

  it('a spill for an earlier day still goes to that day, and a current counters.json is left in place', () => {
    writeFileSync(opts.countersPath, JSON.stringify({ date: TODAY, learn: 2, recall: 0, session: 1 }))
    writeFileSync(`${opts.countersPath}.spill.22222222-2222-2222-2222-222222222222`, JSON.stringify({ e: 'recall', d: YESTERDAY }) + '\n')
    settleSpilledEvents({ ...opts, now })
    expect(JSON.parse(readFileSync(opts.countersPath, 'utf8'))).toMatchObject({ date: TODAY, learn: 2 })
    expect(readPendingCounters(YESTERDAY, opts)).toMatchObject({ recall: 1 })
  })
})
