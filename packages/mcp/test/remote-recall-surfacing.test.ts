/**
 * A4′ degradation surfacing on the MCP surfaces (#776).
 *
 * The recall/inject/session_start responses attach a structured
 * `remote_stores` block + ONE prose warning line ONLY when a remote host is
 * non-ok (or silently scope-narrowed via dropped_scopes) — a healthy host
 * attaches nothing. plur_doctor renders the human remediation strings,
 * including the re-auth copy that must NOT reference `plur login` (a dead
 * end against enterprise servers). Tool descriptions and the agent guide no
 * longer claim "fully local / no API calls".
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Plur } from '@plur-ai/core'
import { createServer, INSTRUCTIONS, GUIDE_RESOURCE } from '../src/server.js'
import { getToolDefinitions } from '../src/tools.js'
import { StubServer } from '../../core/test/helpers/stub-server.js'

const TOKEN = 'surfacing-token'
const SCOPE = 'group:test'
const PROJECT = 'project:test/app' // org 'test' → implicates the store

let stub: StubServer
let baseUrl: string
const dirs: string[] = []
let activeClients: Client[] = []

async function makeClient(plurPath: string): Promise<Client> {
  const plur = new Plur({ path: plurPath })
  // full profile: plur_inject_hybrid is not directly callable under lean.
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

function writeConfig(url: string, token = TOKEN): string {
  const dir = mkdtempSync(join(tmpdir(), 'plur-mcp-rrs-'))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'config.yaml'),
    `embeddings:\n  enabled: false\nstores:\n  - url: "${url}"\n    token: "${token}"\n    scope: "${SCOPE}"\n`,
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

describe('remote_stores block on plur_recall', () => {
  it('is ABSENT when the host is healthy', async () => {
    stub.recallRows = [{ id: 'ENG-2026-0731-080', scope: SCOPE, status: 'active', statement: 'team fact', score: 1 }]
    const client = await makeClient(writeConfig(baseUrl))
    const res = callResult(await client.callTool({
      name: 'plur_recall',
      arguments: { query: 'team fact', scope: PROJECT },
    }))
    expect(res.remote_stores).toBeUndefined()
    expect(stub.recallCalls).toBe(1)
    // ...and the server row is actually served.
    expect(res.results.some((r: any) => String(r.id).includes('2026-0731-080'))).toBe(true)
  })

  it('is PRESENT with a prose warning when the host is unreachable', async () => {
    const client = await makeClient(writeConfig('http://127.0.0.1:1'))
    const res = callResult(await client.callTool({
      name: 'plur_recall',
      arguments: { query: 'anything at all', scope: PROJECT },
    }))
    expect(res.remote_stores).toBeDefined()
    expect(res.remote_stores).toHaveLength(1)
    expect(res.remote_stores[0].host).toBe('http://127.0.0.1:1')
    expect(['unreachable', 'timeout']).toContain(res.remote_stores[0].status)
    // Agent-directed prose: consequence + agent action.
    expect(res.warning).toMatch(/serving local only/)
    expect(res.warning).toMatch(/plur_doctor/)
  })

  it('keyword mode surfaces the block too (recall() dials as well)', async () => {
    const client = await makeClient(writeConfig('http://127.0.0.1:1'))
    const res = callResult(await client.callTool({
      name: 'plur_recall',
      arguments: { query: 'anything', scope: PROJECT, mode: 'keyword' },
    }))
    expect(res.remote_stores).toBeDefined()
  })

  it('surfaces silent scope narrowing (dropped_scopes) even on an ok host', async () => {
    stub.recallEnvelope = { dropped_scopes: ['group:test/secret'] }
    const client = await makeClient(writeConfig(baseUrl))
    const res = callResult(await client.callTool({
      name: 'plur_recall',
      arguments: { query: 'anything', scope: PROJECT },
    }))
    expect(res.remote_stores).toBeDefined()
    expect(res.remote_stores[0].status).toBe('ok')
    expect(res.remote_stores[0].dropped_scopes).toEqual(['group:test/secret'])
    expect(res.warning).toMatch(/not granted to your key/)
  })
})

describe('remote_stores block on plur_inject_hybrid and plur_session_start', () => {
  it('plur_inject_hybrid attaches the block only when degraded', async () => {
    const degraded = await makeClient(writeConfig('http://127.0.0.1:1'))
    const res = callResult(await degraded.callTool({
      name: 'plur_inject_hybrid',
      arguments: { task: 'anything at all', scope: PROJECT },
    }))
    expect(res.remote_stores).toBeDefined()

    const healthy = await makeClient(writeConfig(baseUrl))
    const ok = callResult(await healthy.callTool({
      name: 'plur_inject_hybrid',
      arguments: { task: 'anything at all', scope: PROJECT },
    }))
    expect(ok.remote_stores).toBeUndefined()
  })

  it('plur_session_start reports a degraded host from its warm injection', async () => {
    // session_start has no project scope in this harness — give the store a
    // dial:always override so the warm injection dials it.
    const dir = mkdtempSync(join(tmpdir(), 'plur-mcp-rrs-'))
    dirs.push(dir)
    writeFileSync(
      join(dir, 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n  - url: "http://127.0.0.1:1"\n    token: "t"\n    scope: "${SCOPE}"\n    dial: always\n`,
    )
    const client = await makeClient(dir)
    const res = callResult(await client.callTool({
      name: 'plur_session_start',
      arguments: { task: 'kick off' },
    }))
    expect(res.remote_stores).toBeDefined()
    expect(['unreachable', 'timeout']).toContain(res.remote_stores[0].status)
  })
})

describe('plur_doctor remediation strings (#776)', () => {
  it('renders the re-auth remediation WITHOUT plur login, and the recall-leg check', async () => {
    stub.recallStatus = 401
    const dir = writeConfig(baseUrl)
    const client = await makeClient(dir)
    // Prime a recall so the doctor has a last outcome to report.
    await client.callTool({ name: 'plur_recall', arguments: { query: 'x', scope: PROJECT } })
    const res = callResult(await client.callTool({ name: 'plur_doctor', arguments: {} }))
    const recallCheck = res.checks.find((c: any) => String(c.check).startsWith('remote recall:'))
    expect(recallCheck).toBeDefined()
    expect(recallCheck.ok).toBe(false)
    expect(recallCheck.detail).toMatch(/auth_expired/)
    const remediation: string = res.remediation.join('\n')
    expect(remediation).toMatch(/token expired or revoked/)
    expect(remediation).toMatch(/plur_stores_add/)
    // The dead-end command must not be recommended (DX finding 1): the only
    // mention allowed is the explicit "does not work" warning.
    expect(remediation).not.toMatch(/`plur login` (?!does not work)/)
    expect(remediation).toMatch(/plur login.*does not work/i)
  })

  it('warns when one endpoint is configured with multiple tokens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-mcp-rrs-'))
    dirs.push(dir)
    writeFileSync(
      join(dir, 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n` +
      `  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "group:test"\n` +
      `  - url: "${baseUrl}/sse"\n    token: "another-token"\n    scope: "group:test/sub"\n`,
    )
    const client = await makeClient(dir)
    const res = callResult(await client.callTool({ name: 'plur_doctor', arguments: {} }))
    const tokenCheck = res.checks.find((c: any) => String(c.check).startsWith('remote store tokens:'))
    expect(tokenCheck).toBeDefined()
    expect(tokenCheck.ok).toBe(false)
    expect(res.remediation.join('\n')).toMatch(/consolidate to one token/)
  })
})

describe('description honesty (#776)', () => {
  const tools = getToolDefinitions('full')

  it('plur_recall no longer claims "No API calls, fully local"', () => {
    const recall = tools.find(t => t.name === 'plur_recall')!
    expect(recall.description).not.toMatch(/No API calls, fully local/)
    expect(recall.description).toMatch(/remote host|enterprise store/i)
    const hybrid = tools.find(t => t.name === 'plur_recall_hybrid')!
    expect(hybrid.description).not.toMatch(/No API calls, fully local/)
  })

  it('the server instructions/guide no longer claim zero API calls unconditionally', () => {
    expect(GUIDE_RESOURCE).not.toMatch(/Search is fully local \(BM25 \+ embeddings\)\. Zero API calls\./)
    expect(GUIDE_RESOURCE).toMatch(/remote_stores/)
    // INSTRUCTIONS never made the claim — pin that it stays that way.
    expect(INSTRUCTIONS).not.toMatch(/Zero API calls/)
  })
})
