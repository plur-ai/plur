/**
 * MCP Level-3 e2e tests: full MCP → core → RemoteStore pipeline.
 *
 * Why this exists: in 0.9.6, `new Plur().learn(stmt, { scope: teamScope })`
 * routed correctly to the remote store, but `plur_learn` via MCP wrote to
 * local instead. Core-level integration tests (Level 2) couldn't catch this
 * because they bypass the MCP initialization path entirely.
 *
 * These tests wire a real MCP server (via InMemoryTransport, same code path
 * as the stdio bundle) against an in-process HTTP stub, then assert server-
 * side state directly — not just what the MCP response says.
 *
 * See: https://github.com/plur-ai/plur/issues/82
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Plur } from '@plur-ai/core'
import { createServer } from '../src/server.js'
import { StubServer } from './helpers/stub-server.js'

async function waitForStubEngrams(stub: StubServer, count: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (stub.engramCount < count) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${count} engrams (got ${stub.engramCount})`)
    await new Promise(r => setTimeout(r, 10))
  }
}

async function waitForRemoteCount(client: Client, scope: string, minCount: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const raw = await client.callTool({ name: 'plur_stores_list', arguments: {} })
    const { stores } = JSON.parse((raw.content as any)[0].text) as any
    const remote = stores.find((s: any) => s.scope === scope)
    if (remote && remote.engram_count >= minCount) return
    if (Date.now() > deadline) throw new Error(`Timed out waiting for remote count >= ${minCount}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TOKEN = 'e2e-mcp-test-token'
const REMOTE_SCOPE = 'team:e2e-test'

let stub: StubServer
let baseUrl: string
let dir: string

async function makeClient(plurPath: string): Promise<{ client: Client }> {
  const plur = new Plur({ path: plurPath })
  const server = await createServer(plur)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientTransport)
  return { client }
}

function callResult(raw: Awaited<ReturnType<Client['callTool']>>): unknown {
  return JSON.parse((raw.content as any)[0].text)
}

beforeAll(async () => {
  stub = new StubServer(TOKEN)
  const info = await stub.start()
  baseUrl = info.url
})

afterAll(async () => {
  await stub.stop()
})

beforeEach(() => {
  stub.reset()
  dir = mkdtempSync(join(tmpdir(), 'plur-mcp-e2e-'))
  // Write config.yaml so Plur picks up the remote store on construction
  writeFileSync(
    join(dir, 'config.yaml'),
    `stores:\n  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${REMOTE_SCOPE}"\n`,
  )
})

// ---------------------------------------------------------------------------
// plur_learn routing
// ---------------------------------------------------------------------------

describe('MCP plur_learn routing', () => {
  it('plur_learn with team scope reaches the server (not just core)', async () => {
    const { client } = await makeClient(dir)

    await client.callTool({
      name: 'plur_learn',
      arguments: { statement: 'Always run linters before merging', scope: REMOTE_SCOPE, type: 'procedural' },
    })

    await waitForStubEngrams(stub, 1)
    expect(stub.engramCount).toBe(1)
  })

  it('returned ID matches server-assigned ID', async () => {
    const { client } = await makeClient(dir)

    const raw = await client.callTool({
      name: 'plur_learn',
      arguments: { statement: 'Use semantic versioning for all packages', scope: REMOTE_SCOPE, type: 'procedural' },
    })
    const result = callResult(raw) as any

    expect(result.id).toMatch(/^ENG-SRV-/)
    const serverEngram = stub.getEngram(result.id)
    expect(serverEngram).toBeDefined()
    expect(serverEngram!.id).toBe(result.id)
  })

  it('local engrams.yaml does NOT contain the remote-scoped engram', async () => {
    const { client } = await makeClient(dir)

    await client.callTool({
      name: 'plur_learn',
      arguments: { statement: 'Deploy via git pull, not manual copy', scope: REMOTE_SCOPE, type: 'procedural' },
    })

    // Wait for the remote push to complete before asserting local store is clean
    await waitForStubEngrams(stub, 1)

    const localPath = join(dir, 'engrams.yaml')
    if (existsSync(localPath)) {
      const content = readFileSync(localPath, 'utf-8')
      // Remote-scoped engram should not appear in the primary local store
      expect(content).not.toContain('Deploy via git pull')
    }
    // If the file doesn't exist, there are no local engrams — also correct
  })
})

// ---------------------------------------------------------------------------
// plur_forget routing
// ---------------------------------------------------------------------------

describe('MCP plur_forget routing', () => {
  it('plur_forget with server ID reaches server and retires', async () => {
    const { client } = await makeClient(dir)

    // Learn first
    const learnRaw = await client.callTool({
      name: 'plur_learn',
      arguments: { statement: 'Squash commits before merging feature branches', scope: REMOTE_SCOPE, type: 'procedural' },
    })
    const learned = callResult(learnRaw) as any
    const serverId = learned.id

    expect(stub.getEngram(serverId)?.status).toBe('active')

    // Forget by server ID
    const forgetRaw = await client.callTool({
      name: 'plur_forget',
      arguments: { id: serverId },
    })
    const forgotten = callResult(forgetRaw) as any

    expect(forgotten.success).toBe(true)
    expect(stub.getEngram(serverId)?.status).toBe('retired')
  })
})

// ---------------------------------------------------------------------------
// plur_feedback routing
// ---------------------------------------------------------------------------

describe('MCP plur_feedback routing', () => {
  it('plur_feedback with server ID reaches server and updates weight', async () => {
    const { client } = await makeClient(dir)

    const learnRaw = await client.callTool({
      name: 'plur_learn',
      arguments: { statement: 'Write tests before submitting a PR', scope: REMOTE_SCOPE, type: 'procedural' },
    })
    const learned = callResult(learnRaw) as any
    const serverId = learned.id

    const fbRaw = await client.callTool({
      name: 'plur_feedback',
      arguments: { id: serverId, signal: 'positive' },
    })
    const fb = callResult(fbRaw) as any

    expect(fb.success).toBe(true)
    const stored = stub.getEngram(serverId)
    expect((stored?.data as any)?.feedback_signals?.positive).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// plur_stores_list
// ---------------------------------------------------------------------------

describe('MCP plur_stores_list', () => {
  it('remote store appears with correct engram count after write', async () => {
    const { client } = await makeClient(dir)

    await client.callTool({
      name: 'plur_learn',
      arguments: { statement: 'Changelog entries go in UNRELEASED section', scope: REMOTE_SCOPE, type: 'procedural' },
    })
    await waitForRemoteCount(client, REMOTE_SCOPE, 1)

    const storesRaw = await client.callTool({ name: 'plur_stores_list', arguments: {} })
    const { stores } = callResult(storesRaw) as any

    const remote = stores.find((s: any) => s.scope === REMOTE_SCOPE)
    expect(remote).toBeDefined()
    expect(remote.url).toBe(baseUrl)
    expect(remote.engram_count).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Config persistence across MCP server restart
// ---------------------------------------------------------------------------

describe('MCP config loading', () => {
  it('remote store entry survives MCP server restart', async () => {
    // First session: learn something
    const { client: client1 } = await makeClient(dir)
    await client1.callTool({
      name: 'plur_learn',
      arguments: { statement: 'Pin all dependency versions in lock files', scope: REMOTE_SCOPE, type: 'procedural' },
    })
    expect(stub.engramCount).toBe(1)

    // Second session: same dir, new Plur + new MCP server — simulates restart
    const { client: client2 } = await makeClient(dir)
    const storesRaw = await client2.callTool({ name: 'plur_stores_list', arguments: {} })
    const { stores } = callResult(storesRaw) as any

    // The remote store entry must still be configured
    const remote = stores.find((s: any) => s.scope === REMOTE_SCOPE)
    expect(remote).toBeDefined()
    expect(remote.url).toBe(baseUrl)
  })
})
