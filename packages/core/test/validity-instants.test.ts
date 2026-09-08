/**
 * Validity windows expressed as RFC 3339 instants (#1150).
 *
 * The comparison these guard used to be lexical: a timestamp STRING against
 * today's DATE string. `'2026-09-07T01:00:00Z' > '2026-09-07'` is true at every
 * hour of that day, so an instant window was read backwards in BOTH directions
 * — a rule that came into force at 01:00 stayed hidden all day, and one that
 * lapsed at 01:00 stayed eligible all day.
 *
 * The expiry direction is the one that matters: an instruction that lapsed
 * hours ago still entered the agent's context, and reads exactly like a current
 * one.
 *
 * The date-only cases are controls. They behaved correctly before, and the
 * whole-day semantics they depend on is documented behaviour — a fix that
 * treats `valid_until: 2026-09-06` as midnight would expire it a day early and
 * break them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  isCurrentlyValid, isNotYetValid, isExpired, isExpiredBeyondGrace, pinToUtc,
} from '../src/validity.js'
import { Plur } from '../src/index.js'
import { selectAndSpread } from '../src/inject.js'
import { EngramSchema } from '../src/schemas/engram.js'

const NOON = Date.parse('2026-09-07T12:00:00Z')

describe('validity evaluator', () => {
  it.each([
    // [name, temporal, expected isCurrentlyValid]
    ['an instant start already passed today', { valid_from: '2026-09-07T01:00:00Z' }, true],
    ['an instant expiry already passed today', { valid_until: '2026-09-07T01:00:00Z' }, false],
    ['a date-only start of today', { valid_from: '2026-09-07' }, true],
    ['a date-only expiry of yesterday', { valid_until: '2026-09-06' }, false],
    // The other side of each: still-future starts and not-yet expiries.
    ['an instant start later today', { valid_from: '2026-09-07T23:00:00Z' }, false],
    ['an instant expiry later today', { valid_until: '2026-09-07T23:00:00Z' }, true],
    // Whole-day semantics for the date-only form — the control that a naive
    // "parse as midnight" fix breaks.
    ['a date-only expiry of TODAY is still valid all day', { valid_until: '2026-09-07' }, true],
    ['a date-only start of tomorrow', { valid_from: '2026-09-08' }, false],
    ['no window at all', {}, true],
  ])('%s', (_name, temporal, expected) => {
    expect(isCurrentlyValid(temporal as never, NOON)).toBe(expected)
  })

  it('compares equivalent instants written with different offsets as equal', () => {
    // 2026-09-07T12:00:00Z === 14:00+02:00 === 07:00-05:00. Lexically these
    // three sort differently; as instants they are the same moment.
    for (const at of ['2026-09-07T13:00:00Z', '2026-09-07T15:00:00+02:00', '2026-09-07T08:00:00-05:00']) {
      expect(isNotYetValid({ valid_from: at } as never, NOON), at).toBe(true)
      expect(isExpired({ valid_until: at } as never, NOON), at).toBe(false)
    }
  })

  it('treats the boundary instant as still included', () => {
    const at = '2026-09-07T12:00:00Z'
    // valid_from exactly now: reached, not "not yet".
    expect(isNotYetValid({ valid_from: at } as never, NOON)).toBe(false)
    // valid_until exactly now: the last instant it covers, so not yet expired.
    expect(isExpired({ valid_until: at } as never, NOON)).toBe(false)
    expect(isExpired({ valid_until: at } as never, NOON + 1)).toBe(true)
  })

  it('applies the same bound to the grace window as to expiry', () => {
    // Expired 10 days ago: inside a 30-day grace, outside a 5-day one. If the
    // two used different interpretations, soft mode could disagree with hard
    // mode about when something lapsed.
    const t = { valid_until: '2026-08-28T12:00:00Z' } as never
    expect(isExpired(t, NOON)).toBe(true)
    expect(isExpiredBeyondGrace(t, NOON, 30)).toBe(false)
    expect(isExpiredBeyondGrace(t, NOON, 5)).toBe(true)
  })

  it('pins a zone-less timestamp to UTC, in any timezone (#1157)', () => {
    // Asserted on the MECHANISM, not on behaviour, and deliberately so: the
    // behavioural test below can only tell the difference when the host is not
    // on UTC, and CI is on UTC. Left to that test alone, a reintroduction of
    // this bug would ship green.
    expect(pinToUtc('2026-09-07T11:00:00')).toBe('2026-09-07T11:00:00Z')
    expect(pinToUtc('2026-09-07T11:00:00.500')).toBe('2026-09-07T11:00:00.500Z')
    // Already zoned — must be left exactly as it is.
    for (const zoned of [
      '2026-09-07T11:00:00Z', '2026-09-07T11:00:00z',
      '2026-09-07T11:00:00+02:00', '2026-09-07T11:00:00-05:00', '2026-09-07T11:00:00+0200',
    ]) {
      expect(pinToUtc(zoned), zoned).toBe(zoned)
    }
  })

  it('reads a zone-less timestamp as UTC, not as host-local time (#1157)', () => {
    // `Date.parse('2026-09-07T13:00:00')` resolves in the HOST's timezone, so
    // the same stored engram would expire at different moments on different
    // machines and a team sharing a store would disagree about which rules are
    // live. TemporalSchema accepts any string and salvageRemoteRow copies
    // server values verbatim, so naive timestamps do reach here.
    //
    // Asserted as an EQUIVALENCE to the explicit-Z form rather than against a
    // hardcoded instant, so the test means the same thing in every timezone
    // this suite runs in — including CI, which is UTC and would let the bug
    // pass a naive assertion.
    for (const [naive, zoned] of [
      ['2026-09-07T13:00:00', '2026-09-07T13:00:00Z'],
      ['2026-09-07T11:00:00', '2026-09-07T11:00:00Z'],
      ['2026-09-07T13:00:00.500', '2026-09-07T13:00:00.500Z'],
    ]) {
      expect(isNotYetValid({ valid_from: naive } as never, NOON), naive)
        .toBe(isNotYetValid({ valid_from: zoned } as never, NOON))
      expect(isExpired({ valid_until: naive } as never, NOON), naive)
        .toBe(isExpired({ valid_until: zoned } as never, NOON))
    }
  })

  it('still honours an explicit offset rather than overriding it', () => {
    // The guard must not blanket-append Z to values that already name a zone.
    expect(isNotYetValid({ valid_from: '2026-09-07T15:00:00+02:00' } as never, NOON)).toBe(true)
    expect(isNotYetValid({ valid_from: '2026-09-07T15:00:00+0200' } as never, NOON)).toBe(true)
    expect(isNotYetValid({ valid_from: '2026-09-07T08:00:00-05:00' } as never, NOON)).toBe(true)
  })

  it('treats an unparseable bound as absent rather than as hiding the engram', () => {
    expect(isCurrentlyValid({ valid_from: 'not-a-date' } as never, NOON)).toBe(true)
    expect(isCurrentlyValid({ valid_until: 'not-a-date' } as never, NOON)).toBe(true)
  })
})

/**
 * The same question under a host that is NOT on UTC (#1157).
 *
 * Node re-reads `process.env.TZ` for each `Date` operation, so the timezone can
 * be pinned for the duration of a test rather than only via the runner's
 * environment. Worth doing explicitly: CI runs on UTC, where a naive timestamp
 * and its explicit-Z twin are indistinguishable and every assertion below would
 * pass with the defect present.
 */
describe('validity is host-timezone independent (#1157)', () => {
  const REAL_TZ = process.env.TZ

  afterEach(() => {
    if (REAL_TZ === undefined) delete process.env.TZ
    else process.env.TZ = REAL_TZ
  })

  it.each(['America/New_York', 'Asia/Tokyo', 'Pacific/Kiritimati', 'UTC'])(
    'decides the same way in %s', (tz) => {
      process.env.TZ = tz
      // Sanity: the offset really did change for at least the non-UTC zones,
      // so a green run cannot mean "TZ was ignored".
      const shifted = new Date('2026-09-07T13:00:00').toISOString()
      if (tz !== 'UTC') expect(shifted, tz).not.toBe('2026-09-07T13:00:00.000Z')

      // 11:00 is the discriminating hour: it sits before NOON in UTC and after
      // it in the western zones, so a host-local reading flips the answer.
      expect(isNotYetValid({ valid_from: '2026-09-07T11:00:00' } as never, NOON), tz).toBe(false)
      expect(isExpired({ valid_until: '2026-09-07T11:00:00' } as never, NOON), tz).toBe(true)
      expect(isNotYetValid({ valid_from: '2026-09-07T13:00:00' } as never, NOON), tz).toBe(true)
      expect(isExpired({ valid_until: '2026-09-07T13:00:00' } as never, NOON), tz).toBe(false)
    },
  )
})

describe('list(), recall() and injection agree, at instant granularity (#1150)', () => {
  let dir: string
  let plur: Plur

  const engram = (id: string, temporal: Record<string, string>) => EngramSchema.parse({
    id, statement: `Audit policy ${id} applies to the release.`,
    type: 'behavioral', scope: 'global', status: 'active', pinned: true,
    temporal: { learned_at: '2026-09-06T00:00:00Z', ...temporal },
  })

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(NOON)
    dir = mkdtempSync(join(tmpdir(), 'plur-validity-'))
    writeFileSync(join(dir, 'engrams.yaml'), JSON.stringify({
      engrams: [
        engram('ENG-active-instant', { valid_from: '2026-09-07T01:00:00Z' }),
        engram('ENG-expired-instant', { valid_until: '2026-09-07T01:00:00Z' }),
        engram('ENG-active-date-control', { valid_from: '2026-09-07' }),
        engram('ENG-expired-date-control', { valid_until: '2026-09-06' }),
      ],
    }) + '\n')
    writeFileSync(join(dir, 'config.yaml'), 'backend: yaml\n')
    plur = new Plur({ path: dir, autoDiscover: false })
    await plur.ready()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  /** What every path should agree on at 2026-09-07T12:00:00Z. */
  const EXPECTED = ['ENG-active-date-control', 'ENG-active-instant']

  it('list() hides the expired instant and shows the active one', async () => {
    expect((await plur.list()).map(e => e.id).sort()).toEqual(EXPECTED)
  })

  it('recall() agrees with list()', async () => {
    expect((await plur.recall('audit policy release')).map(e => e.id).sort()).toEqual(EXPECTED)
  })

  it('injection agrees, in hard-expiry mode', async () => {
    const stored = await plur.list({ include_expired: true })
    expect(stored, 'all four are stored — this is filtering, not ingestion').toHaveLength(4)
    const r = selectAndSpread(
      { prompt: 'audit policy release', maxTokens: 8000 },
      stored, [], { expiry: { mode: 'hard' } } as never,
    )
    const ids = [...r.directives, ...r.constraints, ...r.consider].map(e => e.id).sort()
    // The one that mattered: an instruction that lapsed at 01:00 was reaching
    // the agent's context at noon, indistinguishable from a current rule.
    expect(ids).not.toContain('ENG-expired-instant')
    expect(ids).toContain('ENG-active-instant')
  })
})
