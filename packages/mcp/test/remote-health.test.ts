/**
 * MCP surfacing of remote auth/expiry state — closes part of plur-ai/plur#295.
 *
 * Before this, an expired enterprise token failed silently: writes queued to the
 * outbox, reads returned 0, and plur_doctor still said "healthy". These tests
 * assert the loud surfacing: plur_doctor flags the dead remote, and
 * plur_session_start warns in its guide text. Full MCP → core → /me pipeline
 * against the in-process stub (real HTTP). Embeddings disabled to keep the
 * doctor probe fast and deterministic (no model download in CI).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Plur } from '@plur-ai/core'
import { createServer } from '../src/server.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'health-mcp-token'
const SCOPE = 'group:plur/plur-ai/engineering'

let stub: StubServer
let baseUrl: string
const dirs: string[] = []

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
const makeJwt = (expSecondsFromNow: number) =>
  `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'crtahlin', org_id: 'plur', exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })}.sig`

async function makeClient(plurPath: string): Promise<Client> {
  const plur = new Plur({ path: plurPath })
  const server = await createServer(plur)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientTransport)
  return client
}

function callResult(raw: Awaited<ReturnType<Client['callTool']>>): any {
  return JSON.parse((raw.content as any)[0].text)
}

function writeConfig(token: string, url = baseUrl): string {
  const dir = mkdtempSync(join(tmpdir(), 'plur-mcp-health-'))
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
  stub.setMe({ username: 'crtahlin', org_id: 'plur', role: 'developer', scopes: [SCOPE] })
})

describe('plur_doctor remote check (#295)', () => {
  it('reports the remote as reachable with a valid token', async () => {
    const client = await makeClient(writeConfig(TOKEN))
    const res = callResult(await client.callTool({ name: 'plur_doctor', arguments: {} }))
    const remote = res.checks.find((c: any) => String(c.check).startsWith('remote store:'))
    expect(remote).toBeDefined()
    expect(remote.ok).toBe(true)
    expect(remote.detail).toMatch(/Reachable/)
  })

  it('flags AUTH FAILED (not healthy) when the token is rejected', async () => {
    const client = await makeClient(writeConfig('wrong-token'))
    const res = callResult(await client.callTool({ name: 'plur_doctor', arguments: {} }))
    const remote = res.checks.find((c: any) => String(c.check).startsWith('remote store:'))
    expect(remote).toBeDefined()
    expect(remote.ok).toBe(false)
    expect(remote.detail).toMatch(/AUTH FAILED/)
    expect(res.ok).toBe(false) // overall doctor must NOT be healthy
    expect(res.remediation.join(' ')).toMatch(/re-authenticate/i)
  })
})

describe('plur_session_start remote auth surfacing (#295)', () => {
  it('warns loudly in the guide when the enterprise token is rejected', async () => {
    const client = await makeClient(writeConfig('wrong-token'))
    const res = callResult(await client.callTool({ name: 'plur_session_start', arguments: { task: 'anything' } }))
    expect(res.guide).toMatch(/ENTERPRISE STORE (AUTH FAILED|UNREACHABLE)/)
  })

  it('warns proactively when a valid token expires soon (≤7d)', async () => {
    const soonJwt = makeJwt(3 * 86_400) // 3 days out
    const stubSoon = new StubServer(soonJwt)
    const info = await stubSoon.start()
    try {
      stubSoon.setMe({ username: 'crtahlin', org_id: 'plur', role: 'developer', scopes: [SCOPE] })
      const client = await makeClient(writeConfig(soonJwt, info.url))
      const res = callResult(await client.callTool({ name: 'plur_session_start', arguments: { task: 'anything' } }))
      expect(res.guide).toMatch(/expires in \dd/)
    } finally {
      await stubSoon.stop()
    }
  })
})
