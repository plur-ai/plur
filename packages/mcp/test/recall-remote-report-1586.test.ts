/**
 * #1586 — every plur_recall reply says, for THAT call, what happened to the
 * remote (server) leg and whether the results are complete.
 *
 * Added fields only: `remote` ({ state, hosts[] }) and `results_complete`.
 * The existing `results` / `count` / `mode` / `remote_stores` / `warning`
 * fields keep their shape.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Plur, normalizeEndpointUrl } from '@plur-ai/core'
import { createServer } from '../src/server.js'
import { StubServer } from '../../core/test/helpers/stub-server.js'

const TOKEN = 'report-token'
const SCOPE = 'group:test'
const PROJECT = 'project:test/app' // org 'test' → implicates the store

let stub: StubServer
let baseUrl: string
const dirs: string[] = []
let activeClients: Client[] = []

async function makeClient(plurPath: string): Promise<Client> {
  const plur = new Plur({ path: plurPath })
  const server = await createServer(plur, { profile: 'full' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientTransport)
  activeClients.push(client)
  return client
}

function callResult(raw: Awaited<ReturnType<Client['callTool']>>): any {
  return JSON.parse((raw.content as any)[0].text)
}

function writeConfig(url: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'plur-mcp-1586-'))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'config.yaml'),
    url
      ? `embeddings:\n  enabled: false\nstores:\n  - url: "${url}"\n    token: "${TOKEN}"\n    scope: "${SCOPE}"\n`
      : `embeddings:\n  enabled: false\n`,
  )
  return dir
}

beforeAll(async () => {
  stub = new StubServer(TOKEN)
  const info = await stub.start()
  baseUrl = info.url
})

afterAll(async () => {
  await stub.stop()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

beforeEach(() => {
  stub.reset()
  stub.setMe({ username: 'tester', org_id: 'test', role: 'developer', scopes: [SCOPE] })
})

afterEach(async () => {
  await Promise.all(activeClients.map(c => c.close().catch(() => {})))
  activeClients = []
})

for (const mode of ['hybrid', 'keyword'] as const) {
  describe(`plur_recall (${mode}) reports the remote leg for this call`, () => {
    it('healthy host → remote.state ok, results_complete true, existing fields unchanged', async () => {
      stub.recallRows = [{ id: 'ENG-2026-1004-080', scope: SCOPE, status: 'active', statement: 'team report fact', score: 1 }]
      const client = await makeClient(writeConfig(baseUrl))
      const res = callResult(await client.callTool({
        name: 'plur_recall',
        arguments: { query: 'team report fact', scope: PROJECT, mode },
      }))
      expect(res.remote.state).toBe('ok')
      expect(res.remote.hosts).toHaveLength(1)
      expect(res.remote.hosts[0].host).toBe(normalizeEndpointUrl(baseUrl))
      expect(res.remote.hosts[0].state).toBe('ok')
      expect(res.results_complete).toBe(true)
      // Compatibility: the fields callers already read are still there.
      expect(Array.isArray(res.results)).toBe(true)
      expect(res.count).toBe(res.results.length)
      expect(res.mode).toBeDefined()
      expect(res.remote_stores).toBeUndefined()
    })

    it('host in cooldown → remote.state skipped_cooldown, results_complete false, no request', async () => {
      const dir = writeConfig(baseUrl)
      mkdirSync(join(dir, 'cache'), { recursive: true })
      writeFileSync(join(dir, 'cache', 'remote-health.json'), JSON.stringify({
        version: 1,
        hosts: { [normalizeEndpointUrl(baseUrl)]: { failures: 0, cooldown_until: Date.now() + 5 * 60_000, last_state: 'timeout', updated_at: Date.now() } },
      }))
      const client = await makeClient(dir)
      const res = callResult(await client.callTool({
        name: 'plur_recall',
        arguments: { query: 'anything', scope: PROJECT, mode },
      }))
      expect(res.remote.state).toBe('skipped_cooldown')
      expect(res.results_complete).toBe(false)
      expect(stub.recallCalls).toBe(0)
      // The existing per-process block is still attached.
      expect(res.remote_stores?.[0]?.status).toBe('skipped_cooldown')
    })

    it('no store configured → remote.state not_dialed, results_complete true', async () => {
      const client = await makeClient(writeConfig(null))
      const res = callResult(await client.callTool({
        name: 'plur_recall',
        arguments: { query: 'anything', mode },
      }))
      expect(res.remote.state).toBe('not_dialed')
      expect(res.results_complete).toBe(true)
    })
  })
}
