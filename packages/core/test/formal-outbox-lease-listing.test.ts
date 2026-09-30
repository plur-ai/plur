/**
 * Decision D2 follow-up (2026-09-27): a leased outbox row that is not being
 * flushed must be explainable — listOutbox() reports until when another
 * process holds it (`leased_until`), never the holder id (pid + uuid).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-lease-list-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function row(id: string, sd: Record<string, unknown>) {
  return {
    id, statement: `queued ${id}`, type: 'behavioral', scope: 'group:acme/eng', status: 'active',
    visibility: 'public', structured_data: sd,
  }
}

describe('listOutbox shows who is holding a row only as an expiry', () => {
  it('a leased push reports leased_until; an unleased one does not', async () => {
    const until = new Date(Date.now() + 5 * 60_000).toISOString()
    const outbox = { target_scope: 'group:acme/eng', queued_at: new Date().toISOString(), attempt_count: 1 }
    writeFileSync(join(dir, 'config.yaml'), 'index: false\n')
    writeFileSync(join(dir, 'engrams.yaml'), yaml.dump({ engrams: [
      row('ENG-2026-09-27-001', { _outbox: outbox, _outboxLease: { holder: 'p1-uuid', expires_at: until } }),
      row('ENG-2026-09-27-002', { _outbox: outbox }),
    ] }))
    const list = await new Plur({ path: dir }).listOutbox()
    const by = Object.fromEntries(list.map(e => [e.id, e as Record<string, unknown>]))
    expect(by['ENG-2026-09-27-001'].leased_until).toBe(until)
    expect(by['ENG-2026-09-27-002'].leased_until).toBeUndefined()
    expect(JSON.stringify(list)).not.toContain('p1-uuid')
  })

  it('an expired lease is not reported (the row is free to flush)', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    writeFileSync(join(dir, 'config.yaml'), 'index: false\n')
    writeFileSync(join(dir, 'engrams.yaml'), yaml.dump({ engrams: [
      row('ENG-2026-09-27-003', { _outbox: { target_scope: 'group:acme/eng', queued_at: new Date().toISOString() }, _outboxLease: { holder: 'p2', expires_at: past } }),
    ] }))
    const [e] = await new Plur({ path: dir }).listOutbox()
    expect((e as Record<string, unknown>).leased_until).toBeUndefined()
  })
})
