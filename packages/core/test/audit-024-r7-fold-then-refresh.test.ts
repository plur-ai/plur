/**
 * 0.24 review round 7 (part of #1946): a server entry grows by its own scope
 * refresh, so turning a url into a server entry is an addition even when it
 * folds an existing per-scope entry with the same scopes. Under
 * `pinning.agents: request` or `deny` an agent cannot do it (and so a later
 * refresh adds nothing); the owner can; signing in again to an existing
 * server entry for the same scopes is still not an addition.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { storeAdditions } from '../src/store-additions.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'r7-fold-token'
const ME = 'user:x:alice'
const SECRET = 'group:x/secret'
let server: StubServer
let url: string

beforeAll(async () => { server = new StubServer(TOKEN); url = (await server.start()).url })
afterAll(async () => { await server.stop() })
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function setup(agents: 'allow' | 'request' | 'deny'): string {
  server.reset()
  server.setMe({ username: 'alice', org_id: 'x', role: 'developer', scopes: [ME, SECRET], scopes_status: 'ok', scope_metadata_status: 'ok' })
  const dir = mkdtempSync(join(tmpdir(), 'plur-r7-fold-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'config.yaml'), yaml.dump({
    embeddings: { enabled: false }, index: false, pinning: { agents },
    stores: [{ url, token: TOKEN, scope: ME }],
  }, { lineWidth: 120, noRefs: true }))
  return dir
}
const cfg = (dir: string) => readFileSync(join(dir, 'config.yaml'), 'utf8')
const as = (dir: string, actor: 'owner' | 'agent') => new Plur({ path: dir, autoDiscover: false, actor })

describe('round 7: converting a per-scope entry into a server entry is an addition', () => {
  it('storeAdditions names a url that now has a server entry', () => {
    const before = [{ url, token: 't', scope: ME }]
    const after = [{ url, token: 't', scope: ME, scopes: [ME], enterprise: {} }]
    expect(storeAdditions(before, after).newServerEntries).toEqual([expect.stringContaining('127.0.0.1')])
    // Re-saving or re-keying an existing server entry is not.
    expect(storeAdditions(after, [{ ...after[0], token: 't2' }]).newServerEntries).toEqual([])
  })

  for (const agents of ['request', 'deny'] as const) {
    it(`${agents}: an agent cannot fold the owner's entry into a server entry, and a later refresh adds nothing`, async () => {
      const dir = setup(agents)
      const before = cfg(dir)
      await expect(as(dir, 'agent').registerEnterpriseServer(url, { token: TOKEN, personalScope: ME }))
        .rejects.toMatchObject({ code: 'pin_denied' })
      expect(cfg(dir)).toBe(before)
      await as(dir, 'agent').refreshServerScopes()
      expect(cfg(dir)).not.toContain(SECRET)
    })
  }

  it('deny: the owner folds it, and the refresh then adds the scopes the server grants', async () => {
    const dir = setup('deny')
    expect((await as(dir, 'owner').registerEnterpriseServer(url, { token: TOKEN, personalScope: ME })).status).toBe('added')
    await as(dir, 'agent').refreshServerScopes()
    expect(cfg(dir)).toContain(SECRET)
  })

  it('deny: an agent may sign in again to an existing server entry for the same scopes', async () => {
    const dir = setup('deny')
    await as(dir, 'owner').registerEnterpriseServer(url, { token: TOKEN, personalScope: ME })
    expect((await as(dir, 'agent').registerEnterpriseServer(url, { token: 'r7-new-key', personalScope: ME })).status).toBe('updated')
  })
})
