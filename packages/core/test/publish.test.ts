/**
 * Publish filter + sensitive-content scan — the guard that lets a public
 * engrams.yaml ship safely after the 2026-06 leak. Tests use the actual shapes
 * that leaked (prod droplet IPs, an internal staging host with basic-auth) to
 * prove the scan would now catch them, plus the mistag case (visibility=public
 * but sensitive content) that the visibility tag alone missed.
 */
import { describe, it, expect } from 'vitest'
import { detectSensitive, detectSecrets } from '../src/secrets.js'
import { filterPublishable } from '../src/publish.js'

const eng = (over: Record<string, unknown>) => ({
  id: 'ENG-test-0001',
  statement: 'a harmless public fact',
  visibility: 'public',
  ...over,
}) as never

describe('detectSensitive — infra topology beyond detectSecrets', () => {
  it('flags a public droplet IP (the leak shape) that detectSecrets misses', () => {
    const text = 'deploy target is 139.59.155.82'
    expect(detectSecrets(text)).toHaveLength(0)               // old scanner: clean
    expect(detectSensitive(text).map(m => m.pattern)).toContain('public_ipv4') // new: caught
  })

  it('does NOT flag private / loopback / documentation IPs', () => {
    for (const ip of ['10.0.0.1', '192.168.1.10', '127.0.0.1', '172.16.0.5', '203.0.113.9']) {
      expect(detectSensitive(`host at ${ip}`)).toHaveLength(0)
    }
  })

  it('flags a basic-auth URL (internal staging host with creds)', () => {
    expect(detectSensitive('https://team:hunter2@hub-staging.plur.ai/api').map(m => m.pattern))
      .toContain('basic_auth_url')
  })

  it('flags FQDN:port and IPv4:port topology', () => {
    expect(detectSensitive('reach it at hub-staging.plur.ai:443').map(m => m.pattern)).toContain('fqdn_port')
    expect(detectSensitive('dashboard on 139.59.155.82:8877').map(m => m.pattern)).toContain('ipv4_port')
  })

  it('still inherits all detectSecrets patterns', () => {
    expect(detectSensitive('Bearer abcdefghijklmnopqrstuvwxyz123').map(m => m.pattern)).toContain('bearer_token')
    expect(detectSensitive('password = supersecret123').map(m => m.pattern)).toContain('password_assignment')
  })

  it('returns [] for genuinely clean public text', () => {
    expect(detectSensitive('SKILL.md is the canonical pack format; the body is a description.')).toHaveLength(0)
  })
})

describe('filterPublishable — two-gate (visibility AND content)', () => {
  it('ships a public, content-clean engram', () => {
    const { publishable, rejected } = filterPublishable([eng({ id: 'ENG-ok-1' })])
    expect(publishable.map(e => (e as { id: string }).id)).toEqual(['ENG-ok-1'])
    expect(rejected).toHaveLength(0)
  })

  it('holds back a private engram (gate 1)', () => {
    const { publishable, rejected } = filterPublishable([eng({ id: 'ENG-priv', visibility: 'private' })])
    expect(publishable).toHaveLength(0)
    expect(rejected[0].reasons.join()).toMatch(/not public/)
    expect(rejected[0].mistagged).toBe(false)
  })

  it('holds back a PUBLIC-tagged engram with sensitive content, and flags the mistag (gate 2)', () => {
    const leaky = eng({ id: 'ENG-leak', visibility: 'public', statement: 'prod droplet 139.59.155.82, auth https://t:p@hub-staging.plur.ai' })
    const { publishable, rejected } = filterPublishable([leaky])
    expect(publishable).toHaveLength(0)                  // NOT shipped despite public tag
    expect(rejected[0].mistagged).toBe(true)             // surfaced as a mistag
    expect(rejected[0].reasons.join()).toMatch(/content scan/)
  })

  it('is deterministic — publishable sorted by id', () => {
    const { publishable } = filterPublishable([eng({ id: 'ENG-c' }), eng({ id: 'ENG-a' }), eng({ id: 'ENG-b' })])
    expect(publishable.map(e => (e as { id: string }).id)).toEqual(['ENG-a', 'ENG-b', 'ENG-c'])
  })
})
