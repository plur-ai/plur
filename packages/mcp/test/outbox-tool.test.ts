/**
 * #667 — `plur_outbox`, the supported way to see and retry queued team writes.
 *
 * Before this, queued writes were reachable only by reading
 * `structured_data._outbox` out of `engrams.yaml` by hand. `flushOutbox()` and
 * `outboxCount()` existed on core and were exposed nowhere.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

const REMOTE = 'https://plur.example.com/sse'
const SCOPE = 'group:acme/team'
const TOKEN = 'super-secret-token'

describe('plur_outbox (#667)', () => {
  let dir: string
  let plur: Plur
  let originalFetch: typeof globalThis.fetch
  const tools = getToolDefinitions('full')

  const call = (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.handler(args, plur)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-outbox-tool-'))
    originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => { throw new Error('fetch failed') }) as never
    // JSON is valid YAML — avoids a js-yaml devDependency in this package,
    // which `@plur-ai/mcp` does not declare. It resolves locally through pnpm
    // hoisting and fails under CI's strict install, so the convention here
    // (see session-scope-tool.test.ts) is to write config as JSON.
    writeFileSync(join(dir, 'config.yaml'), JSON.stringify({
      stores: [{ url: REMOTE, token: TOKEN, scope: SCOPE, shared: true, readonly: false }],
      index: false,
    }))
    plur = new Plur({ path: dir })
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  async function queue(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await plur.learn(`queued team fact number ${i}`, { scope: SCOPE, type: 'behavioral' })
    }
    await new Promise(r => setTimeout(r, 60))
  }

  it('is registered in the full profile and declares a flush flag', () => {
    const tool = tools.find(t => t.name === 'plur_outbox')
    expect(tool, 'the tool the issue exists to add').toBeDefined()
    const schema = tool!.inputSchema as { properties?: Record<string, unknown> }
    expect(schema.properties).toHaveProperty('flush')
  })

  it('reads without flushing — the default must not mutate', async () => {
    await queue(2)
    const res = await call('plur_outbox') as { pending: number; entries: unknown[]; flushed?: number }
    expect(res.pending).toBe(2)
    expect(res.entries).toHaveLength(2)
    expect(res.flushed, 'a plain read must not report a flush').toBeUndefined()
    expect(await plur.outboxCount(), 'the read consumed the queue').toBe(2)
  })

  it('never exposes the token or the target URL', async () => {
    await queue(1)
    const serialized = JSON.stringify(await call('plur_outbox'))
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain('plur.example.com')
  })

  it('surfaces target_scope and attempt_count — the fields you act on', async () => {
    await queue(1)
    const res = await call('plur_outbox') as { entries: Array<Record<string, unknown>> }
    expect(res.entries[0]).toMatchObject({ target_scope: SCOPE })
    expect(res.entries[0]).toHaveProperty('attempt_count')
    expect(res.entries[0]).toHaveProperty('age_days')
  })

  it('flush:true reports what it attempted, not just what is left', async () => {
    // After a successful flush the entries are gone, so a tool that read the
    // outbox AFTER flushing would report an empty queue and tell the caller
    // nothing about what moved. `attempted` is the pre-flush snapshot.
    await queue(2)
    const res = await call('plur_outbox', { flush: true }) as {
      flushed: number; failed: number; pending: number; attempted: unknown[]
    }
    expect(res.attempted, 'the flush reported nothing about what it tried').toHaveLength(2)
    // Deliberately NOT asserting `flushed + failed === 2`. The queueing writes
    // already failed against this host, so the #785 breaker may be open by the
    // time the flush runs — and an open breaker attempts NOTHING, reporting
    // flushed 0 / failed 0. That is correct, and it is precisely why
    // session_start now reports the PENDING count rather than
    // `outbox_result.failed`: the two diverge exactly here.
    expect(res.flushed).toBe(0)
    expect(res.pending, 'a skipped flush must leave the queue intact').toBe(2)
  })

  it('reports an empty outbox as empty rather than erroring', async () => {
    await plur.learn('a purely local fact', { scope: 'global', type: 'behavioral' })
    const res = await call('plur_outbox') as { pending: number; entries: unknown[] }
    expect(res).toMatchObject({ pending: 0 })
    expect(res.entries).toEqual([])
  })

  it('plur_sync says that it flushes the outbox', () => {
    // The flush was undocumented, so the one command that would have fixed a
    // stuck queue did not say it fixed anything.
    const sync = tools.find(t => t.name === 'plur_sync')!
    expect(sync.description.toLowerCase()).toContain('outbox')
  })

  it('plur_status reports the pending count', async () => {
    await queue(3)
    const status = await call('plur_status') as { outbox_count: number }
    expect(status.outbox_count).toBe(3)
  })
})
