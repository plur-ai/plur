import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  recordEvent,
  getCounters,
  resetCounters,
  type CountersOpts,
} from '../src/telemetry-counters.js'

function newDir(): string {
  return mkdtempSync(join(tmpdir(), 'plur-counters-'))
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

describe('telemetry counters (#51 slice D-2a)', () => {
  let dir: string
  let countersPath: string
  let installIdPath: string
  let configPath: string

  beforeEach(() => {
    dir = newDir()
    countersPath = join(dir, 'counters.json')
    installIdPath = join(dir, 'install-id')
    configPath = join(dir, 'telemetry.json')
  })

  function offOpts(extra: Partial<CountersOpts> = {}): CountersOpts {
    return { env: {}, configPath, countersPath, installIdPath, ...extra }
  }

  function onOpts(extra: Partial<CountersOpts> = {}): CountersOpts {
    return { env: { PLUR_TELEMETRY: 'on' }, configPath, countersPath, installIdPath, ...extra }
  }

  it('default-off install touches zero files (recordEvent)', () => {
    recordEvent('learn', offOpts())
    recordEvent('recall', offOpts())
    recordEvent('session', offOpts())
    expect(readdirSync(dir)).toEqual([])
  })

  it('default-off install touches zero files (getCounters / resetCounters return null)', () => {
    expect(getCounters(offOpts())).toBeNull()
    expect(resetCounters(offOpts())).toBeNull()
    expect(readdirSync(dir)).toEqual([])
  })

  it('env-on fresh install: recordEvent("learn") creates both files', () => {
    const fixedNow = () => new Date('2026-05-02T18:00:00Z')
    recordEvent('learn', onOpts({ now: fixedNow }))

    expect(existsSync(installIdPath)).toBe(true)
    expect(existsSync(countersPath)).toBe(true)
    const installId = readFileSync(installIdPath, 'utf8')
    expect(installId).toMatch(UUID_V4)

    const counters = JSON.parse(readFileSync(countersPath, 'utf8'))
    expect(counters).toEqual({ date: '2026-05-02', learn: 1, recall: 0, session: 1 })
  })

  it('env-on repeated events accumulate without re-counting session', () => {
    const fixedNow = () => new Date('2026-05-02T18:00:00Z')
    const opts = onOpts({ now: fixedNow })
    recordEvent('learn', opts)
    recordEvent('learn', opts)
    recordEvent('learn', opts)
    recordEvent('recall', opts)
    recordEvent('recall', opts)

    const counters = JSON.parse(readFileSync(countersPath, 'utf8'))
    expect(counters).toEqual({ date: '2026-05-02', learn: 3, recall: 2, session: 1 })
  })

  it('env-on day rollover resets counters and re-arms session on next learn', () => {
    writeFileSync(
      countersPath,
      JSON.stringify({ date: '2026-05-01', learn: 5, recall: 2, session: 1 }),
    )
    const fixedNow = () => new Date('2026-05-02T00:30:00Z')
    recordEvent('learn', onOpts({ now: fixedNow }))

    const counters = JSON.parse(readFileSync(countersPath, 'utf8'))
    expect(counters).toEqual({ date: '2026-05-02', learn: 1, recall: 0, session: 1 })
  })

  it('env-on malformed counters file: parse-fails treated as missing, fresh write', () => {
    writeFileSync(countersPath, '{ this is not json')
    const fixedNow = () => new Date('2026-05-02T18:00:00Z')
    recordEvent('learn', onOpts({ now: fixedNow }))

    const counters = JSON.parse(readFileSync(countersPath, 'utf8'))
    expect(counters).toEqual({ date: '2026-05-02', learn: 1, recall: 0, session: 1 })
  })

  it('env-on install-id stable across recordEvent calls', () => {
    const fixedNow = () => new Date('2026-05-02T18:00:00Z')
    const opts = onOpts({ now: fixedNow })
    recordEvent('learn', opts)
    const first = readFileSync(installIdPath, 'utf8')
    recordEvent('recall', opts)
    const second = readFileSync(installIdPath, 'utf8')

    expect(first).toMatch(UUID_V4)
    expect(second).toBe(first)
  })

  it('env-on stale .tmp file from prior crash does not poison next write', () => {
    const stale = `${countersPath}.tmp.999999`
    writeFileSync(stale, 'corrupt-half-written')
    const fixedNow = () => new Date('2026-05-02T18:00:00Z')
    recordEvent('learn', onOpts({ now: fixedNow }))

    const counters = JSON.parse(readFileSync(countersPath, 'utf8'))
    expect(counters).toEqual({ date: '2026-05-02', learn: 1, recall: 0, session: 1 })
  })

  it('getCounters returns snapshot with installId and current state', () => {
    const fixedNow = () => new Date('2026-05-02T18:00:00Z')
    const opts = onOpts({ now: fixedNow })
    recordEvent('learn', opts)
    recordEvent('learn', opts)

    const snap = getCounters(opts)
    expect(snap).not.toBeNull()
    expect(snap!.installId).toMatch(UUID_V4)
    expect(snap!.date).toBe('2026-05-02')
    expect(snap!.learn).toBe(2)
    expect(snap!.recall).toBe(0)
    expect(snap!.session).toBe(1)
  })

  it('resetCounters zeroes the file but preserves installId', () => {
    const fixedNow = () => new Date('2026-05-02T18:00:00Z')
    const opts = onOpts({ now: fixedNow })
    recordEvent('learn', opts)
    recordEvent('recall', opts)
    const installIdBefore = readFileSync(installIdPath, 'utf8')

    const after = resetCounters(opts)
    expect(after).not.toBeNull()
    expect(after!.learn).toBe(0)
    expect(after!.recall).toBe(0)
    expect(after!.session).toBe(0)
    expect(after!.date).toBe('2026-05-02')
    expect(after!.installId).toBe(installIdBefore)

    const installIdAfter = readFileSync(installIdPath, 'utf8')
    expect(installIdAfter).toBe(installIdBefore)
  })
})
