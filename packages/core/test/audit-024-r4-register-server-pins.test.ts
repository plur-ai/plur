/**
 * 0.24 review, round 4: signing in to a company server (`plur login`,
 * registerEnterpriseServer) adds a store whose pinned engrams load into
 * every session. Under `pinning.agents: request` or `deny` a caller the pin
 * policy restricts may not add a new server entry or a new scope to one;
 * a new key for an entry that already serves the same scopes (a token
 * refresh) adds no source and stays allowed, as addStore's rotation does.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'

const URL_ = 'https://plur.example.test'
const ALICE = 'user:example:alice'
const BOB = 'user:example:bob'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function setup(agents: 'allow' | 'request' | 'deny'): string {
  const dir = mkdtempSync(join(tmpdir(), 'plur-r4-login-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'config.yaml'), `embeddings:\n  enabled: false\nindex: false\npinning:\n  agents: ${agents}\n`)
  return dir
}
const open = (dir: string, actor?: 'owner' | 'agent') => new Plur({ path: dir, autoDiscover: false, ...(actor ? { actor } : {}) })
const config = (dir: string) => readFileSync(join(dir, 'config.yaml'), 'utf8')

describe('round 4: registerEnterpriseServer follows the store-registration pin policy', () => {
  for (const agents of ['request', 'deny'] as const) {
    it(`${agents}: an agent cannot add a new server entry, and config.yaml is untouched`, async () => {
      const dir = setup(agents)
      const before = config(dir)
      await expect(open(dir, 'agent').registerEnterpriseServer(URL_, { token: 'k1', personalScope: ALICE }))
        .rejects.toMatchObject({ code: 'pin_denied' })
      await expect(open(dir).registerEnterpriseServer(URL_, { token: 'k1', personalScope: ALICE }))
        .rejects.toMatchObject({ code: 'pin_denied' })
      expect(config(dir)).toBe(before)
    })

    it(`${agents}: the owner adds it; an agent may refresh its key but not add a scope to it`, async () => {
      const dir = setup(agents)
      expect((await open(dir, 'owner').registerEnterpriseServer(URL_, { token: 'k1', personalScope: ALICE })).status).toBe('added')
      const refreshed = await open(dir, 'agent').registerEnterpriseServer(URL_, { token: 'k2', personalScope: ALICE })
      expect(refreshed.status).toBe('updated')
      expect(config(dir)).toContain('k2')
      const before = config(dir)
      await expect(open(dir, 'agent').registerEnterpriseServer(URL_, { token: 'k3', personalScope: BOB }))
        .rejects.toMatchObject({ code: 'pin_denied' })
      expect(config(dir)).toBe(before)
    })
  }

  it('allow (default): an agent adds a server entry as before', async () => {
    const dir = setup('allow')
    expect((await open(dir, 'agent').registerEnterpriseServer(URL_, { token: 'k1', personalScope: ALICE })).status).toBe('added')
  })
})
