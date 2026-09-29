import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

/**
 * #1264 — `plur_learn` must say where the engram went. A shared scope with no
 * matching url store used to come back as a bare `decision: "ADD"` while the
 * engram never left the machine.
 */
const TEAM = 'group:example/eng'

describe('plur_learn reports delivery (#1264)', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  const tools = getToolDefinitions('full')
  const learn = (plur: Plur, args: Record<string, unknown>) =>
    tools.find(t => t.name === 'plur_learn')!.handler(args, plur) as Promise<Record<string, unknown>>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-mcp-delivery-'))
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  it('a shared scope with no matching store reports local and warns, naming the scope', async () => {
    const plur = new Plur({ path: dir })
    const r = await learn(plur, { statement: 'team fact with nowhere to go', scope: TEAM })
    expect(r.delivery).toBe('local')
    expect(String(r.delivery_warning)).toContain(TEAM)
    expect(String(r.warning)).toContain(TEAM)
  })

  it('F8: a save absorbed into another team scope warns about the scope asked for', async () => {
    const plur = new Plur({ path: dir })
    await plur.learn('canary before every deploy', { scope: TEAM })
    const r = await learn(plur, { statement: 'canary before every deploy', scope: 'group:example/ops' })
    if (r.scope !== 'group:example/ops') {
      expect(r.delivery).toBe('local')
      expect(String(r.delivery_warning)).toContain('group:example/ops')
    }
  })

  it('a personal scope reports local with no delivery warning', async () => {
    const plur = new Plur({ path: dir })
    const r = await learn(plur, { statement: 'my own preference', scope: 'global' })
    expect(r.delivery).toBe('local')
    expect(r.delivery_warning).toBeUndefined()
  })

  it('a matching reachable store reports remote', async () => {
    writeFileSync(join(dir, 'config.yaml'),
      `index: false\nstores:\n  - url: https://store.example.test/sse\n    token: t\n    scope: ${TEAM}\n    shared: true\n    readonly: false\n`)
    globalThis.fetch = vi.fn(async (_u: string, init?: { method?: string }) => (
      (init?.method ?? 'GET') === 'POST'
        ? ({ ok: true, status: 201, json: async () => ({ id: 'ENG-2026-09-28-901' }), text: async () => '' } as Response)
        : ({ ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as Response)
    )) as any
    const plur = new Plur({ path: dir })
    const r = await learn(plur, { statement: 'team fact that reaches the store', scope: TEAM })
    expect(r.delivery).toBe('remote')
    expect(r.delivery_warning).toBeUndefined()
  })

  it('a failed push reports outbox', async () => {
    writeFileSync(join(dir, 'config.yaml'),
      `index: false\nstores:\n  - url: https://store.example.test/sse\n    token: t\n    scope: ${TEAM}\n    shared: true\n    readonly: false\n`)
    globalThis.fetch = vi.fn(async (_u: string, init?: { method?: string }) => (
      (init?.method ?? 'GET') === 'POST'
        ? { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' }
        : { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' }
    )) as any
    const plur = new Plur({ path: dir })
    const r = await learn(plur, { statement: 'team fact queued for retry', scope: TEAM })
    expect(r.delivery).toBe('outbox')
    expect(r.outbox).toBe(true)
  })
})
