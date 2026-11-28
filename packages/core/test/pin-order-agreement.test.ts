/**
 * D3 (overhaul): `plur pins` (the fit report) and unified injection order
 * pins of equal priority the same way — pin-policy's comparePinTiebreak:
 * prohibitions first, then oldest first, then id — so the pins the report
 * says do not fit are exactly the pins unified injection leaves out.
 *
 * The fixture has no priorities, mixes prohibitions with directives, and
 * includes pins without created_at (sorted first by the tiebreak) and with
 * only temporal.learned_at, where an injection-local order used to differ.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { comparePinTiebreak } from '../src/pin-policy.js'
import { EngramSchema, type Engram } from '../src/schemas/engram.js'
import { writeFixtureStore } from './helpers/injection-fixture.js'

const LONG = 'before any release step describe the deployment target, the rollback path, the owner and the change window in the ticket'

function pin(id: string, statement: string, extra: Record<string, unknown> = {}): Engram {
  return {
    ...(EngramSchema.parse({
      id, statement, type: 'behavioral', scope: 'global', status: 'active', version: 2, tags: [], pinned: true,
      activation: { retrieval_strength: 0.9, storage_strength: 1, frequency: 1, last_accessed: '2026-01-02' },
    }) as Engram),
    ...extra,
  } as Engram
}

const PINS: Engram[] = [
  pin('ENG-2026-0105-001', `Always ${LONG}`, { created_at: '2026-01-05T00:00:00.000Z' }),
  pin('ENG-2026-0101-002', `Never skip this: ${LONG}`, { created_at: '2026-01-01T00:00:00.000Z' }),
  pin('ENG-2026-0103-003', `Always ${LONG} (copy three)`, { created_at: '2026-01-03T00:00:00.000Z' }),
  pin('ENG-2026-0102-004', `Do not ${LONG.replace('before', 'forget, before')}`, { created_at: '2026-01-09T00:00:00.000Z' }),
  pin('ENG-2026-0104-005', `Always ${LONG} (no created_at)`),
  pin('ENG-2026-0106-006', `Always ${LONG} (learned_at only)`, { temporal: { learned_at: '2025-06-01' } }),
  pin('ENG-2026-0107-007', `Always ${LONG} (copy seven)`, { created_at: '2026-01-07T00:00:00.000Z' }),
]

describe('pin tie-break: plur pins and unified injection agree (D3)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-pin-order-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('the fit report\'s overflow is exactly what unified injection leaves out', async () => {
    const budget = 340
    writeFixtureStore(dir, PINS, `index: false\nembeddings:\n  enabled: false\ninjection_budget: ${budget}\ninjection:\n  mode: unified\n`)
    const plur = new Plur({ path: dir, autoDiscover: false })

    const report = await plur.pinFitReport()
    expect(report.budget).toBe(budget)
    const reportOut = report.entries.filter(e => !e.fits).map(e => e.id).sort()
    const reportIn = report.entries.filter(e => e.fits).map(e => e.id).sort()
    // The fixture must actually overflow, and keep some pins, to test anything.
    expect(reportOut.length).toBeGreaterThan(0)
    expect(reportIn.length).toBeGreaterThan(0)

    const result = await plur.inject('an unrelated question about cooking pasta')
    const injectedPins = result.injected_ids.filter(id => PINS.some(p => p.id === id)).sort()
    const omitted = (result.omitted_pinned ?? []).map(o => o.id).sort()
    expect(injectedPins).toEqual(reportIn)
    expect(omitted).toEqual(reportOut)

    // And the order kept is the tiebreak's: the first pins by comparePinTiebreak load.
    const order = [...PINS].sort(comparePinTiebreak).map(p => p.id)
    expect(order.slice(0, reportIn.length).sort()).toEqual(reportIn)
  })
})
