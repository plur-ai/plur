/**
 * 0.24 review, round 2: registering scopes found by discovery
 * (`registerDiscoveredScopes`, `registerScope`) adds new stores just as
 * `addStore` does, and a store's pinned rows load into every session. Under
 * `pinning.agents: request` or `deny` a caller the pin policy restricts is
 * refused (pin_denied) and config.yaml is untouched; the owner still
 * registers. Under `allow` nothing changes.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'audit-024-r2-discovery-token'
const BASE = 'group:example/eng'
const OTHER = 'group:example/comms'
let server: StubServer
let baseUrl: string

beforeAll(async () => {
  server = new StubServer(TOKEN)
  baseUrl = (await server.start()).url
})
afterAll(async () => { await server.stop() })

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function setup(agents: 'allow' | 'request' | 'deny'): string {
  server.reset()
  server.setMe({ username: 'tester', org_id: 'example', role: 'developer', scopes: [BASE, OTHER] })
  const dir = mkdtempSync(join(tmpdir(), 'plur-r2-disc-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'config.yaml'), yaml.dump({
    embeddings: { enabled: false },
    index: false,
    pinning: { agents },
    stores: [{ url: baseUrl, token: TOKEN, scope: BASE, shared: true, readonly: false }],
  }, { lineWidth: 120, noRefs: true }))
  return dir
}

const scopesIn = (dir: string) =>
  (((yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as { stores?: Array<{ scope?: string }> }).stores) ?? [])
    .map(s => s.scope)

describe('round 2: discovery registration follows the store-registration pin policy', () => {
  for (const agents of ['request', 'deny'] as const) {
    it(`${agents}: an agent's registerDiscoveredScopes is refused and config.yaml is untouched`, async () => {
      const dir = setup(agents)
      const before = readFileSync(join(dir, 'config.yaml'), 'utf8')
      const plur = new Plur({ path: dir, autoDiscover: false, actor: 'agent' })
      await expect(plur.registerDiscoveredScopes()).rejects.toMatchObject({ code: 'pin_denied' })
      expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).toBe(before)
      expect(scopesIn(dir)).not.toContain(OTHER)
    })

    it(`${agents}: an agent's registerScope is refused, an absent actor too`, async () => {
      const dir = setup(agents)
      const before = readFileSync(join(dir, 'config.yaml'), 'utf8')
      await expect(new Plur({ path: dir, autoDiscover: false, actor: 'agent' }).registerScope(OTHER))
        .rejects.toMatchObject({ code: 'pin_denied' })
      await expect(new Plur({ path: dir, autoDiscover: false }).registerScope(OTHER))
        .rejects.toMatchObject({ code: 'pin_denied' })
      expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).toBe(before)
    })

    it(`${agents}: the owner registers discovered scopes`, async () => {
      const dir = setup(agents)
      const owner = new Plur({ path: dir, autoDiscover: false, actor: 'owner' })
      const [result] = await owner.registerDiscoveredScopes()
      expect(result.added).toEqual([OTHER])
      expect(scopesIn(dir)).toContain(OTHER)
    })

    it(`${agents}: the owner registers one scope`, async () => {
      const dir = setup(agents)
      const owner = new Plur({ path: dir, autoDiscover: false, actor: 'owner' })
      expect((await owner.registerScope(OTHER)).status).toBe('added')
      expect(scopesIn(dir)).toContain(OTHER)
    })
  }

  it('allow (default): an agent registers discovered scopes as before', async () => {
    const dir = setup('allow')
    const plur = new Plur({ path: dir, autoDiscover: false, actor: 'agent' })
    const [result] = await plur.registerDiscoveredScopes()
    expect(result.added).toEqual([OTHER])
    expect(scopesIn(dir)).toContain(OTHER)
  })
})
