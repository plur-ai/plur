import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Plur } from '@plur-ai/core'
import { createServer } from '../src/server.js'
import { getToolDefinitions } from '../src/tools.js'

describe('tool profiles', () => {
  it('full profile returns every tool, unfiltered', () => {
    const full = getToolDefinitions('full')
    const bareCall = getToolDefinitions()
    expect(full.length).toBe(bareCall.length)
    expect(full.some(t => t.name === 'plur_packs_install')).toBe(true)
    expect(full.some(t => t.name === 'plur_admin')).toBe(false)
  })

  it('cursor profile stays at or under 10 tools and includes plur_admin', () => {
    const cursor = getToolDefinitions('cursor')
    expect(cursor.length).toBeLessThanOrEqual(10)
    const names = cursor.map(t => t.name)
    expect(names).toContain('plur_session_start')
    expect(names).toContain('plur_learn')
    expect(names).toContain('plur_recall_hybrid')
    expect(names).toContain('plur_admin')
    expect(names).not.toContain('plur_packs_install')
  })

  describe('plur_admin dispatch (wire protocol)', () => {
    let client: Client
    let dir: string

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'plur-admin-test-'))
      const plur = new Plur({ path: dir })
      const server = await createServer(plur, { profile: 'cursor' })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      client = new Client({ name: 'test-client', version: '1.0.0' })
      await client.connect(clientTransport)
    })

    afterEach(() => {
      rmSync(dir, { recursive: true })
    })

    it('lists <=10 tools over the wire in cursor profile', async () => {
      const { tools } = await client.listTools()
      expect(tools.length).toBeLessThanOrEqual(10)
    })

    it('dispatches plur_status through plur_admin', async () => {
      const result = await client.callTool({
        name: 'plur_admin',
        arguments: { action: 'plur_status', args: {} },
      })
      expect(result.isError).toBeFalsy()
      const data = JSON.parse((result.content as any)[0].text)
      expect(data.engram_count).toBe(0)
    })

    it('dispatches plur_packs_list through plur_admin with args', async () => {
      const result = await client.callTool({
        name: 'plur_admin',
        arguments: { action: 'plur_packs_list', args: {} },
      })
      expect(result.isError).toBeFalsy()
    })

    it('rejects an unknown action by name', async () => {
      const result = await client.callTool({
        name: 'plur_admin',
        arguments: { action: 'plur_nonexistent', args: {} },
      })
      const data = JSON.parse((result.content as any)[0].text)
      expect(data.success).toBe(false)
      expect(data.error).toContain('Unknown action')
    })

    // Audit fix: a known action with invalid inner args must get the SAME
    // isError:true + #297 array-bug-hint treatment a direct top-level call to
    // that tool would get — this is the exact parity gap the original draft
    // of this plan shipped without a test for.
    it('surfaces isError:true and the #297 array-bug hint for a known action with bad args', async () => {
      const result = await client.callTool({
        name: 'plur_admin',
        // plur_packs_export has a required `name` string field — omit it,
        // and pass no fields at all, to also trigger the #297 hint path
        // (array-typed param + empty payload).
        arguments: { action: 'plur_packs_export', args: {} },
      })
      expect(result.isError).toBe(true)
      const data = JSON.parse((result.content as any)[0].text)
      expect(data.success).toBe(false)
      expect(data.error).toContain('plur_packs_export')
      expect(typeof data.received_fields).toBe('object')
    })
  })
})
