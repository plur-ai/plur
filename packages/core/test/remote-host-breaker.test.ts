import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  RemoteStore,
  markRemoteHostDown,
  remoteHostDownRemainingMs,
  clearRemoteHostDown,
  _resetRemoteHostBreaker,
  salvageRemoteRow,
} from '../src/store/remote-store.js'

/**
 * #1069 (host-level failure breaker) and the schema-drift salvage — both born
 * from one production morning: a config with NINE store entries on one dead
 * host paid nine connect timeouts per process inside plur_session_start, and
 * a reachable enterprise host served ~100 engrams a stricter client schema
 * dropped wholesale over one drifted enum value.
 */

describe('remote host breaker (#1069)', () => {
  beforeEach(_resetRemoteHostBreaker)
  afterEach(_resetRemoteHostBreaker)

  it('marks a host down and reports remaining cooldown', () => {
    expect(remoteHostDownRemainingMs('https://dead.example.com/sse')).toBe(0)
    markRemoteHostDown('https://dead.example.com/sse')
    expect(remoteHostDownRemainingMs('https://dead.example.com/sse')).toBeGreaterThan(0)
  })

  it('is keyed on the ORIGIN — every spelling and every scope entry shares the verdict', () => {
    markRemoteHostDown('https://dead.example.com/sse')
    expect(remoteHostDownRemainingMs('https://dead.example.com')).toBeGreaterThan(0)
    expect(remoteHostDownRemainingMs('https://dead.example.com/sse/')).toBeGreaterThan(0)
    // A different host is unaffected.
    expect(remoteHostDownRemainingMs('https://alive.example.com/sse')).toBe(0)
  })

  it('expires after the cooldown so a recovered host gets re-probed', () => {
    markRemoteHostDown('https://dead.example.com/sse', Date.now() - 120_000)
    expect(remoteHostDownRemainingMs('https://dead.example.com/sse')).toBe(0)
  })

  it('a network-level success clears the mark early — writes/retries are the recovery probe', () => {
    markRemoteHostDown('https://dead.example.com/sse')
    clearRemoteHostDown('https://dead.example.com/sse')
    expect(remoteHostDownRemainingMs('https://dead.example.com/sse')).toBe(0)
  })

  it('one network failure makes sibling stores on the same host fast-fail', async () => {
    // Port 9 (discard) on localhost: connection refused, immediately — a real
    // network-level failure without a real timeout in the suite.
    const a = new RemoteStore('http://127.0.0.1:9/sse', 'tok', 'group:x/a')
    const first = await a.load()
    expect(first).toEqual([])
    expect(remoteHostDownRemainingMs('http://127.0.0.1:9/sse')).toBeGreaterThan(0)

    // Sibling store, same host, different scope: must not attempt the network
    // at all — measured as returning immediately.
    const b = new RemoteStore('http://127.0.0.1:9/sse', 'tok', 'group:x/b')
    const t0 = Date.now()
    expect(await b.load()).toEqual([])
    expect(Date.now() - t0).toBeLessThan(500)
  })
})

describe('salvageRemoteRow — schema-drift tolerance', () => {
  const valid = {
    id: 'ENG-2026-08-28-001',
    scope: 'group:acme/eng',
    status: 'active',
    statement: 'deploys go out on tuesdays',
  }

  it('passes a valid row through untouched', () => {
    const out = salvageRemoteRow({ ...valid, commitment: 'decided' })
    expect(out).not.toBeNull()
    expect(out!.salvagedFields).toEqual([])
    expect(out!.data.commitment).toBe('decided')
  })

  it('keeps an engram whose only fault is a drifted enum, minus that field — the live 2026-08-28 case', () => {
    const out = salvageRemoteRow({ ...valid, commitment: 'ratified-by-council' })
    expect(out).not.toBeNull()
    expect(out!.salvagedFields).toEqual(['commitment'])
    expect(out!.data.statement).toBe(valid.statement)
    expect(out!.data).not.toHaveProperty('commitment')
  })

  it('salvages multiple drifted fields in one pass', () => {
    const out = salvageRemoteRow({ ...valid, commitment: 'nope', visibility: 'org-only' })
    expect(out).not.toBeNull()
    expect(out!.salvagedFields).toEqual(['commitment', 'visibility'])
  })

  it('cannot resurrect a genuinely malformed row — a required field stays required', () => {
    expect(salvageRemoteRow({ id: 'ENG-2026-08-28-002', scope: 'g', status: 'active' })).toBeNull()
    expect(salvageRemoteRow({ ...valid, statement: '' })).toBeNull()
    expect(salvageRemoteRow({ ...valid, id: 'not-an-engram-id' })).toBeNull()
  })
})
