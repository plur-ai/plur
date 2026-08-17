import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Plur } from '@plur-ai/core'
import { createServer } from '../src/server.js'
import { getToolDefinitions } from '../src/tools.js'

describe('tool profiles', () => {
  it('full profile returns every tool, unfiltered', () => {
    const full = getToolDefinitions('full')
    expect(full.length).toBeGreaterThanOrEqual(39)
    expect(full.some(t => t.name === 'plur_packs_install')).toBe(true)
    expect(full.some(t => t.name === 'plur_admin')).toBe(false)
  })

  it('default (no arg) is lean — not full', () => {
    const lean = getToolDefinitions()
    const full = getToolDefinitions('full')
    expect(lean.length).toBeLessThan(full.length)
    expect(lean.length).toBeLessThanOrEqual(12)
    expect(lean.some(t => t.name === 'plur_admin')).toBe(true)
    expect(lean.some(t => t.name === 'plur_packs_install')).toBe(false)
  })

  it('lean profile stays at or under 12 tools and includes plur_admin', () => {
    const lean = getToolDefinitions('lean')
    expect(lean.length).toBeLessThanOrEqual(12)
    const names = lean.map(t => t.name)
    expect(names).toContain('plur_session_start')
    expect(names).toContain('plur_learn')
    expect(names).toContain('plur_recall_hybrid')
    expect(names).toContain('plur_admin')
    expect(names).toContain('plur_packs_uninstall')
    expect(names).toContain('plur_tensions_purge')
    expect(names).not.toContain('plur_packs_install')
  })

  it('cursor profile is identical to lean', () => {
    const lean = getToolDefinitions('lean')
    const cursor = getToolDefinitions('cursor')
    expect(cursor.map(t => t.name).sort()).toEqual(lean.map(t => t.name).sort())
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
    // plur://guide resource's lean-profile note must list every real top-level
    // tool this profile exposes — not a stale hand-typed copy.
    it('plur://guide names every actual lean-profile top-level tool in its redirect note', async () => {
      const { tools } = await client.listTools()
      const coreNames = tools.map((t) => t.name).filter((n) => n !== 'plur_admin')

      const { contents } = await client.readResource({ uri: 'plur://guide' })
      const text = (contents as any)[0].text as string

      expect(text).toContain('plur_admin')
      for (const name of coreNames) {
        expect(text).toContain(name)
      }
    })

    // --- #625 lean audit (2026-07-24) ---

    it('direct call of a REAL-but-hidden tool returns an actionable plur_admin hint, not a dead end', async () => {
      const result = await client.callTool({ name: 'plur_sync', arguments: {} })
      expect(result.isError).toBe(true)
      const data = JSON.parse((result.content as any)[0].text)
      expect(data.success).toBe(false)
      expect(data.error).toContain('plur_sync')
      expect(data.hint).toContain('plur_admin')
      expect(data.hint).toContain('PLUR_TOOL_PROFILE=full')
    })

    it('a genuinely unknown tool still gets the bare Unknown-tool error (no false hint)', async () => {
      const result = await client.callTool({ name: 'plur_totally_fake', arguments: {} })
      expect(result.isError).toBe(true)
      const data = JSON.parse((result.content as any)[0].text)
      expect(data.error).toContain('Unknown tool')
      expect(data.hint).toBeUndefined()
    })

    it('plur_admin REFUSES to dispatch destructive tools — the annotation-visibility guarantee is enforced', async () => {
      for (const action of ['plur_forget', 'plur_packs_uninstall', 'plur_tensions_purge']) {
        const result = await client.callTool({
          name: 'plur_admin',
          arguments: { action, args: {} },
        })
        expect(result.isError).toBe(true)
        const data = JSON.parse((result.content as any)[0].text)
        expect(data.success).toBe(false)
        expect(data.error).toContain('destructive')
        expect(data.error).toContain(action)
      }
    })

    it('destructive tools still work as DIRECT calls (the sanctioned path)', async () => {
      const result = await client.callTool({ name: 'plur_tensions_purge', arguments: {} })
      expect(result.isError).toBeFalsy()
    })

    it('plur_admin cannot dispatch itself (recursion blocked)', async () => {
      const result = await client.callTool({
        name: 'plur_admin',
        arguments: { action: 'plur_admin', args: { action: 'plur_status' } },
      })
      const data = JSON.parse((result.content as any)[0].text)
      expect(data.success).toBe(false)
      expect(data.error).toContain('Unknown action')
    })

    it('prototype-key action names are rejected as unknown actions', async () => {
      for (const action of ['__proto__', 'constructor', '']) {
        const result = await client.callTool({
          name: 'plur_admin',
          arguments: { action, args: {} },
        })
        const data = JSON.parse((result.content as any)[0].text)
        expect(data.success).toBe(false)
        expect(data.error).toContain('Unknown action')
      }
    })

    it('every advertised admin action dispatches — none is orphaned by a filter regression', { timeout: 120_000 }, async () => {
      // The advertised set = full minus core. Each must reach its handler:
      // any response is acceptable EXCEPT the "Unknown action" dead end
      // (validation errors and handler errors prove reachability).
      const full = getToolDefinitions('full').map((t) => t.name)
      const { tools } = await client.listTools()
      const core = new Set(tools.map((t) => t.name))
      const advertised = full.filter((n) => !core.has(n))
      expect(advertised.length).toBeGreaterThanOrEqual(28)
      for (const action of advertised) {
        const result = await client.callTool({
          name: 'plur_admin',
          arguments: { action, args: {} },
        })
        const text = (result.content as any)[0].text as string
        expect(text, `action ${action} hit the Unknown-action dead end`).not.toContain('Unknown action')
      }
    })

    it('the guide tool count is computed from the full profile, never a stale literal', async () => {
      const { contents } = await client.readResource({ uri: 'plur://guide' })
      const text = (contents as any)[0].text as string
      expect(text).toContain(`all ${getToolDefinitions('full').length} tools`)
    })
  })
})
