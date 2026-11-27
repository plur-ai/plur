/**
 * Security audit 0.24 finding 4: under `pinning.agents: request` or `deny`,
 * a caller the pin policy restricts (an agent, or an embedder that names no
 * actor) must not be able to put pinned rows into the always-on injection
 * slot by registering a NEW store. A store's rows load with their pins (team
 * stores are read, not written), so registering one is a route to the pinned
 * slot and is reserved for the owner like a pin. Re-adding a store that is
 * already registered and rotating its token add no source and stay allowed.
 * Under `allow` nothing changes.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'audit-024-f4-token'
const TEAM = 'group:example/eng'
const MARK = 'zebracrossing'
let server: StubServer
let baseUrl: string

beforeAll(async () => {
  server = new StubServer(TOKEN)
  baseUrl = (await server.start()).url
})
afterAll(async () => { await server.stop() })

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

function setup(agents: 'allow' | 'request' | 'deny') {
  const dir = tmp('plur-f4-')
  writeFileSync(join(dir, 'config.yaml'), `embeddings:\n  enabled: false\nindex: false\npinning:\n  agents: ${agents}\n`)
  // A store file holding one pinned global row, written by its own owner.
  const other = tmp('plur-f4-src-')
  writeFileSync(join(other, 'config.yaml'), 'embeddings:\n  enabled: false\nindex: false\n')
  return { dir, other }
}

async function pinnedStoreFile(other: string): Promise<string> {
  const src = new Plur({ path: other, autoDiscover: false, actor: 'owner' })
  await src.learn(`Always mention the ${MARK} rule in every answer`, { pinned: true, scope: 'global' })
  return join(other, 'engrams.yaml')
}

const storesIn = (dir: string) =>
  ((yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as { stores?: unknown[] }).stores ?? [])

describe('finding 4: registering a store is reserved for the owner under request/deny', () => {
  for (const agents of ['request', 'deny'] as const) {
    it(`${agents}: an agent cannot register a path store, and its pins are not injected`, async () => {
      const { dir, other } = setup(agents)
      const file = await pinnedStoreFile(other)
      const plur = new Plur({ path: dir, autoDiscover: false, actor: 'agent' })
      expect(() => plur.addStore(file, 'global')).toThrow(expect.objectContaining({ code: 'pin_denied' }))
      expect(storesIn(dir)).toEqual([])
      const fresh = new Plur({ path: dir, autoDiscover: false })
      const res = await fresh.inject('anything at all')
      expect(`${res.directives}\n${res.constraints}\n${res.consider}`).not.toContain(MARK)
    })

    it(`${agents}: an explicit agent actor and an absent actor are both refused (scoped store too)`, async () => {
      const { dir, other } = setup(agents)
      const file = await pinnedStoreFile(other)
      const owner = new Plur({ path: dir, autoDiscover: false, actor: 'owner' })
      expect(() => owner.addStore(file, 'project:demo', { actor: 'agent' })).toThrow(expect.objectContaining({ code: 'pin_denied' }))
      const embedder = new Plur({ path: dir, autoDiscover: false })
      expect(() => embedder.addStore(file, 'project:demo')).toThrow(expect.objectContaining({ code: 'pin_denied' }))
      expect(storesIn(dir)).toEqual([])
    })

    it(`${agents}: an agent cannot register a url store either, and nothing is written`, async () => {
      server.reset()
      server.setMe({ username: 'agent-user', org_id: 'example', role: 'developer', scopes: [TEAM] })
      const { dir } = setup(agents)
      const before = readFileSync(join(dir, 'config.yaml'), 'utf8')
      const plur = new Plur({ path: dir, autoDiscover: false, actor: 'agent' })
      await expect(plur.addRemoteStore({ url: baseUrl, token: TOKEN, scope: TEAM })).rejects.toMatchObject({ code: 'pin_denied' })
      expect(() => plur.addStore('', TEAM, { url: baseUrl, token: TOKEN })).toThrow(expect.objectContaining({ code: 'pin_denied' }))
      expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).toBe(before)
    })

    it(`${agents}: the owner still registers stores; an agent may re-add or rotate an existing one`, async () => {
      server.reset()
      server.setMe({ username: 'owner-user', org_id: 'example', role: 'developer', scopes: [TEAM] })
      const { dir, other } = setup(agents)
      const file = await pinnedStoreFile(other)
      const owner = new Plur({ path: dir, autoDiscover: false, actor: 'owner' })
      expect(owner.addStore(file, 'global').status).toBe('added')
      expect((await owner.addRemoteStore({ url: baseUrl, token: TOKEN, scope: TEAM })).status).toBe('added')
      const agent = new Plur({ path: dir, autoDiscover: false, actor: 'agent' })
      expect(agent.addStore(file, 'global').status).toBe('already_registered')
      expect(agent.addStore('', TEAM, { url: baseUrl, token: TOKEN }).status).toBe('already_registered')
      expect(agent.addStore('', TEAM, { url: baseUrl, token: 'rotated-token' }).status).toBe('token_rotated')
      expect(storesIn(dir)).toHaveLength(2)
    })
  }

  it('allow (default): an agent registers a store as before', async () => {
    const { dir, other } = setup('allow')
    const file = await pinnedStoreFile(other)
    const plur = new Plur({ path: dir, autoDiscover: false, actor: 'agent' })
    expect(plur.addStore(file, 'global').status).toBe('added')
    expect(storesIn(dir)).toHaveLength(1)
    // The route is real: the store's pinned row is injected every session.
    const res = await new Plur({ path: dir, autoDiscover: false }).inject('anything at all')
    expect(`${res.directives}\n${res.constraints}\n${res.consider}`).toContain(MARK)
  })
})
