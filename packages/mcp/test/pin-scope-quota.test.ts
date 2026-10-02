/**
 * #1532 review F6: `plur_pin` with `scope` checks the pinned quota against the
 * engram that scope holds, not against a local engram that happens to share
 * its bare id.
 *
 * Setup: a short LOCAL engram and a long TEAM engram with the same bare id,
 * and a pinned quota that fits the short one but not the long one. Pinning
 * the team engram must be refused for its own cost; pinning the local one
 * must fit.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { getToolDefinitions } from '../src/tools.js'

const TEAM = 'group:test'
const TOKEN = 'pin-scope-token'
const pin = getToolDefinitions('full').find(t => t.name === 'plur_pin')!

describe('plur_pin with scope costs the engram that scope holds (#1532 F6)', () => {
  let stub: StubServer
  let url: string
  let dir: string

  beforeAll(async () => { stub = new StubServer(TOKEN); url = (await stub.start()).url })
  afterAll(async () => { await stub.stop() })
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-pin-scope-')); stub.reset() })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  async function setup(): Promise<{ plur: Plur; id: string }> {
    // 200-token budget × 0.5 = a 100-token pinned quota.
    const base = 'embeddings:\n  enabled: false\ninjection_budget: 200\n'
    writeFileSync(join(dir, 'config.yaml'), base)
    const local = new Plur({ path: dir })
    await local.ready()
    const id = (await local.learn('short local rule', { scope: 'global' })).id
    stub.seedEngram({
      id, scope: TEAM, status: 'active',
      data: { statement: 'a long team rule that will not fit the pinned quota '.repeat(20), type: 'behavioral' },
    })
    writeFileSync(join(dir, 'config.yaml'), base + `stores:\n  - url: "${url}"\n    token: "${TOKEN}"\n    scope: "${TEAM}"\n`)
    const plur = new Plur({ path: dir })
    await plur.ready()
    return { plur, id }
  }

  it('refuses the team pin for the team engram\'s own cost', async () => {
    const { plur, id } = await setup()
    const res = await pin.handler({ id, pinned: true, scope: TEAM }, plur) as any
    expect(res.error).toBe('pinned_quota_exceeded')
    expect(stub.getEngram(id)?.data.pinned).toBeUndefined()
  }, 60_000)

  it('pins the local engram with scope "primary" when it fits', async () => {
    const { plur, id } = await setup()
    const res = await pin.handler({ id, pinned: true, scope: 'primary' }, plur) as any
    expect(res.pinned).toBe(true)
    expect(res.statement).toBe('short local rule')
  }, 60_000)
})
