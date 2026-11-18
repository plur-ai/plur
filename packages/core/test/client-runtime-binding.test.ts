/**
 * The calling client's runtime scope (#1470) must not capture the folder
 * binding. The MCP server enters the scope before a tool handler refreshes its
 * workspace roots; a write inside the scope must follow the binding in effect
 * when the write itself starts, not the one in effect when the scope was
 * entered. Entering the scope is therefore not a public method of a Plur
 * instance (every one of those captures the binding, see
 * remote-only-binding-capture.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'
import { backgroundPushesSettled } from './helpers/background-pushes.js'

const TOKEN = 'client-runtime-binding-token'
const TEAM = 'group:acme/client'
let server: StubServer
let url: string
let base: string, home: string, root: string, work: string, plain: string
let prevHome: string | undefined

beforeAll(async () => { server = new StubServer(TOKEN); url = (await server.start()).url })
afterAll(async () => { await server.stop() })
beforeEach(() => {
  server.reset()
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-client-runtime-binding-')))
  home = join(base, 'home'); root = join(home, '.plur'); work = join(home, 'client'); plain = join(home, 'plain')
  for (const d of [root, work, plain]) mkdirSync(d, { recursive: true })
  prevHome = process.env.HOME; process.env.HOME = home
  writeFileSync(join(root, 'config.yaml'), yaml.dump({
    index: false, embeddings: { enabled: false },
    stores: [{ url, token: TOKEN, scope: TEAM, shared: true, readonly: false }],
  }))
  writeFileSync(join(root, 'folders.yaml'), yaml.dump({ version: 1, folders: [{ path: work, plur: 'remote-only', scope: TEAM }] }))
})
afterEach(async () => {
  await backgroundPushesSettled(root).catch(() => {})
  process.env.HOME = prevHome
  rmSync(base, { recursive: true, force: true })
})

const rows = (): any[] => {
  const f = join(root, 'engrams.yaml')
  return existsSync(f) ? (((yaml.load(readFileSync(f, 'utf8')) as any)?.engrams) ?? []) : []
}

const CLIENT = { name: 'test-client', version: '1.0.0' }

describe('the client runtime scope does not capture the folder binding (#1470)', () => {
  it('a personal write after a rebind to an ordinary folder stays local', async () => {
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    const engram = await Plur.withRuntime(plur, CLIENT, async () => {
      // What the MCP handler does when it refreshes roots after the scope opens.
      plur.bindFolder(plain)
      return await plur.learnRouted('my own note PERSONALAFTERREBIND', { type: 'behavioral' })
    })
    expect(server.appendCountFor('my own note PERSONALAFTERREBIND')).toBe(0)
    const local = rows().find(r => r.id === engram.id)
    expect(local?.statement).toContain('PERSONALAFTERREBIND')
    expect(local?.attribution?.runtime).toEqual(CLIENT)
  })

  it('a write after a rebind to a remote-only folder goes to the team store only', async () => {
    const plur = new Plur({ path: root })
    plur.bindFolder(plain)
    await Plur.withRuntime(plur, CLIENT, async () => {
      plur.bindFolder(work)
      return await plur.learnRouted('the client release is tagged weekly TEAMAFTERREBIND', { type: 'procedural' })
    })
    expect(server.appendCountFor('the client release is tagged weekly TEAMAFTERREBIND')).toBe(1)
    expect((server.lastAppendBody as any)?.attribution?.runtime).toEqual(CLIENT)
    expect(JSON.stringify(rows().filter(r => !r.structured_data?._outbox))).not.toContain('TEAMAFTERREBIND')
  })

  it('is not a method of a Plur instance', () => {
    expect(Object.getOwnPropertyNames(Plur.prototype)).not.toContain('withRuntime')
  })
})
