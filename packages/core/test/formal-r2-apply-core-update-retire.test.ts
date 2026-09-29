/**
 * Coordinator item (owner principle "every removal is explicit", 2026-09-27):
 * an `updateEngram` that changes a row's status from non-retired to `retired`
 * appends an `engram_retired` history event (same shape as forget's:
 * event, engram_id, timestamp, data { reason, via: 'update' }).
 *
 * Found via `plur_validate_meta`: meta/validation.ts sets a failing
 * meta-engram to `retired` and the MCP handler persists it with updateEngram —
 * the engram disappeared with no history event. No event when the status was
 * already retired or does not change. No network.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Plur } from '../src/index.js'
import { readHistoryForEngram } from '../src/history.js'

describe('updateEngram records a retirement it performs', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-r2apply-upd-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const retiredEvents = (plur: Plur, id: string) =>
    readHistoryForEngram(plur.getStorageRoot(), id).filter(e => e.event === 'engram_retired')

  it('active → retired via updateEngram appends engram_retired (via: update)', async () => {
    const plur = new Plur({ path: dir })
    const e = await plur.learn('A meta pattern that later fails validation', { scope: 'global' })
    const stored = (await plur.getById(e.id))!
    expect(await plur.updateEngram({ ...stored, status: 'retired' })).toBe(true)
    const ev = retiredEvents(plur, e.id)
    expect(ev).toHaveLength(1)
    expect(ev[0].engram_id).toBe(e.id)
    expect(ev[0].data.via).toBe('update')
    expect('reason' in ev[0].data).toBe(true)
    expect(typeof ev[0].timestamp).toBe('string')
  })

  it('no event when the status does not change, or was already retired', async () => {
    const plur = new Plur({ path: dir })
    const e = await plur.learn('A statement edited in place', { scope: 'global' })
    const stored = (await plur.getById(e.id))!
    await plur.updateEngram({ ...stored, statement: 'A statement edited in place, twice' })
    expect(retiredEvents(plur, e.id)).toHaveLength(0)
    await plur.updateEngram({ ...stored, status: 'retired' })
    const retired = (await plur.list({ include_retired: true } as any)).find(x => x.id === e.id) ?? { ...stored, status: 'retired' as const }
    await plur.updateEngram({ ...retired, status: 'retired', statement: 'still retired' })
    expect(retiredEvents(plur, e.id)).toHaveLength(1)
  })
})
