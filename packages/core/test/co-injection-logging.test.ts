import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Plur } from '../src/index.js'
import {
  appendHistory,
  readHistory,
  computeQueryHash,
  generateInjectionId,
  findLatestInjectionFor,
  countInjectionEvents,
} from '../src/history.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plur-coinject-'))
}

const thisMonth = () => new Date().toISOString().slice(0, 7)

describe('co-injection helpers (#452)', () => {
  let dir: string

  beforeEach(() => { dir = tmpDir() })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  describe('computeQueryHash', () => {
    it('is stable for the same query', () => {
      expect(computeQueryHash('deploy the trading bot')).toBe(computeQueryHash('deploy the trading bot'))
    })

    it('normalizes case and whitespace', () => {
      expect(computeQueryHash('Deploy  the\tTrading   bot ')).toBe(computeQueryHash('deploy the trading bot'))
    })

    it('differs for different queries', () => {
      expect(computeQueryHash('deploy the bot')).not.toBe(computeQueryHash('write the tests'))
    })

    it('is a compact 16-char hex digest', () => {
      expect(computeQueryHash('anything')).toMatch(/^[0-9a-f]{16}$/)
    })
  })

  describe('generateInjectionId', () => {
    it('uses the INJ- prefix', () => {
      expect(generateInjectionId()).toMatch(/^INJ-\d+-[a-z0-9]{4,}-[a-z0-9]{2}$/)
    })

    it('generates unique ids', () => {
      const ids = new Set(Array.from({ length: 50 }, () => generateInjectionId()))
      expect(ids.size).toBe(50)
    })
  })

  describe('findLatestInjectionFor', () => {
    const earlier = new Date(Date.now() - 60_000).toISOString()
    const later = new Date().toISOString()

    it('returns null when there is no history', () => {
      expect(findLatestInjectionFor(dir, 'ENG-X')).toBeNull()
    })

    it('finds the latest co_injection containing the engram', () => {
      appendHistory(dir, {
        event: 'co_injection',
        engram_id: 'INJ-1-aaaa',
        timestamp: earlier,
        data: { ids: ['ENG-A', 'ENG-B'], query_hash: 'abc' },
      })
      appendHistory(dir, {
        event: 'co_injection',
        engram_id: 'INJ-2-bbbb',
        timestamp: later,
        data: { ids: ['ENG-A', 'ENG-C'], query_hash: 'def' },
      })
      const hit = findLatestInjectionFor(dir, 'ENG-A')
      expect(hit).not.toBeNull()
      expect(hit!.injection_id).toBe('INJ-2-bbbb')
      const bHit = findLatestInjectionFor(dir, 'ENG-B')
      expect(bHit!.injection_id).toBe('INJ-1-aaaa')
    })

    it('returns null for an engram never injected', () => {
      appendHistory(dir, {
        event: 'co_injection',
        engram_id: 'INJ-1-aaaa',
        timestamp: earlier,
        data: { ids: ['ENG-A'], query_hash: 'abc' },
      })
      expect(findLatestInjectionFor(dir, 'ENG-ZZZ')).toBeNull()
    })

    it('finds an injection from the previous calendar month (month-boundary feedback)', () => {
      // Feedback on the 1st for an injection late last month must still link.
      const now = new Date()
      const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString()
      appendHistory(dir, {
        event: 'co_injection',
        engram_id: 'INJ-prev-cccc',
        timestamp: prevMonth,
        data: { ids: ['ENG-PREV'], query_hash: 'prv' },
      })
      const hit = findLatestInjectionFor(dir, 'ENG-PREV')
      expect(hit).not.toBeNull()
      expect(hit!.injection_id).toBe('INJ-prev-cccc')
    })

    it('only scans the most recent calendar months (bounded read)', () => {
      appendHistory(dir, {
        event: 'co_injection',
        engram_id: 'INJ-old-aaaa',
        timestamp: '2025-01-01T08:00:00.000Z',
        data: { ids: ['ENG-OLD'], query_hash: 'old' },
      })
      appendHistory(dir, {
        event: 'co_injection',
        engram_id: 'INJ-new-bbbb',
        timestamp: later,
        data: { ids: ['ENG-NEW'], query_hash: 'new' },
      })
      // ENG-OLD's event is outside the 2-month scan window
      expect(findLatestInjectionFor(dir, 'ENG-OLD')).toBeNull()
      expect(findLatestInjectionFor(dir, 'ENG-NEW')).not.toBeNull()
    })
  })

  describe('countInjectionEvents', () => {
    it('returns zeros when there is no history', () => {
      expect(countInjectionEvents(dir)).toEqual({
        co_injection: 0,
        injection_outcome: 0,
        outcome_positive: 0,
        outcome_negative: 0,
      })
    })

    it('counts co_injection and injection_outcome events across months', () => {
      appendHistory(dir, {
        event: 'co_injection',
        engram_id: 'INJ-1-aaaa',
        timestamp: '2026-06-15T08:00:00.000Z',
        data: { ids: ['ENG-A', 'ENG-B'], query_hash: 'abc' },
      })
      appendHistory(dir, {
        event: 'co_injection',
        engram_id: 'INJ-2-bbbb',
        timestamp: '2026-07-01T08:00:00.000Z',
        data: { ids: ['ENG-A'], query_hash: 'def' },
      })
      appendHistory(dir, {
        event: 'injection_outcome',
        engram_id: 'ENG-A',
        timestamp: '2026-07-01T09:00:00.000Z',
        data: { injection_id: 'INJ-2-bbbb', signal: 'positive' },
      })
      appendHistory(dir, {
        event: 'injection_outcome',
        engram_id: 'ENG-B',
        timestamp: '2026-07-01T09:01:00.000Z',
        data: { injection_id: 'INJ-1-aaaa', signal: 'negative' },
      })
      // Unrelated lifecycle events must not be counted
      appendHistory(dir, {
        event: 'engram_created',
        engram_id: 'ENG-A',
        timestamp: '2026-07-01T07:00:00.000Z',
        data: {},
      })
      expect(countInjectionEvents(dir)).toEqual({
        co_injection: 2,
        injection_outcome: 2,
        outcome_positive: 1,
        outcome_negative: 1,
      })
    })
  })
})

describe('co-injection logging integration (#452)', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = tmpDir()
    plur = new Plur({ path: dir })
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('inject() logs a co_injection event with injected ids and query hash', () => {
    const a = plur.learn('Always use pnpm for package installation in this monorepo')
    const b = plur.learn('Run pnpm build before running package tests')
    const result = plur.inject('how do I run pnpm installation and build for a package')
    expect(result.injected_ids.length).toBeGreaterThanOrEqual(2)

    const events = readHistory(dir, thisMonth()).filter(e => e.event === 'co_injection')
    expect(events.length).toBe(1)
    const ev = events[0]
    expect(ev.engram_id).toMatch(/^INJ-/)
    expect(ev.data.ids).toEqual(result.injected_ids)
    expect((ev.data.ids as string[])).toContain(a.id)
    expect((ev.data.ids as string[])).toContain(b.id)
    expect(ev.data.query_hash).toBe(computeQueryHash('how do I run pnpm installation and build for a package'))
    expect(ev.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // Compact: IDs only, no statements
    expect(JSON.stringify(ev)).not.toContain('Always use pnpm')
  })

  it('inject() with no matches logs no co_injection event', () => {
    plur.learn('Always use pnpm for package installation in this monorepo')
    const result = plur.inject('zzz qqq xyzzy')
    expect(result.injected_ids.length).toBe(0)
    const events = readHistory(dir, thisMonth()).filter(e => e.event === 'co_injection')
    expect(events.length).toBe(0)
  })

  it('feedback on an injected engram logs injection_outcome linked to the injection', async () => {
    const a = plur.learn('Always use pnpm for package installation in this monorepo')
    plur.inject('how do I run pnpm installation for a package')
    const coEvents = readHistory(dir, thisMonth()).filter(e => e.event === 'co_injection')
    expect(coEvents.length).toBe(1)
    const injectionId = coEvents[0].engram_id

    await plur.feedback(a.id, 'positive')

    const outcomes = readHistory(dir, thisMonth()).filter(e => e.event === 'injection_outcome')
    expect(outcomes.length).toBe(1)
    expect(outcomes[0].engram_id).toBe(a.id)
    expect(outcomes[0].data.injection_id).toBe(injectionId)
    expect(outcomes[0].data.signal).toBe('positive')
  })

  it('negative feedback logs a negative injection_outcome', async () => {
    const a = plur.learn('Always use pnpm for package installation in this monorepo')
    plur.inject('how do I run pnpm installation for a package')
    await plur.feedback(a.id, 'negative')
    const outcomes = readHistory(dir, thisMonth()).filter(e => e.event === 'injection_outcome')
    expect(outcomes.length).toBe(1)
    expect(outcomes[0].data.signal).toBe('negative')
  })

  it('neutral feedback logs no injection_outcome (ignored = absence)', async () => {
    const a = plur.learn('Always use pnpm for package installation in this monorepo')
    plur.inject('how do I run pnpm installation for a package')
    await plur.feedback(a.id, 'neutral')
    const outcomes = readHistory(dir, thisMonth()).filter(e => e.event === 'injection_outcome')
    expect(outcomes.length).toBe(0)
  })

  it('feedback on a never-injected engram logs no injection_outcome', async () => {
    const a = plur.learn('Always use pnpm for package installation in this monorepo')
    await plur.feedback(a.id, 'positive')
    const outcomes = readHistory(dir, thisMonth()).filter(e => e.event === 'injection_outcome')
    expect(outcomes.length).toBe(0)
  })

  it('links feedback to injections from a previous process via history scan', async () => {
    const a = plur.learn('Always use pnpm for package installation in this monorepo')
    plur.inject('how do I run pnpm installation for a package')
    const injectionId = readHistory(dir, thisMonth())
      .filter(e => e.event === 'co_injection')[0].engram_id

    // Fresh instance = fresh process, no in-memory link
    const plur2 = new Plur({ path: dir })
    await plur2.feedback(a.id, 'positive')

    const outcomes = readHistory(dir, thisMonth()).filter(e => e.event === 'injection_outcome')
    expect(outcomes.length).toBe(1)
    expect(outcomes[0].data.injection_id).toBe(injectionId)
  })

  it('repeated injections update the outcome link to the most recent injection', async () => {
    const a = plur.learn('Always use pnpm for package installation in this monorepo')
    plur.inject('how do I run pnpm installation for a package')
    plur.inject('pnpm installation again please')
    const coEvents = readHistory(dir, thisMonth()).filter(e => e.event === 'co_injection')
    expect(coEvents.length).toBe(2)

    await plur.feedback(a.id, 'positive')
    const outcomes = readHistory(dir, thisMonth()).filter(e => e.event === 'injection_outcome')
    expect(outcomes.length).toBe(1)
    expect(outcomes[0].data.injection_id).toBe(coEvents[1].engram_id)
  })

  it('status() surfaces injection event and label counts', async () => {
    const a = plur.learn('Always use pnpm for package installation in this monorepo')
    plur.inject('how do I run pnpm installation for a package')
    await plur.feedback(a.id, 'positive')

    const status = plur.status()
    expect(status.history_events).toEqual({
      co_injection: 1,
      injection_outcome: 1,
      outcome_positive: 1,
      outcome_negative: 0,
    })
  })

  it('size guard: events stay compact (IDs, not statements)', () => {
    // Representative co_injection at typical injection width (~20 engrams)
    const ids = Array.from({ length: 20 }, (_, i) => `ENG-2026-0702-${String(i).padStart(3, '0')}`)
    const coEvent = {
      event: 'co_injection',
      engram_id: generateInjectionId(),
      timestamp: new Date().toISOString(),
      data: { ids, query_hash: computeQueryHash('a representative task string'), scope: 'project:plur' },
    }
    const outcomeEvent = {
      event: 'injection_outcome',
      engram_id: 'ENG-2026-0702-001',
      timestamp: new Date().toISOString(),
      data: { injection_id: coEvent.engram_id, signal: 'positive' },
    }
    const coBytes = Buffer.byteLength(JSON.stringify(coEvent) + '\n')
    const outcomeBytes = Buffer.byteLength(JSON.stringify(outcomeEvent) + '\n')
    // eslint-disable-next-line no-console
    console.log(`[size-guard] co_injection (20 ids): ${coBytes} B; injection_outcome: ${outcomeBytes} B`)
    expect(coBytes).toBeLessThan(700)
    expect(outcomeBytes).toBeLessThan(250)
  })
})
