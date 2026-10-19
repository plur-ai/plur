/**
 * Gate review of #1663, structural change 2: every public async method of
 * Plur captures the folder binding when it is called, and keeps it to its
 * end. A rebind while the call waits (the public API; MCP serializes its own
 * calls) cannot change what the call sees or writes.
 *
 * Each case starts the call in a remote-only folder and rebinds the same
 * instance to an ordinary folder before awaiting it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, RemoteOnlyWriteError } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'
import { backgroundPushesSettled } from './helpers/background-pushes.js'

const TOKEN = 'binding-capture-token'
const TEAM = 'group:acme/client'
let server: StubServer
let url: string
let base: string, home: string, root: string, work: string, plain: string
let prevHome: string | undefined

beforeAll(async () => { server = new StubServer(TOKEN); url = (await server.start()).url })
afterAll(async () => { await server.stop() })
beforeEach(() => {
  server.reset()
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-ro-capture-')))
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

async function personal(statement: string) {
  return await new Plur({ path: root }).learn(statement, { scope: 'global' })
}

describe('a rebind mid-call does not change what a remote-only call sees', () => {
  it('getById', async () => {
    const p = await personal('my own note PERSONALGETBYID')
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    const call = plur.getById(p.id)
    plur.bindFolder(plain)
    expect(JSON.stringify(await call)).not.toContain('PERSONALGETBYID')
  })

  it('injectHybrid', async () => {
    await personal('always see the dentist PERSONALINJECT on Tuesday')
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    const call = plur.injectHybrid('dentist PERSONALINJECT Tuesday')
    plur.bindFolder(plain)
    expect(JSON.stringify(await call)).not.toContain('PERSONALINJECT')
  })

  it('updateEngramAsync', async () => {
    const p = await personal('my own note PERSONALUPDATE')
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    const call = plur.updateEngramAsync({ ...p, statement: 'changed from the client folder CLIENTUPDATE' })
    plur.bindFolder(plain)
    await expect(call).rejects.toBeInstanceOf(RemoteOnlyWriteError)
    expect(JSON.stringify(rows())).not.toContain('CLIENTUPDATE')
  })

  it('ingest', async () => {
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    const call = plur.ingest('Always run the client integration checks INGESTONE before merging.\nNever deploy the client app INGESTTWO on a Friday.')
    plur.bindFolder(plain)
    await call.catch(() => null)
    await backgroundPushesSettled(root).catch(() => {})
    const permanent = rows().filter(r => !r.structured_data?._outbox)
    expect(JSON.stringify(permanent)).not.toContain('INGESTONE')
    expect(JSON.stringify(permanent)).not.toContain('INGESTTWO')
  })
})

describe('the capture never re-enters the public method', () => {
  it('a spy on learnRouted counts one call', async () => {
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    let calls = 0
    const orig = plur.learnRouted.bind(plur)
    ;(plur as any).learnRouted = (...a: unknown[]) => { calls++; return (orig as any)(...a) }
    await plur.learnRouted('the client release is tagged weekly', { type: 'procedural' })
    expect(calls).toBe(1)
  })
})

describe('GLM round 14 on #1663: every public method, sync or async, is behind the capture', () => {
  it('each public prototype method carries the capture wrapper', async () => {
    const { BINDING_CAPTURED } = await import('../src/index.js') as any
    expect(typeof BINDING_CAPTURED).toBe('symbol')
    const missing = Object.getOwnPropertyNames(Plur.prototype).filter(n => {
      if (n === 'constructor' || n.startsWith('_')) return false
      const d = Object.getOwnPropertyDescriptor(Plur.prototype, n)
      return !!d && typeof d.value === 'function' && !(d.value as any)[BINDING_CAPTURED]
    })
    expect(missing).toEqual([])
  })

  it('the folder-map check names remote-only among the valid modes', async () => {
    const { checkFolderMapText } = await import('../src/folder-map-check.js')
    const report = JSON.stringify(checkFolderMapText('version: 1\nfolders:\n  - path: /work/client\n    plur: remote-on1\n'))
    expect(report).toContain('remote-only')
  })
})
