/**
 * Follow-up to decision D1 (round 2, R2-CoreA): `listOutbox()` shows pending
 * "retire on remote" entries. D1 queues a remote DELETE on a retired row
 * (`structured_data._retireRemote`); flushOutbox retries it, but the inspector
 * listed only `_outbox` pushes on non-retired rows — so a stuck retirement was
 * invisible and `plur outbox` / `plur_outbox` said "empty". `outboxCount()`
 * agrees with the list. No network.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

describe('listOutbox includes queued remote retirements', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-r2corea-obx-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a retired row carrying _retireRemote is listed as a retire entry and counted', async () => {
    const seed = new Plur({ path: join(dir, 'seed') })
    const e = await seed.learn('A team fact that was forgotten mid-push', { scope: 'global' })
    const row: any = { ...(await seed.getById(e.id)) }
    row.status = 'retired'
    row.structured_data = {
      _retireRemote: {
        server_id: 'SRV-9', target_url: 'https://plur.example.com/sse', target_scope: 'group:acme/team',
        queued_at: new Date().toISOString(), last_attempt: '', attempt_count: 2, last_error: 'HTTP 500',
      },
    }
    writeFileSync(join(dir, 'engrams.yaml'), yaml.dump({ engrams: [row] }))
    const plur = new Plur({ path: dir })
    const entries = await plur.listOutbox()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      id: e.id, kind: 'retire', target_scope: 'group:acme/team', attempt_count: 2, last_error: 'HTTP 500',
    })
    expect(JSON.stringify(entries)).not.toContain('plur.example.com')
    expect(await plur.outboxCount()).toBe(1)
  })
})
