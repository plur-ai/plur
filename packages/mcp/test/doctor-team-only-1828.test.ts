/**
 * #1828: on a team-only install (a url store configured, no local engrams
 * yet), plur_doctor's "engram store" check failed and took the doctor's
 * overall `ok` down with it, with only the generic "Resolve the failed checks
 * above." to go on.
 *
 * Decision: such an install passes, with an explanation that names the server
 * scope(s) from config — no network call. Whether the server is reachable stays
 * the job of the remote store and server checks. A purely local install with
 * no engrams keeps failing exactly as before.
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

const TOKEN = 'fixture-1828'
const SCOPE_A = 'group:acme/eng'
const SCOPE_B = 'group:acme/research'
const dirs: string[] = []
const stubs: StubServer[] = []
afterAll(async () => {
  for (const s of stubs) await s.stop()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

async function fixture(scopes: string[]) {
  let storesYaml = ''
  if (scopes.length > 0) {
    const stub = new StubServer(TOKEN)
    stubs.push(stub)
    const { url } = await stub.start()
    stub.setMe({ username: 'tester', org_id: 'acme', role: 'developer', scopes })
    storesYaml = 'stores:\n' + scopes.map(s => `  - url: ${url}\n    token: ${TOKEN}\n    scope: ${s}\n`).join('')
  }
  const store = mkdtempSync(join(tmpdir(), 'plur-1828-'))
  dirs.push(store)
  writeFileSync(join(store, 'config.yaml'), `embeddings:\n  enabled: false\nindex: false\n${storesYaml}`)
  const plur = new Plur({ path: store, autoDiscover: false })
  const server = await createServer(plur, { profile: 'full' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: 'fixture-1828', version: '1.0.0' })
  await client.connect(ct)
  const call = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(((await client.callTool({ name, arguments: args })).content as any)[0].text)
  const engramStore = async () =>
    (await call('plur_doctor', {})).checks.find((c: any) => c.check === 'engram store')
  return { plur, client, server, engramStore }
}

describe('plur_doctor engram store check on a team-only install (#1828)', () => {
  it('passes with no local engrams when a url store is configured, and names its scope', async () => {
    const { plur, client, server, engramStore } = await fixture([SCOPE_A])
    try {
      const store = await engramStore()
      expect(store.ok).toBe(true)
      expect(store.detail).toMatch(/^0 engrams across 0 packs at /)
      expect(store.detail).toContain('no local engrams yet')
      expect(store.detail).toContain('team memory is on the server')
      expect(store.detail).toContain(SCOPE_A)
    } finally { await client.close(); await server.close(); plur.close() }
  }, 30000)

  it('names every configured server scope', async () => {
    const { plur, client, server, engramStore } = await fixture([SCOPE_A, SCOPE_B])
    try {
      const store = await engramStore()
      expect(store.ok).toBe(true)
      expect(store.detail).toContain(SCOPE_A)
      expect(store.detail).toContain(SCOPE_B)
    } finally { await client.close(); await server.close(); plur.close() }
  }, 30000)

  it('a purely local install with no engrams still fails, with the unchanged detail', async () => {
    const { plur, client, server, engramStore } = await fixture([])
    try {
      const store = await engramStore()
      expect(store.ok).toBe(false)
      expect(store.detail).toMatch(/^0 engrams across 0 packs at \S+$/)
      expect(store.detail).not.toContain('server')
    } finally { await client.close(); await server.close(); plur.close() }
  }, 30000)

  it('with local engrams and a url store, the check is unchanged', async () => {
    const { plur, client, server, engramStore } = await fixture([SCOPE_A])
    try {
      await plur.learn('Use a disposable environment for checks', { scope: 'global' })
      const store = await engramStore()
      expect(store.ok).toBe(true)
      expect(store.detail).toMatch(/^1 engrams across 0 packs at \S+$/)
    } finally { await client.close(); await server.close(); plur.close() }
  }, 30000)
})
