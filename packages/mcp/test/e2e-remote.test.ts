/**
 * MCP End-to-End tests for remote store operations.
 *
 * Unlike unit tests that call Plur directly, these tests go through the
 * full MCP pipeline: Client → InMemoryTransport → Server → Plur → RemoteStore
 * → StubServer (real HTTP). This catches bugs where the MCP server's tool
 * handlers diverge from the core library (the exact 0.9.6 bug class).
 *
 * ## Architecture
 *
 * ```
 * Test ──→ MCP Client ──→ InMemoryTransport ──→ MCP Server
 *                                                   │
 *                                              Plur instance
 *                                                   │
 *                                              RemoteStore
 *                                                   │ (real HTTP)
 *                                              StubServer
 * ```
 *
 * ## What this covers
 *
 * - plur_learn tool routes to remote via the MCP handler path
 * - plur_stores_list reflects remote store state
 * - plur_session_start works with remote stores configured
 * - Local YAML is not polluted when routing to remote
 *
 * ## What this does NOT cover
 *
 * - Bundled dist validation (spawning `node dist/index.js`) — see issue #TBD
 * - stdio transport edge cases
 *
 * See: https://github.com/plur-ai/plur/issues/82
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Plur } from '@plur-ai/core'
import { createServer } from '../src/server.js'
import { StubServer } from '../../core/test/helpers/stub-server.js'

const TOKEN = 'mcp-e2e-test-token'
let stubServer: StubServer
let stubUrl: string

beforeAll(async () => {
  stubServer = new StubServer(TOKEN)
  const info = await stubServer.start()
  stubUrl = info.url
})

afterAll(async () => {
  await stubServer.stop()
})

/** Write a minimal YAML config with store entries. */
function writeConfig(dir: string, stores: Array<{ url: string; token: string; scope: string; readonly?: boolean }>) {
  const entries = stores.map(s =>
    `  - url: ${s.url}\n    token: ${s.token}\n    scope: ${s.scope}\n    shared: true\n    readonly: ${s.readonly ?? false}`
  ).join('\n')
  writeFileSync(join(dir, 'config.yaml'), `index: false\nstores:\n${entries}\n`)
}

/** Create a fresh MCP client+server pair with a temp PLUR_PATH. */
async function createMcpPair(storeConfig?: Array<{ url: string; token: string; scope: string; readonly?: boolean }>) {
  const dir = mkdtempSync(join(tmpdir(), 'plur-mcp-e2e-'))

  if (storeConfig) {
    writeConfig(dir, storeConfig)
  }

  const plur = new Plur({ path: dir })
  const server = await createServer(plur)

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)

  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientTransport)

  return { client, server, plur, dir }
}

async function cleanup(pair: { client: Client; server: any; dir: string }) {
  await pair.client.close()
  await pair.server.close()
  rmSync(pair.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// plur_learn via MCP
// ---------------------------------------------------------------------------

describe('MCP plur_learn routing', () => {
  beforeEach(() => stubServer.reset())

  it('plur_learn with team scope reaches stub server', async () => {
    const pair = await createMcpPair([{
      url: stubUrl,
      token: TOKEN,
      scope: 'group:test',
      readonly: false,
    }])

    try {
      const result = await pair.client.callTool({
        name: 'plur_learn',
        arguments: {
          statement: 'MCP e2e test engram',
          scope: 'group:test',
          type: 'behavioral',
        },
      })

      expect(result.isError).toBeFalsy()

      // Wait for background remote append
      await new Promise(r => setTimeout(r, 100))

      // Stub server should have the engram
      expect(stubServer.engramCount).toBe(1)
      const srvEngram = stubServer.getEngram('ENG-SRV-001')
      expect(srvEngram).toBeDefined()
      expect((srvEngram!.data as any).statement).toBe('MCP e2e test engram')
    } finally {
      await cleanup(pair)
    }
  })

  it('local engrams.yaml does NOT contain the remote-scoped engram', async () => {
    const pair = await createMcpPair([{
      url: stubUrl,
      token: TOKEN,
      scope: 'group:test',
      readonly: false,
    }])

    try {
      await pair.client.callTool({
        name: 'plur_learn',
        arguments: {
          statement: 'should not be local',
          scope: 'group:test',
          type: 'procedural',
        },
      })

      await new Promise(r => setTimeout(r, 100))

      const localYaml = join(pair.dir, 'engrams.yaml')
      if (existsSync(localYaml)) {
        expect(readFileSync(localYaml, 'utf-8')).not.toContain('should not be local')
      }
    } finally {
      await cleanup(pair)
    }
  })

  it('plur_learn with global scope writes locally', async () => {
    const pair = await createMcpPair([{
      url: stubUrl,
      token: TOKEN,
      scope: 'group:test',
      readonly: false,
    }])

    try {
      await pair.client.callTool({
        name: 'plur_learn',
        arguments: {
          statement: 'local global engram',
          scope: 'global',
          type: 'behavioral',
        },
      })

      // Should NOT reach stub server (scope doesn't match)
      expect(stubServer.engramCount).toBe(0)

      // Should be in local YAML
      const localYaml = join(pair.dir, 'engrams.yaml')
      expect(existsSync(localYaml)).toBe(true)
      expect(readFileSync(localYaml, 'utf-8')).toContain('local global engram')
    } finally {
      await cleanup(pair)
    }
  })
})

// ---------------------------------------------------------------------------
// plur_stores_list via MCP
// ---------------------------------------------------------------------------

describe('MCP plur_stores_list', () => {
  beforeEach(() => stubServer.reset())

  it('remote store appears in list', async () => {
    const pair = await createMcpPair([{
      url: stubUrl,
      token: TOKEN,
      scope: 'group:test',
      readonly: false,
    }])

    try {
      const result = await pair.client.callTool({
        name: 'plur_stores_list',
        arguments: {},
      })

      expect(result.isError).toBeFalsy()
      const content = result.content as Array<{ text?: string }>
      const parsed = JSON.parse(content[0]?.text ?? '{}')
      expect(parsed.stores).toBeDefined()

      const remote = parsed.stores.find((s: any) => s.url)
      expect(remote).toBeDefined()
      expect(remote.scope).toBe('group:test')
    } finally {
      await cleanup(pair)
    }
  })
})

// ---------------------------------------------------------------------------
// plur_session_start via MCP
// ---------------------------------------------------------------------------

describe('MCP plur_session_start', () => {
  beforeEach(() => stubServer.reset())

  it('session starts successfully with remote store configured', async () => {
    const pair = await createMcpPair([{
      url: stubUrl,
      token: TOKEN,
      scope: 'group:test',
      readonly: false,
    }])

    try {
      const result = await pair.client.callTool({
        name: 'plur_session_start',
        arguments: { task: 'MCP e2e test session' },
      })

      expect(result.isError).toBeFalsy()
      const content = result.content as Array<{ text?: string }>
      const parsed = JSON.parse(content[0]?.text ?? '{}')
      expect(parsed.session_id).toBeDefined()
    } finally {
      await cleanup(pair)
    }
  })
})

// ---------------------------------------------------------------------------
// plur_status via MCP
// ---------------------------------------------------------------------------

describe('MCP plur_status', () => {
  it('returns status without error when remote store is configured', async () => {
    const pair = await createMcpPair([{
      url: stubUrl,
      token: TOKEN,
      scope: 'group:test',
      readonly: false,
    }])

    try {
      const result = await pair.client.callTool({
        name: 'plur_status',
        arguments: {},
      })

      expect(result.isError).toBeFalsy()
      const content = result.content as Array<{ text?: string }>
      const parsed = JSON.parse(content[0]?.text ?? '{}')
      expect(parsed.storage_root).toBeDefined()
    } finally {
      await cleanup(pair)
    }
  })
})
