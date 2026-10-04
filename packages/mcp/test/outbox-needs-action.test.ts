/**
 * #1299: a queued write that can never succeed reaches the agent.
 *
 * Before this, a write the store refused with 403 on every attempt stayed in
 * the outbox for days and `plur_session_start` said nothing. Now the session
 * start result carries the count, scope, reason and next step, and so do
 * `plur_status` and `plur_outbox`. A write that failed on the network is still
 * just queued — no alarm.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'
import { StubServer } from '../../core/test/helpers/stub-server.js'

const TOKEN = 'mcp-needs-action-token'
const SCOPE = 'group:example/eng'

let server: StubServer
let baseUrl: string

beforeAll(async () => {
  server = new StubServer(TOKEN)
  baseUrl = (await server.start()).url
})
afterAll(async () => { await server.stop() })

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!(await pred())) {
    if (Date.now() > until) throw new Error('waitFor timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('outbox needs_action reaches the MCP caller (#1299)', () => {
  let dir: string
  let plur: Plur
  const tools = getToolDefinitions('full')
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.handler(args, plur) as Promise<Record<string, any>>
  }

  beforeEach(async () => {
    server.reset()
    server.setMe({ scopes: [SCOPE] })
    dir = mkdtempSync(join(tmpdir(), 'plur-mcp-needs-action-'))
    // JSON is valid YAML (this package has no js-yaml devDependency).
    writeFileSync(join(dir, 'config.yaml'), JSON.stringify({
      index: false,
      embeddings: { enabled: false },
      stores: [{ url: baseUrl, token: TOKEN, scope: SCOPE, shared: true, readonly: false }],
    }))
    plur = new Plur({ path: dir })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  async function queue(status: number, body: string, statement: string): Promise<void> {
    server.appendErrorResponse = { status, body }
    const e = await plur.learnRouted(statement, { scope: SCOPE, type: 'behavioral' })
    await waitFor(async () => (await plur.listOutbox()).some(x => x.id === e.id && x.attempt_count >= 1))
  }

  it('plur_session_start reports a 403-refused write: count, scope, reason, next step', async () => {
    await queue(403, `Cannot write to scope ${SCOPE}`, 'refused team fact')
    // The store keeps refusing; session start's own flush must not hide it.
    const res = await call('plur_session_start', { task: 'anything' })
    expect(res.outbox_needs_action).toMatchObject({ count: 1 })
    expect(res.outbox_needs_action.scopes[0]).toMatchObject({ scope: SCOPE, count: 1 })
    expect(res.outbox_needs_action.scopes[0].reason).toMatch(/403/)
    expect(res.outbox_needs_action.scopes[0].next_step).toMatch(/plur rescope/)
    expect(String(res.guide)).toMatch(/will not deliver/)
    // Still queued — nothing was dropped.
    expect(await plur.outboxCount()).toBe(1)
  })

  it('a network-style failure does not raise needs_action at session start', async () => {
    await queue(503, 'down for the test', 'transient team fact')
    const res = await call('plur_session_start', { task: 'anything' })
    expect(res.outbox_needs_action).toBeUndefined()
    expect(String(res.guide)).not.toMatch(/will not deliver/)
  })

  it('plur_status and plur_outbox carry the classification', async () => {
    await queue(403, `Cannot write to scope ${SCOPE}`, 'refused team fact')
    const status = await call('plur_status')
    expect(status.outbox_needs_action).toBe(1)
    expect(status.outbox_attention?.[0]).toMatchObject({ scope: SCOPE, count: 1 })

    const outbox = await call('plur_outbox')
    expect(outbox.needs_action).toBe(1)
    expect(outbox.retrying).toBe(0)
    expect(outbox.entries[0]).toMatchObject({ state: 'needs_action', last_status: 403 })
  })

  it('plur_outbox flush:true retries a needs_action entry despite the back-off', async () => {
    await queue(403, `Cannot write to scope ${SCOPE}`, 'refused team fact')
    server.appendErrorResponse = null
    server.appendCalls = 0
    const res = await call('plur_outbox', { flush: true })
    expect(server.appendCalls).toBe(1)
    expect(res.flushed).toBe(1)
    expect(await plur.outboxCount()).toBe(0)
  })
})
