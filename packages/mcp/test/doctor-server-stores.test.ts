import { expect, it } from 'vitest'
import { createServer as httpServer } from 'http'
import type { AddressInfo } from 'net'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Plur } from '@plur-ai/core'
import { createServer } from '../src/server.js'

it('MCP doctor includes server write-path failures without claiming healthy remediation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plur-doctor-path-')), scope = 'project:example/team/app'
  const http = httpServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/v1/me') res.end(JSON.stringify({ username: 'fixture', org_id: 'example', scopes: [scope], scopes_status: 'ok' }))
    else { res.writeHead(404); res.end('{}') }
  })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ embeddings: { enabled: false }, index: false, stores: [{
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, token: 'fixture-key', scopes: [scope], enterprise: {},
    discovery: { status: 'ok', discovered_at: new Date().toISOString() },
  }] }))
  chmodSync(join(root, 'config.yaml'), 0o600)
  const plur = new Plur({ path: root, autoDiscover: false }), mcp = await createServer(plur, { profile: 'full' })
  const [ct, st] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'fixture', version: '1' })
  try {
    await plur.learn('Use a disposable environment for checks', { scope: 'global' })
    await mcp.connect(st); await client.connect(ct)
    const result = JSON.parse(((await client.callTool({ name: 'plur_doctor', arguments: {} })).content as any)[0].text)
    expect(result.server_stores).toHaveLength(1)
    expect(result.server_stores[0].checks).toHaveLength(6)
    expect(result.checks.find((c: any) => String(c.check).endsWith('write-path'))).toMatchObject({ ok: false, result: 'could-not-check' })
    expect(result.ok).toBe(false)
    expect(result.remediation.join(' ')).not.toContain('All checks passed')
  } finally { await client.close(); await mcp.close(); plur.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); rmSync(root, { recursive: true, force: true }) }
}, 30000)
