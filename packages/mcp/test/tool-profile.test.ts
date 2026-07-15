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

  it('cursor profile stays at or under 12 tools and includes plur_admin', () => {
    const cursor = getToolDefinitions('cursor')
    // 8 day-to-day tools + plur_packs_uninstall/plur_tensions_purge
    // (destructive maintenance tools kept as direct top-level tools, not wrapped
    // in plur_admin, so their destructiveHint annotation stays visible to
    // clients — audit fix, evaluator review 2026-07-08)
    // + plur_admin, still far under Cursor's ~40-tool-per-workspace cap.
    expect(cursor.length).toBeLessThanOrEqual(12)
    const names = cursor.map(t => t.name)
    expect(names).toContain('plur_session_start')
    expect(names).toContain('plur_learn')
    expect(names).toContain('plur_recall_hybrid')
    expect(names).toContain('plur_admin')
    expect(names).toContain('plur_packs_uninstall')
    expect(names).toContain('plur_tensions_purge')
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

    it('lists <=12 tools over the wire in cursor profile', async () => {
      const { tools } = await client.listTools()
      expect(tools.length).toBeLessThanOrEqual(12)
    })

    // Audit fix (evaluator review, 2026-07-08): destructive tools must keep
    // their real annotation once they're direct top-level tools again —
    // this is the whole point of pulling them out of plur_admin's dispatch.
    it('exposes destructiveHint on plur_packs_uninstall and plur_tensions_purge directly', async () => {
      const { tools } = await client.listTools()
      const uninstall = tools.find((t) => t.name === 'plur_packs_uninstall')
      const purge = tools.find((t) => t.name === 'plur_tensions_purge')
      expect(uninstall?.annotations?.destructiveHint).toBe(true)
      expect(purge?.annotations?.destructiveHint).toBe(true)
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

    // Audit fix (evaluator review, iteration 2, 2026-07-09): the
    // plur://guide resource's cursor-profile note used to hardcode a SECOND
    // copy of the core tool list, independent of getToolDefinitions('cursor')
    // — this proves the guide's redirect note actually lists every real
    // top-level tool this profile exposes, not a stale hand-typed copy.
    it('plur://guide names every actual cursor-profile top-level tool in its redirect note', async () => {
      const { tools } = await client.listTools()
      const coreNames = tools.map((t) => t.name).filter((n) => n !== 'plur_admin')

      const { contents } = await client.readResource({ uri: 'plur://guide' })
      const text = (contents as any)[0].text as string

      expect(text).toContain('plur_admin')
      for (const name of coreNames) {
        expect(text).toContain(name)
      }
    })
  })
})
