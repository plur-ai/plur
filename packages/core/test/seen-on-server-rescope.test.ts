/**
 * #1532 re-audit 2, S6: a rescope that finds identical content already cached
 * from the team store ("deduped") hands back that row's server id as
 * `new_id`. That id is now this machine's knowledge of a server engram, so it
 * is recorded as seen on the server — otherwise, after a restart and a 401, a
 * forget of an unrelated local engram with that bare id is not refused.
 */
import { it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '../src/index.js'
import { seenOnServer } from '../src/seen-on-server.js'
import { computeContentHash } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

it('S6: the deduped rescope branch records the server id it returns', async () => {
  const stub = new StubServer('t')
  const { url } = await stub.start()
  const dir = mkdtempSync(join(tmpdir(), 'plur-rescope-dedup-'))
  try {
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    const p0 = new Plur({ path: dir }); await p0.ready()
    const statement = 'Canary deploys go to one region before the rest'
    const id = (await p0.learn(statement, { scope: 'global' })).id
    stub.seedEngram({ id: 'ENG-2026-01-01-042', scope: 'group:test', status: 'active', data: { statement, type: 'behavioral', content_hash: computeContentHash(statement) } })
    writeFileSync(join(dir, 'config.yaml'), `embeddings:\n  enabled: false\nstores:\n  - url: "${url}"\n    token: "t"\n    scope: "group:test"\n`)
    const p = new Plur({ path: dir }); await p.ready()
    await (p as any)._getRemoteDriver({ url, token: 't', scope: 'group:test' }).load() // warm cache (MCP)
    const res = await p.rescope(id, 'group:test', { keep_local: true })
    expect(res.results[0].status).toBe('deduped')
    expect(res.results[0].new_id).toBe('ENG-2026-01-01-042')
    expect(seenOnServer(dir, 'ENG-2026-01-01-042')).not.toBeNull()
  } finally {
    await stub.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)
