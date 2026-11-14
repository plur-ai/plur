// security audit 2026-11-06: the miss-signal query fingerprint is keyed per install, so a guess cannot be confirmed.
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
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
  it('a guessed query hashed with plain SHA-256 does not match, and the owner-only key is never sent', async () => {
    const inst = install()
    const body = await emit(inst, 'Acme Corp   acquisition OFFER price')
    expect(body.query_fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(body.query_fingerprint).not.toBe(unsalted('acme corp acquisition offer price'))
    const keyPath = join(inst.dir, 'miss-signal-key')
    if (process.platform !== 'win32') expect(statSync(keyPath).mode & 0o077).toBe(0)
    expect(JSON.stringify(body)).not.toContain(readFileSync(keyPath, 'utf8').trim())
  })

  it('stable within one install, different across installs', async () => {
    const inst = install()
    const a = await emit(inst, 'How do I  deploy')
    const b = await emit(inst, 'how do i deploy')
    expect(a.query_fingerprint).toBe(b.query_fingerprint)
    expect((await emit(install(), 'how do i deploy')).query_fingerprint).not.toBe(a.query_fingerprint)
  })
})
