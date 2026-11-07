/**
 * The miss-signal query fingerprint cannot be confirmed by hashing a guess
 * (security audit 2026-11-06).
 *
 * It used to be a bare SHA-256 of the normalised query, so whoever reads the
 * received telemetry could hash a list of likely queries (a client name, a
 * deal term) and match them. It is now an HMAC under a per-install random key
 * that stays on this machine.
 *
 * fetch is injected in-process; no network.
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitMissSignal, type MissSignalInput } from '../src/telemetry-miss-signal.js'

function install() {
  const dir = mkdtempSync(join(tmpdir(), 'plur-miss-salt-'))
  return { dir, configPath: join(dir, 'telemetry.json'), installIdPath: join(dir, 'install-id') }
}

async function emit(inst: ReturnType<typeof install>, query: string): Promise<any> {
  let body: any = null
  const fakeFetch = (async (_url: string, init: any) => {
    body = JSON.parse(init.body)
    return { ok: true } as Response
  }) as unknown as typeof globalThis.fetch
  const input: MissSignalInput = { query, resultCount: 0, topScore: null }
  const sent = await emitMissSignal(input, {
    env: { PLUR_TELEMETRY: 'on' }, configPath: inst.configPath, installIdPath: inst.installIdPath,
    fetch: fakeFetch, endpoint: 'https://telemetry.example.invalid/miss',
  })
  expect(sent).toBe(true)
  return body
}

const unsalted = (q: string) => createHash('sha256').update(q.trim().toLowerCase().replace(/\s+/g, ' '), 'utf8').digest('hex')

describe('miss-signal fingerprint is keyed per install', () => {
  it('a guessed query hashed with plain SHA-256 does not match the wire fingerprint', async () => {
    const body = await emit(install(), 'Acme Corp   acquisition OFFER price')
    expect(body.query_fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(body.query_fingerprint).not.toBe(unsalted('acme corp acquisition offer price'))
  })

  it('two installs missing on the same query send different fingerprints', async () => {
    const a = await emit(install(), 'how do i deploy')
    const b = await emit(install(), 'how do i deploy')
    expect(a.query_fingerprint).not.toBe(b.query_fingerprint)
  })

  it('one install keeps a stable fingerprint for the same normalised query', async () => {
    const inst = install()
    const a = await emit(inst, 'How do I  deploy')
    const b = await emit(inst, 'how do i deploy')
    expect(a.query_fingerprint).toBe(b.query_fingerprint)
  })

  it('the key is kept owner-only on disk and never sent', async () => {
    const inst = install()
    const body = await emit(inst, 'dummy query')
    const keyPath = join(inst.dir, 'miss-signal-key')
    expect(existsSync(keyPath)).toBe(true)
    if (process.platform !== 'win32') expect(statSync(keyPath).mode & 0o077).toBe(0)
    const key = readFileSync(keyPath, 'utf8').trim()
    expect(key.length).toBeGreaterThanOrEqual(32)
    expect(JSON.stringify(body)).not.toContain(key)
  })
})
