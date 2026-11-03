/**
 * #1822: plur_doctor's "engram store" check counted the rows a remote (url)
 * store had cached in this process as local engrams. plur_session_start reads
 * status() before it warms the remote caches, so it reported 0 while the doctor,
 * run later in the same process, reported the team server's rows.
 *
 * The check must report the local count — the same number session_start
 * reports — and the remote rows get a line of their own.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Plur } from '@plur-ai/core'
import { createServer } from '../src/server.js'

const TOKEN = 'fixture-1822'
const SCOPE = 'group:acme/eng'
const REMOTE_ROWS = 7
const dirs: string[] = []
const stubs: StubServer[] = []
afterAll(async () => {
  for (const s of stubs) await s.stop()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

async function fixture() {
  const stub = new StubServer(TOKEN)
  stubs.push(stub)
  const { url } = await stub.start()
  stub.setMe({ username: 'tester', org_id: 'acme', role: 'developer', scopes: [SCOPE] })
  for (let i = 1; i <= REMOTE_ROWS; i++) {
    stub.seedEngram({ id: `ENG-SRV-${String(i).padStart(3, '0')}`, scope: SCOPE, status: 'active', data: { statement: `Team rule number ${i} for the fixture` } })
  }
  const store = mkdtempSync(join(tmpdir(), 'plur-1822-'))
  dirs.push(store)
  writeFileSync(join(store, 'config.yaml'), `embeddings:\n  enabled: false\nindex: false\nstores:\n  - url: ${url}\n    token: ${TOKEN}\n    scope: ${SCOPE}\n`)
  const plur = new Plur({ path: store, autoDiscover: false })
  const server = await createServer(plur, { profile: 'full' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: 'fixture-1822', version: '1.0.0' })
  await client.connect(ct)
  const call = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(((await client.callTool({ name, arguments: args })).content as any)[0].text)
  return { plur, client, server, call }
}

describe('plur_doctor engram store check reports the local count (#1822)', () => {
  it('matches session_start store_stats and shows the remote rows on their own line', async () => {
    const { plur, client, server, call } = await fixture()
    try {
      const session = await call('plur_session_start', { task: 'check the fixture' })
      expect(session.store_stats.engram_count).toBe(0)

      const doctor = await call('plur_doctor', {})
      const store = doctor.checks.find((c: any) => c.check === 'engram store')
      expect(store.detail).toMatch(/^0 engrams across 0 packs at /)
      expect(store.ok).toBe(false)

      const remote = doctor.checks.find((c: any) => c.check === 'remote store cache')
      expect(remote).toBeDefined()
      expect(remote.ok).toBe(true)
      expect(remote.detail).toContain(`${REMOTE_ROWS} engrams`)
    } finally { await client.close(); await server.close(); plur.close() }
  }, 30000)

  it('session_start store_stats stays the local count on a second call in the same process', async () => {
    const { plur, client, server, call } = await fixture()
    try {
      await plur.learn('Use a disposable environment for checks', { scope: 'global' })
      const first = await call('plur_session_start', { task: 'first session' })
      expect(first.store_stats.engram_count).toBe(1)
      // The first call warmed the remote cache; the second must not count it.
      const second = await call('plur_session_start', { task: 'second session' })
      expect(second.store_stats.engram_count).toBe(1)

      const doctor = await call('plur_doctor', {})
      const store = doctor.checks.find((c: any) => c.check === 'engram store')
      expect(store.detail).toMatch(/^1 engrams across 0 packs at /)
      expect(store.ok).toBe(true)
    } finally { await client.close(); await server.close(); plur.close() }
  }, 30000)
})
